"""Build a small, predictable database for testing the Verification page.

The fixture is derived from the real sample statements in ``data/ClientData`` so the
seeded app rows always line up with what the parsers actually read:

* one finished May period (bank + card + settlement) so "Finished periods" has content
* June-July app rows crafted against ``Bank Account example.xlsx`` so uploading it
  produces a deliberate mix of matched / statement-only / app-only rows
* pending card expenses crafted against both ``credit card N example.xlsx`` files

Usage (from the repo root):

    backend\\.venv\\Scripts\\python.exe scripts\\seed_test_db.py

The existing database file is copied to ``<name>.bak-<timestamp>`` before it is
replaced, so a previous dev database can always be restored.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CLIENT_DATA = ROOT / "data" / "ClientData"

BANK_XLSX = CLIENT_DATA / "Bank Account example.xlsx"
CARD1_XLSX = CLIENT_DATA / "credit card 1 example.xlsx"
CARD2_XLSX = CLIENT_DATA / "credit card 2 example.xlsx"

# Stable ids so repeated runs produce identical URLs and are easy to talk about.
OWNER_COHEN = uuid.UUID("a1000000-0000-4000-8000-000000000001")
OWNER_LEVI = uuid.UUID("a1000000-0000-4000-8000-000000000002")
OWNER_HOUSE = uuid.UUID("a1000000-0000-4000-8000-000000000003")

PROP_ROTHSCHILD = uuid.UUID("b1000000-0000-4000-8000-000000000001")
PROP_DIZENGOFF = uuid.UUID("b1000000-0000-4000-8000-000000000002")
PROP_HERZL = uuid.UUID("b1000000-0000-4000-8000-000000000003")
PROP_BUFFER = uuid.UUID("b1000000-0000-4000-8000-0000000000ff")

# Last verification cut-off: the May period below ends here, so uploading the
# June-July bank statement always yields a fresh period with every line in scope.
LAST_VERIFIED = date(2026, 5, 31)
MAY_OPENING = Decimal("140000.00")
MAY_CLOSING = Decimal("152300.00")

# Fixture choice: a tolerance this wide effectively disables the balance-gap guard,
# so the period can be finished whichever mix of Confirm / Create / Ignore is used.
GAP_TOLERANCE = Decimal("1000000.00")

# Bank statement lines that should arrive as "Found on statement" proposals.
# (asmachta, amount) is unique in the sample file; the loader asserts that.
BANK_MATCHES: list[tuple[str, str, str, uuid.UUID]] = [
    ("99012", "2708", "Rent collected - Rothschild 12", PROP_ROTHSCHILD),
    ("99012", "4292", "Rent collected - Dizengoff 45", PROP_DIZENGOFF),
    ("99020", "7000", "Rent collected - Herzl 8", PROP_HERZL),
    ("82726", "9535", "Renovation - kitchen units", PROP_ROTHSCHILD),
    ("136970", "826", "Water bill - June", PROP_DIZENGOFF),
    ("264501", "25", "Bank handling fee", PROP_BUFFER),
    ("140780", "2263", "Gardening - June", PROP_HERZL),
    ("166724", "1150", "Cleaning - stairwell", PROP_ROTHSCHILD),
]

# App rows inside the statement window that the bank never shows.
BANK_APP_ONLY: list[tuple[str, str, str, uuid.UUID, str]] = [
    ("expense", "2026-06-18", "777.77", PROP_ROTHSCHILD, "Gardening - extra visit"),
    ("expense", "2026-07-04", "1111.11", PROP_DIZENGOFF, "Locksmith call-out"),
    ("deposit", "2026-06-23", "333.33", PROP_HERZL, "Owner top-up - Herzl 8"),
]

# Card statement lines that should arrive as "Found on statement" proposals.
CARD_MATCHES: list[tuple[str, str, str, uuid.UUID]] = [
    ("6947", "2026-07-06", "160", PROP_ROTHSCHILD),
    ("6947", "2026-06-30", "244.92", PROP_DIZENGOFF),
    ("6947", "2026-06-30", "3132.9", PROP_HERZL),
    ("6947", "2026-06-28", "590.05", PROP_ROTHSCHILD),
    ("3848", "2026-07-02", "514.5", PROP_DIZENGOFF),
]

# Card expenses in the app that no card statement shows.
CARD_APP_ONLY: list[tuple[str, str, str, uuid.UUID, str]] = [
    ("6947", "2026-06-29", "45.60", PROP_DIZENGOFF, "Hardware store - spare keys"),
]

# The finished May period. Its asmachtot must not appear in the June-July statement:
# bank-verified asmachtot are treated as already-seen and stripped from later uploads.
MAY_SPEC: list[tuple[int, str, str, str, str, str, uuid.UUID]] = [
    (31, "2026-05-05", "credit", "7000.00", "900001", "Rent collected - Herzl 8", PROP_HERZL),
    (32, "2026-05-08", "debit", "2450.00", "900002", "Gardening - May", PROP_ROTHSCHILD),
    (33, "2026-05-12", "debit", "980.00", "900003", "Cleaning - May", PROP_DIZENGOFF),
    (34, "2026-05-19", "credit", "1500.00", "900004", "Owner top-up - Rothschild 12", PROP_ROTHSCHILD),
    (35, "2026-05-26", "debit", "640.00", "900005", "Elevator service - May", PROP_HERZL),
]
MAY_SKIPPED_ASMACHTA = "900006"
MAY_SETTLEMENT_ASMACHTA = "900007"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def resolve_db_path(database_url: str) -> Path | None:
    if not database_url.startswith("sqlite"):
        return None
    raw = database_url.removeprefix("sqlite:///")
    return Path(raw)


def backup_and_reset(db_path: Path, *, backup: bool) -> Path | None:
    if not db_path.exists():
        return None
    if not backup:
        db_path.unlink()
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = db_path.with_suffix(db_path.suffix + f".bak-{stamp}")
    shutil.copy2(db_path, target)
    db_path.unlink()
    return target


def pick_bank_line(lines: list[dict], asmachta: str, amount: str) -> dict:
    wanted = Decimal(amount)
    hits = [
        line
        for line in lines
        if (line.get("asmachta") or "") == asmachta
        and Decimal(str(line["amount"])) == wanted
    ]
    if len(hits) != 1:
        raise SystemExit(
            f"Expected exactly one bank line with asmachta={asmachta} amount={amount}, "
            f"found {len(hits)}. The sample statement changed — update BANK_MATCHES."
        )
    return hits[0]


def pick_card_line(lines: list[dict], tx_date: str, amount: str) -> dict:
    wanted = Decimal(amount)
    hits = [
        line
        for line in lines
        if line.get("transaction_date") == tx_date
        and Decimal(str(line["amount"])) == wanted
    ]
    if len(hits) != 1:
        raise SystemExit(
            f"Expected exactly one card line on {tx_date} for {amount}, found {len(hits)}. "
            "The sample statement changed — update CARD_MATCHES."
        )
    return hits[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        help="SQLite file to build (default: the DATABASE_URL the app already uses)",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Delete the existing database instead of copying it aside first",
    )
    args = parser.parse_args()

    for path in (BANK_XLSX, CARD1_XLSX, CARD2_XLSX):
        if not path.exists():
            raise SystemExit(f"Missing sample statement: {path}")

    if args.db:
        target = Path(args.db).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        os.environ["DATABASE_URL"] = "sqlite:///" + str(target).replace("\\", "/")

    sys.path.insert(0, str(BACKEND))

    from app.core.config import get_settings

    settings = get_settings()
    db_path = resolve_db_path(settings.database_url)
    if db_path is None:
        raise SystemExit(
            f"Refusing to seed a non-SQLite database ({settings.database_url})."
        )

    saved = backup_and_reset(db_path, backup=not args.no_backup)

    from app.core.database import SessionLocal, init_db
    from app.models.bank_account import BankAccount
    from app.models.bank_reconcile_session import BankReconcileSession
    from app.models.cc_reconcile_session import CcReconcileSession
    from app.models.cc_settlement_group import CcSettlementGroup
    from app.models.deposit import Deposit
    from app.models.expense import Expense
    from app.models.owner import Owner
    from app.models.property import Property
    from app.services.account_scope import (
        COMPANY_ACCOUNT_NUMBER,
        COMPANY_CC_ACCOUNT_PREFIX,
    )
    from app.services.bank_reconcile_gap import parse_bank_statement_lines
    from app.services.bank_settings import update_settings
    from app.services.cc_reconcile import parse_cc_statement_lines

    init_db()

    bank = parse_bank_statement_lines(BANK_XLSX.read_bytes())
    bank_lines = bank["lines"]
    cards = {
        "6947": parse_cc_statement_lines(CARD1_XLSX.read_bytes()),
        "3848": parse_cc_statement_lines(CARD2_XLSX.read_bytes()),
    }
    for last4, parsed in cards.items():
        if parsed["card_last4"] != last4:
            raise SystemExit(
                f"Card file reports last4={parsed['card_last4']}, expected {last4}."
            )

    statement_amounts = {Decimal(str(line["amount"])) for line in bank_lines}
    for _kind, _when, amount, _prop, label in BANK_APP_ONLY:
        if Decimal(amount) in statement_amounts:
            raise SystemExit(
                f"App-only row '{label}' uses {amount}, which is on the bank statement "
                "and would match. Pick a different amount."
            )

    statement_asmachtot = {
        (line.get("asmachta") or "").strip() for line in bank_lines
    } - {""}
    may_asmachtot = (
        {spec[4] for spec in MAY_SPEC}
        | {MAY_SKIPPED_ASMACHTA, MAY_SETTLEMENT_ASMACHTA}
    )
    clashes = sorted(may_asmachtot & statement_asmachtot)
    if clashes:
        raise SystemExit(
            f"May period reuses asmachta {clashes} from the June-July statement. Those "
            "lines would be stripped as already-verified duplicates — pick other values."
        )

    db = SessionLocal()
    try:
        db.add_all(
            [
                Owner(id=OWNER_COHEN, name="David Cohen", contact_email="david@example.com"),
                Owner(id=OWNER_LEVI, name="Sarah Levi", contact_email="sarah@example.com"),
                Owner(id=OWNER_HOUSE, name="Management company", contact_email=None),
            ]
        )
        db.add_all(
            [
                Property(
                    id=PROP_ROTHSCHILD,
                    owner_id=OWNER_COHEN,
                    client_prop_id="R12",
                    name="Rothschild 12",
                    address="12 Rothschild Blvd, Tel Aviv",
                    city="Tel Aviv",
                    status="active",
                ),
                Property(
                    id=PROP_DIZENGOFF,
                    owner_id=OWNER_COHEN,
                    client_prop_id="D45",
                    name="Dizengoff 45",
                    address="45 Dizengoff St, Tel Aviv",
                    city="Tel Aviv",
                    status="active",
                ),
                Property(
                    id=PROP_HERZL,
                    owner_id=OWNER_LEVI,
                    client_prop_id="H8",
                    name="Herzl 8",
                    address="8 Herzl St, Haifa",
                    city="Haifa",
                    status="active",
                ),
                Property(
                    id=PROP_BUFFER,
                    owner_id=OWNER_HOUSE,
                    client_prop_id="BUFFER",
                    name="Buffer (unassigned)",
                    address="-",
                    city="-",
                    status="active",
                ),
            ]
        )
        db.flush()

        ops = BankAccount(
            property_id=None,
            bank_name="Bank Leumi",
            account_number=COMPANY_ACCOUNT_NUMBER,
            currency="ILS",
            label="MIP operating account",
        )
        ops_spare = BankAccount(
            property_id=None,
            bank_name="Bank Leumi",
            account_number="MIP-LEUMI-OPS-2",
            currency="ILS",
            label="MIP secondary account (empty)",
        )
        card_accounts = {
            last4: BankAccount(
                property_id=None,
                bank_name="Bank Leumi Mastercard",
                account_number=f"{COMPANY_CC_ACCOUNT_PREFIX}{last4}",
                currency="ILS",
                label=f"Credit card \u2022\u2022{last4}",
            )
            for last4 in cards
        }
        db.add_all([ops, ops_spare, *card_accounts.values()])
        db.flush()

        # ---------------- finished May period (bank + card + settlement) -------------
        settlement_members: list[Expense] = []
        for when, amount, vendor, prop in (
            ("2026-05-04", "620.15", "Office supplies", PROP_BUFFER),
            ("2026-05-14", "980.30", "Tools and materials", PROP_ROTHSCHILD),
            ("2026-05-21", "230.00", "Fuel", PROP_BUFFER),
        ):
            row = Expense(
                property_id=prop,
                transaction_date=date.fromisoformat(when),
                amount=Decimal(amount),
                category="maintenance",
                source="credit_card",
                payment_method="credit_card",
                vendor_name=vendor,
                description=f"{vendor} - May",
                card_last4="6947",
                cc_verified_at=now_utc(),
                cc_bank_confirmed_at=now_utc(),
            )
            settlement_members.append(row)
        db.add_all(settlement_members)
        db.flush()

        settlement_total = sum((row.amount for row in settlement_members), Decimal("0"))
        settlement_fp = "|".join(
            ["37", "2026-05-28", "debit", f"{settlement_total:.2f}", MAY_SETTLEMENT_ASMACHTA]
        )
        group = CcSettlementGroup(
            settlement_date=date(2026, 5, 28),
            amount=settlement_total,
            bank_asmachta=MAY_SETTLEMENT_ASMACHTA,
            bank_fingerprint=settlement_fp,
            bank_description="\u05dc\u05d0\u05d5\u05de\u05d9 \u05de\u05d0\u05e1\u05d8\u05e8\u05e7\u05e8\u05d3",
            window_start=date(2026, 5, 2),
            window_end=date(2026, 5, 28),
            member_total=settlement_total,
            member_expense_ids=[str(row.id) for row in settlement_members],
            status="confirmed",
            confirmed_at=now_utc(),
        )
        db.add(group)
        db.flush()
        for row in settlement_members:
            row.cc_settlement_group_id = group.id
        db.flush()

        may_lines: list[dict] = []

        def may_line(
            row_number: int,
            when: str,
            side: str,
            amount: str,
            asmachta: str,
            description: str,
        ) -> dict:
            return {
                "fingerprint": "|".join(
                    [str(row_number), when, side, f"{Decimal(amount):.2f}", asmachta]
                ),
                "row_number": row_number,
                "transaction_date": when,
                "side": side,
                "amount": amount,
                "asmachta": asmachta,
                "description": description,
                "balance_after": None,
                "status": "unmatched",
            }

        for row_number, when, side, amount, asmachta, label, prop in MAY_SPEC:
            line = may_line(row_number, when, side, amount, asmachta, label)
            if side == "credit":
                row: Deposit | Expense = Deposit(
                    bank_account_id=ops.id,
                    property_id=prop,
                    transaction_date=date.fromisoformat(when),
                    amount=Decimal(amount),
                    reference=asmachta,
                    description=label,
                    source="manual",
                    bank_verified_at=now_utc(),
                    bank_asmachta=asmachta,
                )
                kind = "deposit"
            else:
                row = Expense(
                    property_id=prop,
                    transaction_date=date.fromisoformat(when),
                    amount=Decimal(amount),
                    category="maintenance",
                    source="manual_company",
                    payment_method="bank_transfer",
                    vendor_name=label,
                    reference=asmachta,
                    description=label,
                    bank_verified_at=now_utc(),
                    bank_asmachta=asmachta,
                )
                kind = "expense"
            db.add(row)
            db.flush()
            line["status"] = "matched"
            line["proposed_kind"] = kind
            line["proposed_tx_id"] = str(row.id)
            line["proposed_tx_ref"] = row.transaction_ref
            line["match_confidence"] = "high"
            may_lines.append(line)

        skipped = may_line(
            36, "2026-05-31", "debit", "38.00", MAY_SKIPPED_ASMACHTA, "Account keeping fee"
        )
        skipped["status"] = "ignored"
        skipped["ignore_reason"] = "Bank fee - not tracked per property"
        may_lines.append(skipped)

        settled_line = may_line(
            37,
            "2026-05-28",
            "debit",
            f"{settlement_total:.2f}",
            MAY_SETTLEMENT_ASMACHTA,
            "\u05dc\u05d0\u05d5\u05de\u05d9 \u05de\u05d0\u05e1\u05d8\u05e8\u05e7\u05e8\u05d3",
        )
        settled_line["status"] = "settled"
        settled_line["proposed_kind"] = "cc_settlement"
        settled_line["settlement_group_id"] = str(group.id)
        settled_line["proposed_member_ids"] = [str(row.id) for row in settlement_members]
        settled_line["proposed_group_total"] = f"{settlement_total:.2f}"
        settled_line["proposed_window_start"] = "2026-05-02"
        settled_line["proposed_window_end"] = "2026-05-28"
        settled_line["proposed_summary"] = (
            f"Card payment covering {len(settlement_members)} card charges"
        )
        may_lines.append(settled_line)

        invoice_only = Expense(
            property_id=PROP_DIZENGOFF,
            transaction_date=date(2026, 5, 20),
            amount=Decimal("512.00"),
            category="maintenance",
            source="manual_company",
            payment_method="bank_transfer",
            vendor_name="Paint touch-up",
            description="Invoice logged in May, paid in June",
        )
        db.add(invoice_only)
        db.flush()

        may_session = BankReconcileSession(
            status="completed",
            filename="Bank Account May 2026.xlsx",
            bank_account_id=ops.id,
            bank_balance=MAY_CLOSING,
            statement_start_date=date(2026, 5, 4),
            statement_end_date=LAST_VERIFIED,
            opening_balance=MAY_OPENING,
            after_date=date(2026, 4, 30),
            gap_tolerance_amount=GAP_TOLERANCE,
            lines_json=may_lines,
            unmatched_app_json=[
                {
                    "kind": "expense",
                    "id": str(invoice_only.id),
                    "transaction_ref": invoice_only.transaction_ref,
                    "transaction_date": "2026-05-20",
                    "amount": "512.00",
                    "description": "Paint touch-up",
                    "status": "ignored",
                    "ignore_reason": "Invoice logged, paid the following month",
                }
            ],
        )
        db.add(may_session)

        may_card_lines = []
        for index, row in enumerate(settlement_members, start=1):
            when = row.transaction_date.isoformat()
            may_card_lines.append(
                {
                    "fingerprint": "|".join(
                        [str(index), when, f"{row.amount:.2f}", row.vendor_name or ""]
                    ),
                    "row_number": index,
                    "transaction_date": when,
                    "amount": str(row.amount),
                    "merchant": row.vendor_name,
                    "details": None,
                    "status": "matched",
                    "proposed_tx_id": str(row.id),
                    "proposed_tx_ref": row.transaction_ref,
                    "proposed_summary": row.vendor_name,
                    "match_confidence": "high",
                    "ignore_reason": None,
                }
            )
        db.add(
            CcReconcileSession(
                status="completed",
                filename="credit card 6947 May 2026.xlsx",
                card_last4="6947",
                statement_start_date=date(2026, 5, 2),
                statement_end_date=date(2026, 5, 28),
                lines_json=may_card_lines,
                unmatched_app_json=[],
            )
        )

        # ---------------- open June-July period (nothing uploaded yet) ---------------
        for asmachta, amount, label, prop in BANK_MATCHES:
            line = pick_bank_line(bank_lines, asmachta, amount)
            when = date.fromisoformat(line["transaction_date"])
            value = Decimal(str(line["amount"]))
            if line["side"] == "credit":
                db.add(
                    Deposit(
                        bank_account_id=ops.id,
                        property_id=prop,
                        transaction_date=when,
                        amount=value,
                        reference=asmachta,
                        description=label,
                        source="manual",
                    )
                )
            else:
                db.add(
                    Expense(
                        property_id=prop,
                        transaction_date=when,
                        amount=value,
                        category="maintenance",
                        source="manual_company",
                        payment_method="bank_transfer",
                        vendor_name=label,
                        reference=asmachta,
                        description=label,
                    )
                )

        for kind, when, amount, prop, label in BANK_APP_ONLY:
            if kind == "deposit":
                db.add(
                    Deposit(
                        bank_account_id=ops.id,
                        property_id=prop,
                        transaction_date=date.fromisoformat(when),
                        amount=Decimal(amount),
                        description=label,
                        source="manual",
                    )
                )
            else:
                db.add(
                    Expense(
                        property_id=prop,
                        transaction_date=date.fromisoformat(when),
                        amount=Decimal(amount),
                        category="maintenance",
                        source="manual_company",
                        payment_method="bank_transfer",
                        vendor_name=label,
                        description=label,
                    )
                )

        for last4, when, amount, prop in CARD_MATCHES:
            line = pick_card_line(cards[last4]["lines"], when, amount)
            db.add(
                Expense(
                    property_id=prop,
                    transaction_date=date.fromisoformat(when),
                    amount=Decimal(str(line["amount"])),
                    category="maintenance",
                    source="credit_card",
                    payment_method="credit_card",
                    vendor_name=line.get("merchant"),
                    description=line.get("merchant"),
                    card_last4=last4,
                )
            )

        for last4, when, amount, prop, label in CARD_APP_ONLY:
            db.add(
                Expense(
                    property_id=prop,
                    transaction_date=date.fromisoformat(when),
                    amount=Decimal(amount),
                    category="maintenance",
                    source="credit_card",
                    payment_method="credit_card",
                    vendor_name=label,
                    description=label,
                    card_last4=last4,
                )
            )

        db.commit()

        update_settings(
            db,
            bank_account_id=ops.id,
            opening_balance=MAY_CLOSING,
            opening_balance_as_of=LAST_VERIFIED,
            last_verification_date=LAST_VERIFIED,
            gap_tolerance_amount=GAP_TOLERANCE,
        )

        deposits = db.query(Deposit).count()
        expenses = db.query(Expense).count()
    finally:
        db.close()

    bank_statement_only = len(bank_lines) - len(BANK_MATCHES) - 2  # 2 card-payment lines
    card1_only = len(cards["6947"]["lines"]) - 4
    card2_only = len(cards["3848"]["lines"]) - 1

    print(f"Database rebuilt: {db_path}")
    if saved:
        print(f"Previous database saved as: {saved.name}")
    print(f"Rows: {deposits} deposits, {expenses} expenses")
    print()
    print("Finished periods (already in the DB):")
    print(f"  Bank 04/05/2026 - 31/05/2026, closing {MAY_CLOSING}")
    print("    5 verified, 1 skipped statement line, 1 app row not on the statement")
    print(f"  Card \u2022\u20226947 02/05/2026 - 28/05/2026, {len(settlement_members)} verified")
    print()
    print("Expected result when you upload 'Bank Account example.xlsx':")
    print(f"  period {bank['statement_start_date']} - {bank['statement_end_date']}")
    print(f"  Found on statement:            {len(BANK_MATCHES)}")
    print(f"  On the statement, not in app:  {bank_statement_only}")
    print(f"  In the app, not on statement:  {len(BANK_APP_ONLY)}")
    print("  Card payments on the statement: 2 (link after finishing the card step)")
    print()
    print("Expected result when you upload 'credit card 1 example.xlsx' (\u2022\u20226947):")
    print("  Found on statement: 4")
    print(f"  On the statement, not in app: {card1_only}")
    print("  In the app, not on statement: 1")
    print()
    print("Expected result when you upload 'credit card 2 example.xlsx' (\u2022\u20223848):")
    print("  Found on statement: 1")
    print(f"  On the statement, not in app: {card2_only}")
    print()
    print("Notes:")
    print(f"  Checked through {LAST_VERIFIED} - re-uploading the bank file after")
    print("  finishing the period shows the 'all caught up' notice.")
    print("  Gap tolerance is deliberately wide so the period can be finished")
    print("  with any mix of Confirm / Create / Ignore.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
