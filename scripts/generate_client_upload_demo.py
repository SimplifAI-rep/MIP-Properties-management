#!/usr/bin/env python3
"""Generate Excel files for client demo / manual upload testing."""

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "seed" / "client_demo"

ACCOUNT_ROTHSCHILD = "12-345-678901"
ACCOUNT_DIZENGOFF = "12-345-678902"
ACCOUNT_HERZL = "99-888-777001"

DEPOSIT_ROWS = [
    (ACCOUNT_ROTHSCHILD, "2026-07-05", 8500.00, "ILS", "DEP-2026-018", "Owner deposit - July"),
    (ACCOUNT_DIZENGOFF, "2026-07-05", 6200.00, "ILS", "DEP-2026-019", "Owner deposit - July"),
    (ACCOUNT_HERZL, "2026-07-10", 4800.00, "ILS", "DEP-2026-020", "Owner deposit - July"),
    (ACCOUNT_ROTHSCHILD, "2026-07-18", 950.00, "ILS", "DEP-2026-021", "Parking fee reimbursement"),
]

EXPENSE_COLUMNS = [
    "transaction_date",
    "amount",
    "currency",
    "category",
    "source",
    "payment_method",
    "vendor_name",
    "reference",
    "description",
]

EXPENSES_BY_PROPERTY = {
    "rothschild": [
        ("2026-07-08", 445.00, "ILS", "utilities", "standing_order", "bank_direct_debit", "Israel Electric Corp", "SO-EL-202607", "July electricity bill"),
        ("2026-07-14", 780.00, "ILS", "maintenance", "manual_company", "company_account", "TLV Plumbing Ltd", None, "AC unit service"),
        ("2026-07-22", 120.00, "ILS", "management_fee", "standing_order", "bank_direct_debit", "Cohen Property Mgmt", "SO-MGMT-07", "Monthly management fee"),
    ],
    "dizengoff": [
        ("2026-07-06", 315.00, "ILS", "utilities", "standing_order", "bank_direct_debit", "Municipal Water", "SO-WATER-07", "July water bill"),
        ("2026-07-12", 2100.00, "ILS", "insurance", "credit_card", "credit_card", "Harel Insurance", "CC-45201", "Mid-year insurance adjustment"),
        ("2026-07-25", 540.00, "ILS", "tax", "manual_company", "company_account", "Tel Aviv Municipality", "ARN-2027-07", "Arnona municipal tax Q3"),
    ],
    "herzl": [
        ("2026-07-09", 385.00, "ILS", "utilities", "standing_order", "bank_direct_debit", "Israel Electric Corp", "SO-EL-H-07", "July electricity"),
        ("2026-07-16", 650.00, "ILS", "maintenance", "manual_owner", "owner_personal", "Haifa Elevator Co", None, "Elevator inspection — owner paid"),
        ("2026-07-28", 95.00, "ILS", "other", "manual_company", "company_account", "Office Depot", "INV-8831", "Cleaning supplies"),
    ],
}


def deposits_df() -> pd.DataFrame:
    df = pd.DataFrame(
        DEPOSIT_ROWS,
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
    return df


def expenses_df(rows: list[tuple]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=EXPENSE_COLUMNS)
    df["transaction_date"] = pd.to_datetime(df["transaction_date"])
    return df


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    deposits = deposits_df()
    deposits_path = OUT_DIR / "client_demo_deposits_july2026.xlsx"
    deposits.to_excel(deposits_path, index=False, sheet_name="Deposits")
    deposits.to_csv(OUT_DIR / "client_demo_deposits_july2026.csv", index=False)

    workbook_path = OUT_DIR / "client_demo_upload.xlsx"
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        deposits.to_excel(writer, index=False, sheet_name="Deposits")
        for property_key, rows in EXPENSES_BY_PROPERTY.items():
            expenses_df(rows).to_excel(writer, index=False, sheet_name=f"Expenses_{property_key}")

    for property_key, rows in EXPENSES_BY_PROPERTY.items():
        path = OUT_DIR / f"client_demo_expenses_{property_key}_july2026.xlsx"
        expenses_df(rows).to_excel(path, index=False, sheet_name="Expenses")

    print(f"Created upload demo files in {OUT_DIR}")
    print(f"  Deposits: {len(deposits)} rows -> {deposits_path.name}")
    for property_key, rows in EXPENSES_BY_PROPERTY.items():
        print(f"  Expenses ({property_key}): {len(rows)} rows")


if __name__ == "__main__":
    main()
