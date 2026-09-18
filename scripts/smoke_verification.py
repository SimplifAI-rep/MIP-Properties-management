"""Local verification smoke after ClientData reset/import.

Runs against the project SQLite DB via FastAPI TestClient (no live server required).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models.deposit import Deposit  # noqa: E402
from app.models.expense import Expense  # noqa: E402
from app.services.bank_reconcile_gap import parse_bank_statement_lines  # noqa: E402
from app.services.cc_reconcile import parse_cc_statement_lines  # noqa: E402

BANK = ROOT / "data" / "ClientData" / "Bank Account example.xlsx"
CC1 = ROOT / "data" / "ClientData" / "credit card 1 example.xlsx"
CC2 = ROOT / "data" / "ClientData" / "credit card 2 example.xlsx"


def assert_ok(resp, label: str) -> dict:
    if resp.status_code >= 400:
        raise SystemExit(f"{label} failed {resp.status_code}: {resp.text}")
    return resp.json()


def fix_cc_card_last4() -> int:
    init_db()
    db = SessionLocal()
    fixed = 0
    try:
        for exp in db.scalars(select(Expense).where(Expense.import_key.like("cc:%"))).all():
            m = re.match(r"^cc:(\d{4}|unknown):", exp.import_key or "")
            if not m:
                continue
            want = None if m.group(1) == "unknown" else m.group(1)
            if exp.card_last4 != want:
                exp.card_last4 = want
                fixed += 1
            if exp.payment_method != "credit_card":
                exp.payment_method = "credit_card"
                fixed += 1
        db.commit()
    finally:
        db.close()
    return fixed


def verify_excel_in_db() -> None:
    init_db()
    db = SessionLocal()
    try:
        bank_lines = parse_bank_statement_lines(BANK.read_bytes())["lines"]
        bank_dep = db.scalar(
            select(func.count()).select_from(Deposit).where(Deposit.import_key.like("bank:%"))
        ) or 0
        bank_exp = db.scalar(
            select(func.count()).select_from(Expense).where(Expense.import_key.like("bank:%"))
        ) or 0
        print(
            json.dumps(
                {
                    "bank_excel_lines": len(bank_lines),
                    "bank_db_deposits": bank_dep,
                    "bank_db_expenses": bank_exp,
                    "bank_db_total": bank_dep + bank_exp,
                    "bank_match": bank_dep + bank_exp == len(bank_lines),
                },
                indent=2,
            )
        )
        if bank_dep + bank_exp != len(bank_lines):
            raise SystemExit("Bank Excel lines do not match DB bank imports")

        cc_total = 0
        for path in (CC1, CC2):
            parsed = parse_cc_statement_lines(path.read_bytes())
            cc_total += len(parsed["lines"])
            print(
                f"CC excel {path.name}: lines={len(parsed['lines'])} card={parsed.get('card_last4')}"
            )
        cc_db = db.scalar(
            select(func.count()).select_from(Expense).where(Expense.import_key.like("cc:%"))
        ) or 0
        print(
            json.dumps(
                {"cc_excel_lines": cc_total, "cc_db_expenses": cc_db, "cc_match": cc_db == cc_total},
                indent=2,
            )
        )
        if cc_db != cc_total:
            raise SystemExit("CC Excel lines do not match DB cc imports")
    finally:
        db.close()


def upload(client: TestClient, path: Path, url: str) -> dict:
    with path.open("rb") as handle:
        resp = client.post(
            url,
            files={
                "file": (
                    path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    return assert_ok(resp, f"upload {path.name} -> {url}")


def resolve_bank(client: TestClient, session: dict) -> dict:
    actions = []
    for line in session["lines"]:
        st = line["status"]
        if st == "proposed_match":
            actions.append(
                {
                    "action": "confirm_match",
                    "fingerprint": line["fingerprint"],
                    "kind": line.get("proposed_kind"),
                    "tx_id": line.get("proposed_tx_id"),
                }
            )
        elif st == "proposed_settlement":
            if line.get("proposed_member_ids"):
                actions.append(
                    {
                        "action": "confirm_settlement",
                        "fingerprint": line["fingerprint"],
                        "member_ids": line.get("proposed_member_ids"),
                    }
                )
            else:
                actions.append({"action": "ignore_bank", "fingerprint": line["fingerprint"]})
        elif st == "unmatched":
            actions.append({"action": "ignore_bank", "fingerprint": line["fingerprint"]})
    for row in session.get("unmatched_app") or []:
        if row.get("status") == "unmatched":
            actions.append({"action": "ignore_app", "kind": row["kind"], "tx_id": row["id"]})
    if not actions:
        return session
    resp = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    return assert_ok(resp, "bank actions")


def resolve_cc(client: TestClient, session: dict) -> dict:
    actions = []
    for line in session["lines"]:
        st = line["status"]
        if st == "proposed_match":
            actions.append(
                {
                    "action": "confirm_match",
                    "fingerprint": line["fingerprint"],
                    "tx_id": line.get("proposed_tx_id"),
                }
            )
        elif st == "unmatched":
            actions.append({"action": "ignore_cc", "fingerprint": line["fingerprint"]})
    for row in session.get("unmatched_app") or []:
        if row.get("status") == "unmatched":
            actions.append({"action": "ignore_app", "tx_id": row["id"]})
    if not actions:
        return session
    resp = client.post(
        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    return assert_ok(resp, "cc actions")


def main() -> int:
    print("=== Excel vs DB ===")
    fixed = fix_cc_card_last4()
    print(f"fixed card_last4/payment_method fields: {fixed}")
    verify_excel_in_db()

    with TestClient(app) as client:
        assert_ok(client.get("/api/v1/health"), "health")

        settings = assert_ok(client.get("/api/v1/bank-settings"), "bank-settings")
        print(
            "settings before:",
            json.dumps(
                {
                    "opening_balance": settings.get("opening_balance"),
                    "last_verification_date": settings.get("last_verification_date"),
                }
            ),
        )

        login = client.post("/api/v1/auth/admin/login", json={"password": "change-me"})
        if login.status_code == 200:
            token = login.json().get("token")
            headers = {"Authorization": f"Bearer {token}"}
            cut = client.post(
                "/api/v1/bank-settings/cutover",
                headers=headers,
                json={
                    "opening_balance": "166000",
                    "as_of_date": "2026-06-01",
                    "gap_tolerance_amount": "50000",
                },
            )
            if cut.status_code < 400:
                body = cut.json()
                print("cutover ok", body.get("deposits_marked"), body.get("expenses_marked"))
            else:
                print("cutover skipped/failed", cut.status_code, cut.text[:300])
        else:
            print("admin login failed; continuing without cutover", login.status_code)

        print("=== Bank reconcile session ===")
        bank_session = upload(client, BANK, "/api/v1/bank-settings/reconcile/sessions")
        counts = bank_session.get("counts") or {}
        print("bank session counts:", json.dumps(counts, indent=2))
        bank_session = resolve_bank(client, bank_session)
        print(
            "after resolve can_complete=",
            bank_session.get("can_complete"),
            "counts=",
            bank_session.get("counts"),
        )
        if bank_session.get("can_complete"):
            done = assert_ok(
                client.post(
                    f"/api/v1/bank-settings/reconcile/sessions/{bank_session['id']}/complete"
                ),
                "bank complete",
            )
            print("bank completed", done.get("status"), "through", done.get("statement_end_date"))
        else:
            print("WARN bank cannot complete yet:", bank_session.get("counts"))
            print(
                "gap=",
                bank_session.get("gap_verified"),
                "within=",
                bank_session.get("within_tolerance_verified"),
            )

        print("=== CC reconcile sessions ===")
        for path in (CC1, CC2):
            session = upload(client, path, "/api/v1/bank-settings/cc-reconcile/sessions")
            print(path.name, "card", session.get("card_last4"), "counts", session.get("counts"))
            session = resolve_cc(client, session)
            print(
                " after resolve can_complete=",
                session.get("can_complete"),
                "counts=",
                session.get("counts"),
            )
            if session.get("can_complete"):
                done = assert_ok(
                    client.post(
                        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/complete"
                    ),
                    f"cc complete {path.name}",
                )
                print(" completed", done.get("status"), "through", done.get("statement_end_date"))
            else:
                print(" WARN cannot complete", path.name)

        ws = assert_ok(client.get("/api/v1/bank-settings/verification-workspace"), "workspace")
        print(
            "workspace summary:",
            json.dumps(
                {
                    "last_verification_date": ws.get("last_verification_date"),
                    "last_cc_verification_date": ws.get("last_cc_verification_date"),
                    "bank_verified_groups": sum(
                        1
                        for g in (ws.get("bank_groups") or [])
                        if g.get("status") == "verified"
                    ),
                    "cc_history": len(ws.get("cc_history") or []),
                    "credit_cards": [
                        {"last4": c.get("card_last4"), "pending": c.get("pending_count")}
                        for c in (ws.get("credit_cards") or [])
                    ],
                },
                indent=2,
            ),
        )

    print("=== DONE ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
