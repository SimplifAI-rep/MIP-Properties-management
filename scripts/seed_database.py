#!/usr/bin/env python3
"""Seed the database with reference owners, properties, and bank accounts."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.services.seed import seed_reference_data  # noqa: E402


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        counts = seed_reference_data(db)
        print("Database seeded successfully:")
        for key, value in counts.items():
            if value:
                print(f"  {key}: {value} created")
            else:
                print(f"  {key}: already present (skipped)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
