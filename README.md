# SimplifAI — Property Asset Management

Web app for property managers to track deposits, expenses, documents, and alerts on behalf of owners.

**Current status:** Full local MVP — Dashboard, Properties, Owners, Transactions, Alerts, Data Import, uploads, feedback, and AI query.

## Features

- **Transactions** — unified deposits + expenses, filters, inline edit, CSV export
- **Data Import** — upload ClientData Excel files from the UI (no auto-seed on startup)
- **Receipt / file upload** — analyze PDFs/images/Excel, confirm drafts, download linked files
- **Alerts** — missing deposits, incomplete import rows, resolve/dismiss flows
- **AI querying** — natural-language questions (rule-based; optional OpenAI via `LLM_API_KEY`)
- **Feedback** — in-app form emailed via SMTP

**Not yet implemented:** multi-tenant auth, durable cloud DB/storage for production (SQLite is fine locally).

## Documentation

- **[docs/DEPLOY.md](docs/DEPLOY.md)** — Vercel + Render deploy
- **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** — historical architecture plan (partially outdated)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.12+, FastAPI, SQLAlchemy |
| Database | SQLite (`simplifai.db` at project root by default) |
| Frontend | React, TypeScript, Vite, Tailwind CSS, TanStack Query |

## Project Structure

```
SimplifAI/
├── backend/          # FastAPI API
├── frontend/         # React web UI
├── data/             # Optional ClientData / seed fixtures
├── scripts/          # Dev startup + optional CLI import tools
├── docs/             # Deploy + planning docs
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

The database starts **empty** (tables only). Load data via **Data Import** in the UI.

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

### 3. Pages

| Page | URL | What you can do |
|------|-----|-----------------|
| Dashboard | `/` | Period totals, gaps, recent activity |
| Properties | `/properties` | Property list + detail |
| Owners | `/owners` | Owner list + detail |
| Transactions | `/transactions` | Deposits/expenses, upload, edit |
| Alerts | `/alerts` | Review and resolve alerts |
| Data Import | `/data-import` | Upload ClientData Excel packs |
| AI Query | `/ai` | Natural-language questions |

## Troubleshooting

### Ports already in use

```powershell
.\stop.ps1
```

Or let `.\start.ps1` choose the next free port and open the URLs it prints.

Always stop with **Ctrl+C** in the terminal where `.\start.ps1` is running.

## Utility Scripts (optional)

```powershell
# Inspect database contents
backend\.venv\Scripts\python.exe scripts\inspect_database.py

# CLI ClientData import (UI import is preferred)
backend\.venv\Scripts\python.exe scripts\import_client_data.py --reset

# Tests
cd backend
..\.venv\Scripts\python.exe -m pytest -v
```

## Environment

Copy `.env.example` to `.env` at the project root.

- **Database:** leave `DATABASE_URL` unset to use `simplifai.db` at the project root (recommended). Relative SQLite URLs resolve from process cwd and can point at the wrong file.
- **Frontend API URL:** `frontend/.env` → `VITE_API_BASE_URL=http://localhost:8000/api/v1`
- **AI:** optional `LLM_API_KEY`
- **Feedback email:** SMTP settings in `.env`

See [docs/DEPLOY.md](docs/DEPLOY.md) for production deploy notes.
