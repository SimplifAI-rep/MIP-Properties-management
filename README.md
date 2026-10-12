# SimplifAI — Property Asset Management

Web app for property managers to track owner and property money (ILS): enter receipts as they arrive, then verify them against bank and credit-card statements.

**Current status:** In use locally and in production (Vercel frontend, Render API with persistent SQLite). Clients use the app without signing in. Staff sign in as **Admin** for import, bank settings, alert rules, and database reset.

## How the app is used

1. An admin loads the **client list** and **management ledger** Excel files on Data Import (empty database on first run).
2. Day to day, receipts go in on **Transactions** (manual or file upload). Rows can be tagged as rental income, He/She paid, owner-paid, or paid with a card.
3. At period end, upload the **bank Excel** on Verification. If that statement includes a card settlement, upload the matching **card Excel** next.
4. Confirm suggested matches. For leftovers: create (with a real owner/property), merge, or ignore. Finish the period when the lists are clear and the gap is within tolerance.
5. Use **Alerts**, **Next cycle**, and **Reports** to follow leftovers, deferred card charges, and owner/property totals.

## Features

- **Verification** — bank statement as ground truth, optional card statement, period history, and a finishable gap
- **Transactions** — unified deposits and expenses, type/date/owner/property filters, inline edit, attachments, CSV export
- **Alerts** — missing deposits, incomplete imports, unmatched bank/card rows, unverified-for-more-than-a-month
- **Data Import** — ClientData Excel from the UI (no auto-seed on startup)
- **Credit cards** — last-4 and labels; cards also appear when a card statement is uploaded
- **AI querying** — natural-language questions (rule-based; optional OpenAI via `LLM_API_KEY`)
- **Feedback** — in-app form emailed via SMTP
- **Dark mode** — toggle in the sidebar

**Not in this product yet:** per-client login / multi-tenant auth. Reports is still a basic owner/property summary. Storage is SQLite (local file, or a Render disk in production).

## Pages

| Page | URL | Who | What you can do |
|------|-----|-----|-----------------|
| Dashboard | `/` | all | Period totals, deposit gaps, verification status, recent activity |
| Properties | `/properties` | all | Property list + detail, balances, jump to transactions |
| Owners | `/owners` | all | Owner list + detail, balances, jump to transactions |
| Transactions | `/transactions` | all | Deposits/expenses, filters, add/edit, attachments, CSV export |
| Verification | `/verification` | all | Upload bank then card Excel, match leftovers, finish the period |
| Next cycle | `/next-cycle` | all | Card charges waiting for the next statement |
| Credit cards | `/credit-cards` | all | Add, rename, or deactivate cards |
| Alerts | `/alerts` | all | Review and resolve alerts |
| Reports | `/reports` | all | Owner and property totals |
| Data import | `/data-import` | admin | Upload ClientData Excel; optional database reset |
| Bank settings | `/admin/bank-settings` | admin | Opening balance, last verification date, go-live cutover |
| Alert rules | `/admin/alert-rules` | admin | Low-balance thresholds (global and per property) |
| AI Query | `/ai` | all | Natural-language questions |

Admin pages are hidden until you sign in from **Admin** in the sidebar.

## Documentation

- **[docs/DEPLOY.md](docs/DEPLOY.md)** — Vercel frontend + Render API (persistent SQLite disk)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.12+, FastAPI, SQLAlchemy |
| Database | SQLite (`simplifai.db` at project root by default) |
| Frontend | React, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router |
| Auth | Admin password (`ADMIN_PASSWORD`); clients are unsigned-in |

## Project Structure

```
SimplifAI/
├── backend/          # FastAPI API
├── frontend/         # React web UI
├── data/             # Optional ClientData / seed fixtures
├── scripts/          # Dev startup + optional CLI import tools
├── docs/             # Deploy guide
├── storage/          # Uploaded files (local)
└── simplifai.db      # SQLite database (created on first run)
```

## Quick Start — One Command

**Prerequisites:** Python 3.12+, Node.js 18+, git

From the **project root**:

```powershell
# Windows
.\start.ps1

# macOS / Linux
chmod +x start.sh
./start.sh

# Or directly with Python
python scripts/start_dev.py
```

The script will:

1. Create `backend/.venv` and install Python dependencies (first run)
2. Run `npm install` in `frontend/` (first run)
3. Start the API on http://127.0.0.1:8000
4. Start the web UI on http://localhost:5173

The database starts **empty** (tables only). Load data via **Data Import** in the UI (admin).

Press **Ctrl+C** to stop both servers.

> **Note:** If ports 8000/5173 are busy, the script picks the next free port. Use the URLs printed in the terminal.

## Quick Start — Manual Steps

### 1. Start the API

```powershell
cd backend
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: http://127.0.0.1:8000/docs

### 2. Start the web UI

```powershell
cd frontend
npm install
npm run dev
```

Open: **http://localhost:5173**

## Troubleshooting

### Ports already in use

```powershell
.\stop.ps1
```

Or let `.\start.ps1` choose the next free port and open the URLs it prints.

Always stop with **Ctrl+C** in the terminal where `.\start.ps1` is running.

## Tests and utility scripts

```powershell
# Backend tests
cd backend
.\.venv\Scripts\python.exe -m pytest

# Frontend lint + production build
cd frontend
npm run lint
npm run build

# Inspect database contents (from project root)
backend\.venv\Scripts\python.exe scripts\inspect_database.py

# CLI ClientData import (UI import is preferred)
backend\.venv\Scripts\python.exe scripts\import_client_data.py --reset
```

## Environment

Copy `.env.example` to `.env` at the project root.

- **Database:** leave `DATABASE_URL` unset to use `simplifai.db` at the project root (recommended). Relative SQLite URLs resolve from process cwd and can point at the wrong file.
- **Frontend API URL:** `frontend/.env` → `VITE_API_BASE_URL=http://localhost:8000/api/v1`
- **Admin:** `ADMIN_PASSWORD` (required to sign in as admin and to reset the database)
- **AI:** optional `LLM_API_KEY`
- **Feedback email:** SMTP settings in `.env`

See [docs/DEPLOY.md](docs/DEPLOY.md) for production deploy notes (Vercel frontend + Render backend with **persistent SQLite disk**).
