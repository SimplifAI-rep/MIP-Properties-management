# Simulated Bank Deposit Data

This folder contains sample bank deposit transactions for MVP development and testing.

## Files

| File | Description |
|------|-------------|
| `bank_deposits.xlsx` | Primary seed file for import (Excel format) |
| `bank_deposits.csv` | Human-readable copy of the same data |
| `README.md` | This document |

## Excel Column Template

| Column | Required | Type | Example |
|--------|----------|------|---------|
| `account_number` | Yes | string | `12-345-678901` |
| `transaction_date` | Yes | date | `2026-01-05` |
| `amount` | Yes | decimal | `8500.00` |
| `currency` | No | string | `ILS` (default) |
| `reference` | No | string | `DEP-2026-001` |
| `description` | No | string | `Owner deposit - January` |

## Reference Data (Database Seed)

These account numbers map to properties via `scripts/seed_database.py`:

| Owner | Property | Account Number | Expected Monthly Deposit |
|-------|----------|----------------|--------------------------|
| David Cohen | Rothschild 12, Tel Aviv | `12-345-678901` | ₪8,500 (due day 5) |
| David Cohen | Dizengoff 45, Tel Aviv | `12-345-678902` | ₪6,200 (due day 5) |
| Sarah Levi | Herzl 8, Haifa | `99-888-777001` | ₪4,800 (due day 10) |

## Intentional Data Gap

**Dizengoff 45** has deposits in January, February, and April 2026, but **no deposit in March 2026**. This supports testing:

- `GET /api/v1/deposits/gaps?year=2026&month=3` (future API)
- AI `gap_analysis` queries such as *"Which properties had no deposit in March 2026?"*

## Dataset Summary

- **15 deposit rows** across 3 properties
- **Date range:** January 2026 – May 2026
- Includes one extra/supplemental deposit per property (repair reimbursement, utility refund, insurance refund)

## Regenerate Seed Files

```bash
cd backend
pip install -r requirements.txt
cd ..
python scripts/generate_bank_deposits.py
```

## Import into Database

```bash
# Seed reference data + import deposits
python scripts/import_deposits.py data/seed/bank_deposits.xlsx --seed

# Re-run import (should skip all duplicates)
python scripts/import_deposits.py data/seed/bank_deposits.xlsx
```

Expected first-run output:

```
Import complete: bank_deposits.xlsx
  Rows processed: 15
  Imported:       15
  Skipped:        0 (duplicates)
  Errors:         0
```

Expected second-run output:

```
  Imported:       0
  Skipped:        15 (duplicates)
```
