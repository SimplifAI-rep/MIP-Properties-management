"""Reset the database to statement-only rows for manual verification testing.

Imports owners/properties, then only:

* Bank Account example.xlsx  (bank-scoped deposits/expenses)
* credit card 1 example.xlsx
* credit card 2 example.xlsx

Then adds labelled TEST rows so every verification list has an example:
in app and in excel, in excel not in app, in app not in excel, card for this
period, card not for this period, and charges already pushed to the next cycle.

Opening is set from the imported matches only (TEST extras are added after).

Usage (from the repo root):

    backend\\.venv\\Scripts\\python.exe scripts\\seed_statement_match_db.py
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CLIENT_DATA = ROOT / "data" / "ClientData"
BANK_XLSX = CLIENT_DATA / "Bank Account example.xlsx"

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(ROOT / "scripts"))

from seed_test_db import backup_and_reset, resolve_db_path  # noqa: E402


def _add_verification_scenarios(db, *, start: date | None, end: date | None) -> None:
    """Add labelled extras after opening is set so identity still matches the Excel."""
    from sqlalchemy import select

    from app.models.deposit import Deposit
    from app.models.expense import Expense
    from app.models.property import Property
    from app.services.bank_reconcile import _is_cc_settlement_line
    from app.services.holding import UNASSIGNED_PROP_ID

    if start is None or end is None:
        print("Skipped verification scenarios (no statement dates)")
        return
    prop = db.scalars(
        select(Property).where(Property.client_prop_id != UNASSIGNED_PROP_ID)
    ).first()
    if prop is None:
        print("Skipped verification scenarios (no property)")
        return

    last4 = db.scalars(
        select(Expense.card_last4).where(
            Expense.payment_method == "credit_card",
            Expense.card_last4.is_not(None),
        )
    ).first() or "3848"
    mid = start + timedelta(days=max(1, (end - start).days // 2))
    now = datetime.now(timezone.utc)

    bank_rows = [
        row
        for row in db.scalars(select(Expense).where(Expense.source == "bank_statement"))
        if not _is_cc_settlement_line(row.description or "")
        and row.transaction_date is not None
        and start <= row.transaction_date <= end
    ]
    if bank_rows:
        victim = bank_rows[0]
        label = (victim.vendor_name or victim.description or "").encode("ascii", "replace").decode("ascii")
        print(f"Scenario excel-not-in-app (bank): removed {label} {victim.amount}")
        db.delete(victim)

    cc_rows = [
        row
        for row in db.scalars(select(Expense).where(Expense.source == "credit_card"))
        if row.transaction_date is not None
        and start <= row.transaction_date <= end
        and row.cc_deferred_until is None
    ]
    if cc_rows:
        victim = cc_rows[0]
        label = (victim.vendor_name or victim.description or "").encode("ascii", "replace").decode("ascii")
        print(f"Scenario excel-not-in-app (card): removed {label} {victim.amount}")
        db.delete(victim)

    extras = [
        Expense(
            property_id=prop.id,
            transaction_date=mid,
            amount=Decimal("12.34"),
            category="utilities",
            source="bank_statement",
            payment_method="bank_transfer",
            vendor_name="TEST Bank in app only",
            description="TEST Bank in app only",
        ),
        Expense(
            property_id=prop.id,
            transaction_date=mid,
            amount=Decimal("23.45"),
            category="utilities",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="TEST Card in app only",
            description="TEST Card in app only",
            card_last4=last4,
        ),
        Expense(
            property_id=prop.id,
            transaction_date=mid,
            amount=Decimal("99991.13"),
            category="utilities",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="TEST Card leftover this payment",
            description="TEST Card leftover this payment",
            card_last4=last4,
            cc_verified_at=now,
        ),
        Expense(
            property_id=prop.id,
            transaction_date=start - timedelta(days=10),
            amount=Decimal("66.66"),
            category="utilities",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="TEST Card from last cycle",
            description="TEST Card from last cycle",
            card_last4=last4,
            cc_deferred_until=start - timedelta(days=1),
        ),
        Expense(
            property_id=prop.id,
            transaction_date=end + timedelta(days=5),
            amount=Decimal("55.55"),
            category="utilities",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="TEST Card waiting next cycle",
            description="TEST Card waiting next cycle",
            card_last4=last4,
            cc_deferred_until=end,
        ),
    ]
    db.add_all(extras)
    db.add(
        Deposit(
            property_id=prop.id,
            transaction_date=mid,
            amount=Decimal("18.18"),
            source="bank_statement",
            description="TEST Bank deposit in app only",
            is_rental_income=False,
        )
    )
    db.commit()
    print("Verification test scenarios:")
    print("  In app and in excel  - remaining imported matches")
    print("  In excel not in app  - one bank line and one card line removed")
    print("  In app not in excel  - TEST Bank in app only / Card in app only / deposit")
    print("  Card for the period  - imported card charges that still match the Excel")
    print("  Card not this period - TEST Card leftover this payment (top of bank upload)")
    print("  Pushed last cycle    - TEST Card from last cycle (top of bank upload + Next cycle)")
    print("  Waiting next cycle   - TEST Card waiting next cycle (Next cycle page only)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", help="SQLite file to rebuild (default: app DATABASE_URL)")
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Delete the existing database instead of copying it aside first",
    )
    args = parser.parse_args()

    if not BANK_XLSX.exists():
        raise SystemExit(f"Missing {BANK_XLSX}")

    if args.db:
        target = Path(args.db).resolve()
        os.environ["DATABASE_URL"] = "sqlite:///" + str(target).replace("\\", "/")

    from app.core.config import get_settings

    settings = get_settings()
    db_path = resolve_db_path(settings.database_url)
    if db_path is None:
        raise SystemExit(f"Refusing to seed a non-SQLite database ({settings.database_url}).")

    saved = backup_and_reset(db_path, backup=not args.no_backup)
    if saved:
        print(f"Previous database saved to {saved}")

    from sqlalchemy import select

    from app.core.database import SessionLocal, init_db
    from app.models.bank_account import BankAccount
    from app.models.deposit import Deposit
    from app.models.expense import Expense
    from app.services.account_scope import COMPANY_ACCOUNT_NUMBER
    from app.services.bank_reconcile import _is_cc_settlement_line
    from app.services.bank_reconcile_gap import parse_bank_statement_lines, sum_bank_scoped_nets
    from app.services.bank_settings import get_or_create_settings
    from app.services.client_import import import_client_data

    init_db()
    db = SessionLocal()
    try:
        stats = import_client_data(
            db,
            data_dir=CLIENT_DATA,
            include_management=False,
            progress=print,
        )
        print(
            "Imported "
            f"{stats.deposits_created} deposits, "
            f"{stats.expenses_created} expenses, "
            f"{stats.owners_created} owners, "
            f"{stats.properties_created} properties"
        )

        # Card refunds imported as deposits would count in bank net and look extra.
        cc_deposits = list(
            db.scalars(select(Deposit).where(Deposit.source == "credit_card"))
        )
        for row in cc_deposits:
            db.delete(row)
        if cc_deposits:
            print(f"Removed {len(cc_deposits)} card-refund deposits from bank net")

        # Card-payment bank lines wait for the card step; keeping them as
        # expenses would show as extras on the bank lists.
        dropped = 0
        for row in db.scalars(select(Expense).where(Expense.source == "bank_statement")):
            if _is_cc_settlement_line(row.description):
                db.delete(row)
                dropped += 1
        if dropped:
            print(f"Left {dropped} bank card-payment line(s) for the card step")
        db.commit()

        parsed = parse_bank_statement_lines(BANK_XLSX.read_bytes())
        closing = parsed["bank_balance"]
        start = parsed["statement_start_date"]
        end = parsed["statement_end_date"]
        after = start - timedelta(days=1) if start else None
        all_net, _, deposits_sum, expenses_sum = sum_bank_scoped_nets(
            db, after_date=after, date_to=end
        )
        opening = closing - all_net

        company = get_or_create_settings(db)
        company.opening_balance = opening
        company.opening_balance_as_of = after
        company.last_verification_date = None
        company.gap_tolerance_amount = Decimal("0.01")
        db.add(company)

        account = db.scalars(
            select(BankAccount).where(BankAccount.account_number == COMPANY_ACCOUNT_NUMBER)
        ).first()
        if account is not None:
            account.opening_balance = opening
            account.opening_balance_as_of = after
            account.last_verification_date = None
            db.add(account)
        db.commit()

        print(f"Statement {start} -> {end}")
        print(f"Bank closing      {closing}")
        print(f"App net (bank)    {all_net}  (in {deposits_sum} - out {expenses_sum})")
        print(f"Opening set to    {opening}")
        print(f"Expected gap      {closing - (opening + all_net)}")
        _add_verification_scenarios(db, start=start, end=end)
        print(f"Database: {db_path}")
        print(
            "Upload Bank Account example.xlsx first - Not for this period is at the top. "
            "Then the two credit-card files. TEST rows are labelled. "
            "Next cycle lists charges already pushed forward."
        )
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
