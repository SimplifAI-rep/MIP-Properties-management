#!/usr/bin/env python3
"""Generate the simulated bank deposits Excel seed file."""

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.services.seed import ACCOUNT_DIZENGOFF, ACCOUNT_HERZL, ACCOUNT_ROTHSCHILD

DEPOSITS = [
    # Rothschild 12 — monthly deposits on the 5th
    (ACCOUNT_ROTHSCHILD, "2026-01-05", 8500.00, "ILS", "DEP-2026-001", "Owner deposit - January"),
    (ACCOUNT_ROTHSCHILD, "2026-02-05", 8500.00, "ILS", "DEP-2026-002", "Owner deposit - February"),
    (ACCOUNT_ROTHSCHILD, "2026-02-15", 1200.00, "ILS", "DEP-2026-003", "Repair reimbursement"),
    (ACCOUNT_ROTHSCHILD, "2026-03-05", 8500.00, "ILS", "DEP-2026-004", "Owner deposit - March"),
    (ACCOUNT_ROTHSCHILD, "2026-04-05", 8500.00, "ILS", "DEP-2026-005", "Owner deposit - April"),
    # Dizengoff 45 — March deposit intentionally missing
    (ACCOUNT_DIZENGOFF, "2026-01-05", 6200.00, "ILS", "DEP-2026-006", "Owner deposit - January"),
    (ACCOUNT_DIZENGOFF, "2026-02-05", 6200.00, "ILS", "DEP-2026-007", "Owner deposit - February"),
    (ACCOUNT_DIZENGOFF, "2026-01-20", 500.00, "ILS", "DEP-2026-008", "Utility adjustment refund"),
    (ACCOUNT_DIZENGOFF, "2026-04-05", 6200.00, "ILS", "DEP-2026-009", "Owner deposit - April"),
    # NEW: March deposit added — fills the previous gap
    (ACCOUNT_DIZENGOFF, "2026-03-05", 6200.00, "ILS", "DEP-2026-016", "Owner deposit - March"),
    # Herzl 8 — monthly deposits on the 10th
    (ACCOUNT_HERZL, "2026-01-10", 4800.00, "ILS", "DEP-2026-010", "Owner deposit - January"),
    (ACCOUNT_HERZL, "2026-02-10", 4800.00, "ILS", "DEP-2026-011", "Owner deposit - February"),
    (ACCOUNT_HERZL, "2026-03-10", 4800.00, "ILS", "DEP-2026-012", "Owner deposit - March"),
    (ACCOUNT_HERZL, "2026-03-25", 300.00, "ILS", "DEP-2026-013", "Insurance refund"),
    (ACCOUNT_HERZL, "2026-04-10", 4800.00, "ILS", "DEP-2026-014", "Owner deposit - April"),
    (ACCOUNT_HERZL, "2026-05-10", 4800.00, "ILS", "DEP-2026-015", "Owner deposit - May"),
    # NEW: extra deposit for Rothschild
    (ACCOUNT_ROTHSCHILD, "2026-06-05", 8500.00, "ILS", "DEP-2026-017", "Owner deposit - June"),
]

OUTPUT_PATH = Path(__file__).resolve().parents[1] / "data" / "seed" / "bank_deposits.xlsx"
CSV_OUTPUT_PATH = Path(__file__).resolve().parents[1] / "data" / "seed" / "bank_deposits.csv"


def main() -> None:
    df = pd.DataFrame(
        DEPOSITS,
        columns=[
            "account_number",
            "transaction_date",
            "amount",
            "currency",
            "reference",
            "description",
        ],
    )
    df["transaction_date"] = pd.to_datetime(df["transaction_date"])

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_excel(OUTPUT_PATH, index=False)
    df.to_csv(CSV_OUTPUT_PATH, index=False)

    print(f"Wrote {len(df)} rows to {OUTPUT_PATH}")
    print(f"Wrote {len(df)} rows to {CSV_OUTPUT_PATH}")


if __name__ == "__main__":
    main()
