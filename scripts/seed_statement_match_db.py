"""Reset the database to statement-only rows for a clean verification gap test.

Imports owners/properties, then only:

* Bank Account example.xlsx  (bank-scoped deposits/expenses)
* credit card 1 example.xlsx
* credit card 2 example.xlsx

The management ledger is skipped so there are no extra/missing app rows
against those three files. Mastercard bank-settlement lines are not imported
as expenses: they wait for the card step and would otherwise show as
"in the app, not on the statement". Opening is set so that after you confirm
every remaining bank match, closing − opening − app net = 0.

Usage (from the repo root):

    backend\\.venv\\Scripts\\python.exe scripts\\seed_statement_match_db.py
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
CLIENT_DATA = ROOT / "data" / "ClientData"
BANK_XLSX = CLIENT_DATA / "Bank Account example.xlsx"

sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(ROOT / "scripts"))

from seed_test_db import backup_and_reset, resolve_db_path  # noqa: E402


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

        print(f"Statement {start} → {end}")
        print(f"Bank closing      {closing}")
        print(f"App net (bank)    {all_net}  (in {deposits_sum} − out {expenses_sum})")
        print(f"Opening set to    {opening}")
        print(f"Expected gap      {closing - (opening + all_net)}")
        print(f"Database: {db_path}")
        print("Upload the same three Excel files on Verification. After confirming every match, the balance check should read 0.")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
