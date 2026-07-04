# SimplifAI — Property Asset Management

A property asset management platform for tracking income, expenses, documents, and financial analysis on behalf of property owners.

**Current status:** Greenfield project — implementation specification complete; application code not yet started.

## MVP Scope (Phase 1)

The first deliverable is a **small prototype** focused on:

- **Bank deposits** — import simulated deposit data from Excel, view and filter by property/owner/date
- **Gap detection** — compare expected vs actual owner deposits per property
- **AI querying** — ask natural-language questions about deposit data

**Not in MVP:** expenses, credit cards, document ingestion, alerts, trend analysis, or multi-tenant auth.

## Documentation

Full implementation specification (architecture, data model, API design, frontend design, and phased checklists):

**[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)**

## Planned Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.12, FastAPI, SQLAlchemy, Alembic |
| Database | PostgreSQL (SQLite for local dev) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| AI | LLM API with structured query intents (no raw SQL) |
| Seed data | Excel (`.xlsx`) → import script → database |

## Project Structure (Planned)

```
SimplifAI/
├── docs/           # Implementation specification
├── backend/        # FastAPI application
├── frontend/       # React SPA
├── data/seed/      # Simulated bank data (Task 2)
└── scripts/        # Import and utility scripts
```

## Next Steps

1. **Phase 0** — Scaffold backend and frontend projects (see checklist in implementation plan)
2. **Task 2** — Create `data/seed/bank_deposits.xlsx` with simulated deposit rows
3. **Phase 1–6** — Build database, API, AI layer, and UI per the implementation checklist

## Local Development (Once Scaffolded)

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for environment variables, API endpoints, and full phase-by-phase checklists.
