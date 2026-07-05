# SimplifAI — Property Asset Management

A property asset management platform for tracking income, expenses, documents, and financial analysis on behalf of property owners.

**Current status:** MVP web UI + AI query layer — view deposits, ask natural-language questions.

## MVP Scope (Phase 1)

- **Bank deposits** — import simulated deposit data from Excel, view and filter by property/owner/date
- **Gap detection** — compare expected vs actual owner deposits per property
- **Web UI** — Dashboard, Properties, Deposits, AI Query pages
- **AI querying** — natural-language deposit questions (rule-based parser; optional OpenAI via `LLM_API_KEY`)

**Not yet implemented:** expenses, credit cards, document ingestion, alerts, trend analysis, multi-tenant auth.

## Documentation

**[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** — full architecture, data model, API design, and phased checklists.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.14, FastAPI, SQLAlchemy |
| Database | SQLite (`simplifai.db` at project root) |
| Frontend | React, TypeScript, Vite, Tailwind CSS, TanStack Query |
| Seed data | Excel (`.xlsx`) → import script → database |

## Project Structure

```
SimplifAI/
├── backend/          # FastAPI API
├── frontend/         # React web UI
├── data/seed/        # Simulated bank deposit Excel/CSV
├── scripts/          # Import, seed, inspect utilities
├── docs/             # Implementation specification
└── simplifai.db      # SQLite database (after import)
```

## Quick Start — One Command

**Prerequisites:** Python 3.12+, Node.js 18+, git

Clone the repo, then from the **project root**:

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
3. Seed the database and import sample deposits **if empty**
4. Start the API on http://127.0.0.1:8000
5. Start the web UI on http://localhost:5173

Press **Ctrl+C** to stop both servers.

> **Note:** If ports 8000/5173 are busy, the script automatically uses the next free port (e.g. 8002, 5174). Check the terminal output for the actual URLs.

---

## Quick Start — Manual Steps

### 1. Load sample data (first time only)

From the **project root**:

```powershell
cd c:\Users\Administrator\Desktop\SimplifAI

# Generate Excel seed file (if not already present)
backend\.venv\Scripts\python.exe scripts\generate_bank_deposits.py

# Seed owners/properties/accounts and import 15 deposits
backend\.venv\Scripts\python.exe scripts\import_deposits.py data\seed\bank_deposits.xlsx --seed
```

### 2. Start the API server

```powershell
cd backend
.\.venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port 8000
```

API docs: http://127.0.0.1:8000/docs

### 3. Start the web UI

In a **second terminal**:

```powershell
cd frontend
npm install
npm run dev
```

Open: **http://localhost:5173**

### 4. Pages

| Page | URL | What you can do |
|------|-----|-----------------|
| Dashboard | `/` | Total deposits, counts, March 2026 gap alert |
| Properties | `/properties` | List properties, click row for detail panel |
| Deposits | `/deposits` | Filter by property/owner/date, export CSV |
| AI Query | `/ai` | Ask natural-language questions about deposits |

## Troubleshooting

### Ports already in use / can't kill processes

Old dev servers often run in **hidden Cursor or VS Code terminal tabs** — `netstat` shows PIDs that `Stop-Process` can't find because those terminals own the process.

**Option 1 — Use the stop script:**
```powershell
.\stop.ps1
```

**Option 2 — Close terminal tabs in Cursor/VS Code** that are running `uvicorn` or `npm run dev` (look for old agent/background terminals).

**Option 3 — Just run start anyway** — `.\start.ps1` now **automatically picks the next free port** if 8000 or 5173 are busy. Watch the output:
```
[start] Port 8000 is busy — using API port 8002
  Web UI:  http://localhost:5173
  API:     http://127.0.0.1:8002
```
Open the URLs printed in **your current terminal**, not an old bookmark.

**Option 4 — Nuclear option (reboot)** clears ghost sockets if nothing else works.

Always stop dev servers with **Ctrl+C** in the terminal where `.\start.ps1` is running.

## Utility Scripts

```powershell
# Inspect database contents in the terminal
backend\.venv\Scripts\python.exe scripts\inspect_database.py

# Run import tests
cd backend
..\.venv\Scripts\python.exe -m pytest tests\test_bank_import.py -v
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Health check |
| GET | `/api/v1/owners` | List owners |
| GET | `/api/v1/properties` | List properties with deposit totals |
| GET | `/api/v1/properties/{id}` | Property detail |
| GET | `/api/v1/deposits` | Paginated deposits with filters |
| GET | `/api/v1/deposits/summary` | Dashboard summary |
| GET | `/api/v1/deposits/gaps` | Missing expected deposits |
| POST | `/api/v1/imports/deposits` | Upload Excel file |
| POST | `/api/v1/ai/query` | Natural-language deposit query |

### AI Query examples

```json
POST /api/v1/ai/query
{ "question": "Show all deposits for Rothschild 12 in Q1 2026" }
```

Works without an API key (rule-based parser). Set `LLM_API_KEY` in `.env` for OpenAI-powered parsing.

## Environment

- Backend DB path is fixed to `simplifai.db` at the project root (not relative to cwd).
- Frontend API URL: `frontend/.env` → `VITE_API_BASE_URL=http://localhost:8000/api/v1`

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full phase-by-phase roadmap.
