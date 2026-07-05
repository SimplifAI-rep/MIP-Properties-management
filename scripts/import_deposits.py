#!/usr/bin/env python3
"""Import bank deposit rows from an Excel file into the database."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.services.bank_import import BankImportService  # noqa: E402
from app.services.seed import seed_reference_data  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Import bank deposits from Excel")
    parser.add_argument(
        "file",
        type=Path,
        help="Path to the Excel file (e.g. data/seed/bank_deposits.xlsx)",
    )
    parser.add_argument(
        "--seed",
        action="store_true",
        help="Seed reference data (owners, properties, accounts) before import",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print result as JSON",
    )
    args = parser.parse_args()

    if not args.file.exists():
        print(f"Error: file not found: {args.file}", file=sys.stderr)
        return 1

    init_db()
    db = SessionLocal()
    try:
        if args.seed:
            seed_reference_data(db)

        service = BankImportService(db)
        result = service.import_deposits(args.file)

        if args.json:
            print(json.dumps(result.to_dict(), indent=2))
        else:
            print(f"Import complete: {result.filename}")
            print(f"  Rows processed: {result.row_count}")
            print(f"  Imported:       {result.imported_count}")
            print(f"  Skipped:        {result.skipped_count} (duplicates)")
            print(f"  Errors:         {result.error_count}")
            if result.errors:
                print("  Error details:")
                for err in result.errors:
                    print(f"    Row {err.row_number}: {err.message}")

        return 0 if result.error_count == 0 or result.imported_count > 0 else 1
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
