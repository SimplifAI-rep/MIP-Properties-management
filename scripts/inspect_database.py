#!/usr/bin/env python3
"""Print a summary of seeded and imported database contents."""

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from sqlalchemy import func, select  # noqa: E402

from app.core.config import DEFAULT_DB_PATH, get_settings  # noqa: E402
from app.core.database import SessionLocal, init_db  # noqa: E402
from app.models.bank_account import BankAccount  # noqa: E402
from app.models.deposit import Deposit  # noqa: E402
from app.models.owner import Owner  # noqa: E402
from app.models.property import Property  # noqa: E402


def main() -> None:
    settings = get_settings()
    print(f"Database: {DEFAULT_DB_PATH}")
    print(f"Exists:   {DEFAULT_DB_PATH.exists()}")
    print(f"URL:      {settings.database_url}")
    print()

    if not DEFAULT_DB_PATH.exists():
        print("No database file found. Run this first:")
        print("  python scripts/import_deposits.py data/seed/bank_deposits.xlsx --seed")
        return

    init_db()
    db = SessionLocal()
    try:
        owner_count = db.scalar(select(func.count()).select_from(Owner)) or 0
        property_count = db.scalar(select(func.count()).select_from(Property)) or 0
        account_count = db.scalar(select(func.count()).select_from(BankAccount)) or 0
        deposit_count = db.scalar(select(func.count()).select_from(Deposit)) or 0

        print("Table counts:")
        print(f"  owners:         {owner_count}")
        print(f"  properties:     {property_count}")
        print(f"  bank_accounts:  {account_count}")
        print(f"  deposits:       {deposit_count}")
        print()

        if deposit_count == 0:
            print("Database exists but has no deposits.")
            print("Import data with:")
            print("  python scripts/import_deposits.py data/seed/bank_deposits.xlsx --seed")
            return

        print("Deposits by property:")
        rows = db.execute(
            select(
                Property.name,
                func.count(Deposit.id),
                func.sum(Deposit.amount),
            )
            .join(Deposit, Deposit.property_id == Property.id)
            .group_by(Property.name)
            .order_by(Property.name)
        ).all()
        for name, count, total in rows:
            print(f"  {name}: {count} deposits, total {total}")

        print()
        print("Recent deposits:")
        recent = db.scalars(
            select(Deposit).order_by(Deposit.transaction_date.desc()).limit(5)
        ).all()
        for deposit in recent:
            prop = db.get(Property, deposit.property_id)
            print(
                f"  {deposit.transaction_date} | {prop.name if prop else '?'} | "
                f"{deposit.amount} {deposit.currency} | {deposit.description}"
            )

        print()
        print("March 2026 deposits for Dizengoff 45 (should be empty):")
        dizengoff = db.scalar(
            select(Property.id).where(Property.name == "Dizengoff 45")
        )
        if dizengoff:
            march_count = db.scalar(
                select(func.count())
                .select_from(Deposit)
                .where(
                    Deposit.property_id == dizengoff,
                    Deposit.transaction_date >= date(2026, 3, 1),
                    Deposit.transaction_date <= date(2026, 3, 31),
                )
            )
            print(f"  count: {march_count}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
