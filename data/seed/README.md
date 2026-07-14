# Seed data

Production bootstrap now loads **client Excel files** from `data/ClientData/`
(see `backend/app/services/client_import.py` and `scripts/import_client_data.py`).

## Legacy demo files

| File | Status |
|------|--------|
| `bank_deposits.xlsx` / `.csv` | Legacy MVP demo — no longer used by bootstrap |
| `client_demo/` | Upload UI demo templates only |

## Re-import client data

```bash
# Wipe local DB and reload all client Excel files
python scripts/import_client_data.py --reset

# Re-run import idempotently (skips existing import_keys)
python scripts/import_client_data.py

# Compare DB totals to Excel source rows
python scripts/import_client_data.py --verify-only
```
