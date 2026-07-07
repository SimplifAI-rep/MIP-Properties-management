# Client demo upload files (July 2026)

Use these files to test **Transactions → Import from file** without changing the main seed database.

## Files

| File | Type | Property selection on upload |
|------|------|------------------------------|
| `client_demo_deposits_july2026.xlsx` | Deposit | Any (rows map via account number) |
| `client_demo_expenses_rothschild_july2026.xlsx` | Expense | **Rothschild 12, Tel Aviv** |
| `client_demo_expenses_dizengoff_july2026.xlsx` | Expense | **Dizengoff 45, Tel Aviv** |
| `client_demo_expenses_herzl_july2026.xlsx` | Expense | **Herzl 8, Haifa** |
| `client_demo_upload.xlsx` | Workbook | Same data split across sheets |

## Deposits file (4 rows)

- July monthly deposits for all 3 properties (fixes “Missing” status on dashboard for July 2026)
- One extra Rothschild reimbursement row

References `DEP-2026-018` … `DEP-2026-021` — safe to import; will not duplicate existing seed rows.

## Expenses files (3 rows each)

Upload **once per property**, selecting the matching property in the upload form.

## Steps

1. Go to **Transactions** → **Import from file**
2. Choose property and type (Deposit or Expense)
3. Select the matching `.xlsx` file
4. Click **Analyze file** → review rows → **Confirm**
5. Check **Dashboard** (July 2026), **Transactions**, and **Alerts**

## Regenerate

```bash
python scripts/generate_client_upload_demo.py
```
