# SimplifAI — Property Asset Management

A property asset management platform for tracking income, expenses, documents, and financial analysis on behalf of property owners.

**Current status:** MVP web UI running — view deposits, properties, and gap detection via browser.

## MVP Scope (Phase 1)

- **Bank deposits** — import simulated deposit data from Excel, view and filter by property/owner/date
- **Gap detection** — compare expected vs actual owner deposits per property
- **Web UI** — Dashboard, Properties, Deposits pages
- **AI querying** — planned for Phase 4 (placeholder page in UI)

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

## Quick Start — Web UI

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
| AI Query | `/ai` | Placeholder for Phase 4 |

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

## Environment

- Backend DB path is fixed to `simplifai.db` at the project root (not relative to cwd).
- Frontend API URL: `frontend/.env` → `VITE_API_BASE_URL=http://localhost:8000/api/v1`

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full phase-by-phase roadmap.
