"""Drive the whole verification flow against the seeded test database.

Seeds a throwaway fixture with ``seed_test_db.py`` on every run, so the checks
never depend on state left behind by manual testing. Pass a database path to
run against a copy of that file instead.

    backend\\.venv\\Scripts\\python.exe scripts\\verify_test_db.py [some.db]

Checks, in order:
  1. workspace exposes the finished May period (bank + card + settlement)
  2. the completed bank session feeds the "Finished periods" view
  3. uploading the June-July bank statement produces the expected bucket sizes
  4. confirm / create / ignore clears the period and it can be finished
  5. the card statement behaves the same way and links the bank card payments
  6. re-uploading a finished period is rejected with the "all caught up" message
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CLIENT_DATA = ROOT / "data" / "ClientData"

BANK_XLSX = CLIENT_DATA / "Bank Account example.xlsx"
CARD1_XLSX = CLIENT_DATA / "credit card 1 example.xlsx"
CARD2_XLSX = CLIENT_DATA / "credit card 2 example.xlsx"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
BANK_URL = "/api/v1/bank-settings/reconcile/sessions"
CC_URL = "/api/v1/bank-settings/cc-reconcile/sessions"

failures: list[str] = []
checks = 0


def check(label: str, actual, expected) -> None:
    global checks
    checks += 1
    if actual == expected:
        print(f"  ok   {label}: {actual}")
    else:
        print(f"  FAIL {label}: got {actual!r}, expected {expected!r}")
        failures.append(label)


def upload(client, url: str, path: Path):
    with path.open("rb") as handle:
        return client.post(url, files={"file": (path.name, handle, XLSX_MIME)})


def line_counts(session: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for line in session["lines"]:
        status = line.get("status") or "unmatched"
        out[status] = out.get(status, 0) + 1
    return out


def main() -> int:
    work_dir = Path(tempfile.mkdtemp(prefix="simplifai-verify-"))
    work_db = work_dir / "copy.db"

    if len(sys.argv) > 1:
        source = Path(sys.argv[1]).resolve()
        if not source.exists():
            raise SystemExit(f"Database not found: {source}")
        shutil.copy2(source, work_db)
    else:
        # Build the fixture from scratch every run. Pointing at a working
        # database instead would make these checks depend on whatever manual
        # testing left behind.
        seeded = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "seed_test_db.py"),
                "--db",
                str(work_db),
                "--no-backup",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if seeded.returncode != 0:
            print(seeded.stdout)
            print(seeded.stderr)
            raise SystemExit("Could not seed the fixture")

    os.environ["DATABASE_URL"] = "sqlite:///" + str(work_db).replace("\\", "/")

    sys.path.insert(0, str(BACKEND))

    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        print("1. Workspace / finished periods")
        workspace = client.get(
            "/api/v1/bank-settings/verification-workspace"
        )
        check("workspace status", workspace.status_code, 200)
        ws = workspace.json()
        verified_banks = [g for g in ws["bank_groups"] if g["status"] == "verified"]
        check("finished bank periods", len(verified_banks), 1)
        check("finished period has card payment", verified_banks[0]["has_cc_deduction"], True)
        # Bank rows only; the settlement's card charges belong to the card period
        check("finished period items", verified_banks[0]["transaction_count"], 5)
        check("finished period money in", verified_banks[0]["money_in"], "8500.00")
        check("finished period money out", verified_banks[0]["money_out"], "4070.00")
        check("finished period closing balance", verified_banks[0]["bank_balance"], "152300.00")
        check("finished period opening", verified_banks[0]["opening_balance"], "140000.00")
        check("finished period gap computed", verified_banks[0]["gap_verified"] is not None, True)
        check("finished period within tolerance", verified_banks[0]["within_tolerance"], True)
        check("finished card statements", len(ws.get("cc_history") or []), 1)
        check("finished card charged total", (ws["cc_history"][0]).get("charged_total"), "1830.45")
        check("checked through", ws["last_verification_date"], "2026-05-31")
        check("operating accounts", len(ws.get("operating_accounts") or []), 2)
        check("known cards", len(ws.get("credit_cards") or []), 2)

        print("2. Finished bank period detail (drives Finished periods view)")
        past = client.get(f"{BANK_URL}/{verified_banks[0]['session_id']}").json()
        check("verified transactions", len(past["able_txs"]), 5)
        check("skipped statement lines", line_counts(past).get("ignored", 0), 1)
        check("app rows not on statement", len(past["not_in_excel_txs"]), 1)
        check("closing balance present", past["bank_balance"] is not None, True)
        check("opening present", past["opening_balance"] is not None, True)
        check("gap computed", past["gap_verified"] is not None, True)

        print("3. Upload June-July bank statement")
        created = upload(client, BANK_URL, BANK_XLSX)
        check("upload status", created.status_code, 200)
        session = created.json()
        counts = line_counts(session)
        check("period start", session["statement_start_date"], "2026-06-02")
        check("period end", session["statement_end_date"], "2026-07-08")
        check("found on statement", counts.get("proposed_match", 0), 8)
        check("statement lines still open", counts.get("unmatched", 0), 32)
        check("card payment lines", session["cc_deduction_count"], 2)
        check("app rows not on statement", session["counts"]["app_unmatched"], 3)
        check("cannot finish yet", session["can_complete"], False)

        print("4. Confirm / create / ignore the whole period")
        buffer_prop = next(
            p
            for p in client.get("/api/v1/properties").json()
            if p["client_prop_id"] == "BUFFER"
        )
        actions = [
            {
                "action": "confirm_match",
                "fingerprint": line["fingerprint"],
                "kind": line["proposed_kind"],
                "tx_id": line["proposed_tx_id"],
            }
            for line in session["lines"]
            if line["status"] == "proposed_match"
        ]
        actions += [
            {
                "action": "add_from_bank",
                "fingerprint": line["fingerprint"],
                "property_id": buffer_prop["id"],
            }
            for line in session["lines"]
            if line["status"] == "unmatched" and line.get("proposed_kind") != "cc_settlement"
        ]
        actions += [
            {"action": "ignore_app", "kind": row["kind"], "tx_id": row["id"], "reason": "test"}
            for row in session["unmatched_app"]
            if row["status"] == "unmatched"
        ]
        applied = client.post(f"{BANK_URL}/{session['id']}/actions", json={"actions": actions})
        check("actions status", applied.status_code, 200)
        after = applied.json()
        check("nothing left to handle", after["counts"]["unresolved_bank"], 0)
        check("no app rows left", after["counts"]["unresolved_app"], 0)
        check("can finish", after["can_complete"], True)
        completed = client.post(f"{BANK_URL}/{session['id']}/complete")
        check("complete status", completed.status_code, 200)
        check("period finished", completed.json()["status"], "completed")

        print("5. Upload card statement 6947")
        card = upload(client, CC_URL, CARD1_XLSX)
        check("card upload status", card.status_code, 200)
        card_session = card.json()
        card_counts = line_counts(card_session)
        check("card", card_session["card_last4"], "6947")
        check("found on statement", card_counts.get("proposed_match", 0), 4)
        check("statement lines still open", card_counts.get("unmatched", 0), 6)
        check("app rows not on statement", card_session["counts"]["app_unmatched"], 1)

        card_actions = [
            {
                "action": "confirm_match",
                "fingerprint": line["fingerprint"],
                "tx_id": line["proposed_tx_id"],
            }
            for line in card_session["lines"]
            if line["status"] == "proposed_match"
        ]
        card_actions += [
            {"action": "ignore_cc", "fingerprint": line["fingerprint"], "reason": "test"}
            for line in card_session["lines"]
            if line["status"] == "unmatched"
        ]
        card_actions += [
            {"action": "ignore_app", "tx_id": row["id"], "reason": "test"}
            for row in card_session["unmatched_app"]
            if row["status"] == "unmatched"
        ]
        card_applied = client.post(
            f"{CC_URL}/{card_session['id']}/actions", json={"actions": card_actions}
        )
        check("card actions status", card_applied.status_code, 200)
        check("card can finish", card_applied.json()["can_complete"], True)
        card_done = client.post(f"{CC_URL}/{card_session['id']}/complete")
        check("card complete status", card_done.status_code, 200)

        print("6. Card 3848 is scoped separately")
        card2 = upload(client, CC_URL, CARD2_XLSX)
        check("card2 upload status", card2.status_code, 200)
        card2_counts = line_counts(card2.json())
        check("card2", card2.json()["card_last4"], "3848")
        check("found on statement", card2_counts.get("proposed_match", 0), 1)
        check("statement lines still open", card2_counts.get("unmatched", 0), 1)

        print("7. Re-uploading a finished bank period is rejected")
        again = upload(client, BANK_URL, BANK_XLSX)
        check("re-upload status", again.status_code, 400)
        check(
            "caught-up message",
            "No new bank transactions" in again.json().get("detail", ""),
            True,
        )

        print("8. Workspace after finishing")
        ws2 = client.get("/api/v1/bank-settings/verification-workspace").json()
        check(
            "finished bank periods",
            len([g for g in ws2["bank_groups"] if g["status"] == "verified"]),
            2,
        )
        check("finished card statements", len(ws2.get("cc_history") or []), 2)
        check("checked through", ws2["last_verification_date"], "2026-07-08")

    shutil.rmtree(work_dir, ignore_errors=True)

    print()
    if failures:
        print(f"{len(failures)} of {checks} checks FAILED:")
        for name in failures:
            print(f"  - {name}")
        return 1
    print(f"All {checks} checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
