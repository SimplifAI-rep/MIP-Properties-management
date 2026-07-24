# Seed data

The app **does not auto-seed** on startup. Production and local runs start with empty tables; load data via **Data Import** in the web UI.

Optional CLI tools (for tests / local experiments only):

```bash
# Wipe local DB and reload from a ClientData folder
python scripts/import_client_data.py --reset

# Re-run import idempotently (skips existing import_keys)
python scripts/import_client_data.py

# Compare DB totals to Excel source rows
python scripts/import_client_data.py --verify-only
```

## Files in this folder

| File | Status |
|------|--------|
| `bank_deposits.xlsx` / `.csv` | Legacy demo for unit tests / old CLI import |
| `client_demo/` | Upload UI demo templates only |
