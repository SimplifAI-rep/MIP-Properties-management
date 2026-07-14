"""Import client Excel data into the database.

Usage:
  python scripts/import_client_data.py              # import (idempotent)
  python scripts/import_client_data.py --reset      # wipe DB tables then import
  python scripts/import_client_data.py --verify-only

Prefer the project venv. If you run system Python, this script will
re-launch itself with backend/.venv automatically when possible.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / "backend" / ".venv" / "Scripts" / "python.exe"
if not VENV_PYTHON.exists():
    VENV_PYTHON = ROOT / "backend" / ".venv" / "bin" / "python"

# Re-exec under the project venv when launched with a bare system Python.
if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
    try:
        import sqlalchemy  # noqa: F401
    except ModuleNotFoundError:
        os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])

sys.path.insert(0, str(ROOT / "backend"))

try:
    from sqlalchemy import func, select  # noqa: E402
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Missing dependencies. Activate the backend venv first:\n"
        "  backend\\.venv\\Scripts\\activate\n"
        "  python scripts/import_client_data.py --reset\n"
        f"Or run:\n  {VENV_PYTHON} scripts/import_client_data.py --reset"
    ) from exc

from app.core.database import Base, SessionLocal, engine, init_db  # noqa: E402
from app.models.bank_account import BankAccount  # noqa: E402
from app.models.deposit import Deposit  # noqa: E402
from app.models.expense import Expense  # noqa: E402
from app.models.owner import Owner  # noqa: E402
from app.models.property import Property  # noqa: E402
from app.services.client_import import (  # noqa: E402
    CLIENT_DATA_DIR,
    import_client_data,
)
from app.services.client_import_verify import verify_against_excel  # noqa: E402


def reset_database() -> None:
    """Drop and recreate all tables (local SQLite / empty-prod only)."""
    Base.metadata.drop_all(bind=engine)
    init_db()
    print("Database tables recreated.")


def print_db_counts(db) -> None:
    counts = {
        "owners": db.scalar(select(func.count()).select_from(Owner)) or 0,
        "properties": db.scalar(select(func.count()).select_from(Property)) or 0,
        "bank_accounts": db.scalar(select(func.count()).select_from(BankAccount)) or 0,
        "expenses": db.scalar(select(func.count()).select_from(Expense)) or 0,
        "deposits": db.scalar(select(func.count()).select_from(Deposit)) or 0,
    }
    print("Database counts:", json.dumps(counts, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Import client Excel data")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Drop all tables and re-import from ClientData",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Only compare DB counts to Excel source totals",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=CLIENT_DATA_DIR,
        help="Path to ClientData folder",
    )
    args = parser.parse_args()

    init_db()

    if args.verify_only:
        db = SessionLocal()
        try:
            report = verify_against_excel(db, args.data_dir)
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0 if report.get("ok") else 1
        finally:
            db.close()

    if args.reset:
        reset_database()

    if not args.data_dir.exists():
        print(f"ERROR: data dir not found: {args.data_dir}")
        return 1

    db = SessionLocal()
    try:
        stats = import_client_data(db, data_dir=args.data_dir)
        print("Import stats:", json.dumps(stats.to_dict(), ensure_ascii=False, indent=2))
        print_db_counts(db)
        report = verify_against_excel(db, args.data_dir)
        print("Verification:", json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report.get("ok") else 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
