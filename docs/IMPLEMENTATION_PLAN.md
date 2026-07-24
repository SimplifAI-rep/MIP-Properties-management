# Property Asset Management — Implementation Specification

> **Status:** Historical planning doc. The running app has moved past this MVP outline
> (expenses, alerts, Data Import UI, no auto-seed). Prefer root `README.md` and
> `docs/DEPLOY.md` for current setup.

> **Document type:** Implementation plan (מסמך אפיון)  
> **Language:** English  
> **Last updated:** July 2026  
> **MVP scope:** Bank deposits + AI natural-language querying only

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Technology Stack](#2-technology-stack)
3. [System Architecture](#3-system-architecture)
4. [Backend Design](#4-backend-design)
5. [Frontend Design](#5-frontend-design)
6. [Data Model](#6-data-model)
7. [Project Structure](#7-project-structure)
8. [Environment and Configuration](#8-environment-and-configuration)
9. [Implementation Checklist](#9-implementation-checklist)
10. [Future Phases](#10-future-phases)
11. [Known Limitations (MVP)](#11-known-limitations-mvp)

---

## 1. Overview and Goals

### 1.1 Problem Statement

A property management company receives properties from one or more property owners and manages all financial activity related to those assets — expenses, income, supporting documents, and analysis. The full system must provide:

- **Complete control** over property-linked financial data
- **Transparency** for owners and managers
- **Financial analysis** across all activity

The central entity is the **Property**, identified by a unique key (`property_id`). Each property is linked to an owner, bank/credit accounts, documents, and classified transactions (expenses and income).

### 1.2 Full System Vision (Requirements Summary)

| Domain | Capabilities |
|--------|-------------|
| **Expenses** | Standing orders (bank + credit card), manual payments by owner or company, intake via email/WhatsApp/receipts |
| **Income** | Track owner deposits, assign to properties, detect gaps vs expected deposits |
| **Database** | Properties, owners, accounts, documents, transactions |
| **Data intake** | Bank statements, credit card statements, emails, WhatsApp, invoices/receipts |
| **Organization** | Folder structure by property, owner, and document type |
| **Reporting** | Reports by property, date range, and category; alerts; trend analysis |

### 1.3 MVP Goals (Phase 1)

The MVP is a **small, focused prototype** that proves the core value loop for **income tracking**:

| Goal | Description |
|------|-------------|
| **View deposits** | List and filter bank deposits by property, owner, and date range |
| **Import bank data** | Load simulated deposit data from Excel into the database |
| **Detect gaps** | Compare expected deposits against actual deposits per property |
| **AI querying** | Ask natural-language questions about deposit data and receive structured answers |

### 1.4 MVP Success Criteria

- [ ] At least 3 sample properties with owners and linked bank accounts exist in the database
- [ ] Excel import loads deposit rows and maps them to the correct property via account number
- [ ] UI displays deposits with working filters (property, owner, date range)
- [ ] Gap report identifies at least one intentionally missing expected deposit in seed data
- [ ] AI endpoint answers 5 sample questions correctly (see [AI Query Examples](#94-sample-ai-prompts-mvp))
- [ ] AI refuses out-of-scope questions (expenses, credit cards) with a clear message

### 1.5 Out of Scope for Phase 1 (MVP)

The following are **documented for future phases** but must **not** be implemented in the MVP:

- Expense tracking (standing orders, bank charges, credit card line items)
- Manual payment intake (email, WhatsApp, receipt upload)
- Document OCR, classification, or folder management
- Alerts engine (low balance, unusual charges, scheduled jobs)
- Trend analysis and anomaly detection
- PDF/Excel report generation
- Multi-tenant authentication and role-based access control
- Hebrew RTL user interface

---

## 2. Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Backend** | Python 3.12 + FastAPI | Fast development; strong ecosystem for AI, Excel import, and future document parsing |
| **Database** | PostgreSQL (SQLite for local dev) | Relational model fits properties, owners, accounts, and transactions; supports reporting |
| **ORM** | SQLAlchemy 2.x + Alembic | Schema migrations from day one; scales with checklist growth |
| **Frontend** | React 18 + TypeScript + Vite | Lightweight SPA for deposit table and AI chat; scales to full admin UI |
| **UI components** | Tailwind CSS + shadcn/ui | Consistent tables, forms, and layout without heavy custom CSS |
| **Server state** | TanStack React Query | Caching, loading states, and refetch for API-driven UI |
| **AI layer** | LLM API (OpenAI / Azure OpenAI / compatible) | Natural-language questions translated to safe, validated query intents |
| **Simulated bank data** | Excel (`.xlsx`) → import script → DB | Easy for stakeholders to edit; matches Task 2 deliverable |
| **File storage (later)** | Local `storage/` → S3-compatible | Not required for MVP |

### 2.1 Key Design Principles

1. **Structured AI, not raw SQL** — The LLM outputs a validated JSON intent object; the backend runs predefined query templates only.
2. **Idempotent imports** — Re-importing the same Excel file must not create duplicate deposits.
3. **Property-centric data** — Every deposit is attributed to a property (and transitively to an owner).
4. **Checklist-driven delivery** — Each phase has a Definition of Done; no phase is complete until its checklist is satisfied.

---

## 3. System Architecture

### 3.1 High-Level Diagram

```mermaid
flowchart TB
    subgraph frontend [Frontend_React]
        DepositTable[DepositTable]
        AIChat[AIQueryPanel]
        PropertyList[PropertyOwnerViews]
        Dashboard[Dashboard]
    end

    subgraph backend [Backend_FastAPI]
        API[REST_API]
        ImportSvc[BankImportService]
        QuerySvc[DepositQueryService]
        AISvc[AIQueryService]
    end

    subgraph data [Data_Layer]
        DB[(PostgreSQL)]
        SeedExcel[Seed_Excel]
    end

    subgraph external [External]
        LLM[LLM_API]
    end

    Dashboard --> API
    DepositTable --> API
    AIChat --> API
    PropertyList --> API
    API --> QuerySvc
    API --> ImportSvc
    API --> AISvc
    ImportSvc --> DB
    QuerySvc --> DB
    AISvc --> QuerySvc
    AISvc --> LLM
    SeedExcel --> ImportSvc
```

### 3.2 Request Flow — AI Query

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant API
    participant AISvc as AIQueryService
    participant LLM
    participant QuerySvc as DepositQueryService
    participant DB

    User->>Frontend: Ask question
    Frontend->>API: POST /api/v1/ai/query
    API->>AISvc: parse_question(text)
    AISvc->>LLM: system prompt + question
    LLM-->>AISvc: DepositQueryIntent JSON
    AISvc->>AISvc: validate intent against whitelist
    alt intent invalid or out of scope
        AISvc-->>API: error / refusal message
    else intent valid
        AISvc->>QuerySvc: execute_template(intent)
        QuerySvc->>DB: parameterized query
        DB-->>QuerySvc: rows
        QuerySvc-->>AISvc: structured data
        AISvc->>LLM: summarize results (optional)
        AISvc-->>API: answer + data + query_used
    end
    API-->>Frontend: JSON response
    Frontend-->>User: table + natural-language answer
```

### 3.3 Request Flow — Excel Import

```mermaid
sequenceDiagram
    participant User
    participant API
    participant ImportSvc as BankImportService
    participant DB

    User->>API: POST /api/v1/imports/deposits (file)
    API->>ImportSvc: parse_excel(file)
    ImportSvc->>ImportSvc: validate rows
    ImportSvc->>DB: lookup bank_accounts by account_number
    alt orphan account
        ImportSvc-->>API: row errors collected
    else valid
        ImportSvc->>DB: upsert deposits (idempotent key)
        ImportSvc->>DB: insert import_batch record
    end
    API-->>User: import summary (imported, skipped, errors)
```

---

## 4. Backend Design

### 4.1 API Style

- **Protocol:** REST over HTTP
- **Base path:** `/api/v1/`
- **Format:** JSON request/response bodies
- **Documentation:** Auto-generated OpenAPI at `/docs` and `/redoc`
- **Errors:** Consistent shape: `{ "detail": "...", "code": "..." }`

### 4.2 Module Layout

```
backend/app/
├── api/
│   ├── v1/
│   │   ├── properties.py
│   │   ├── deposits.py
│   │   ├── imports.py
│   │   └── ai.py
│   └── deps.py              # DB session, auth (future)
├── models/
│   ├── owner.py
│   ├── property.py
│   ├── bank_account.py
│   ├── deposit.py
│   └── import_batch.py
├── schemas/
│   ├── property.py
│   ├── deposit.py
│   ├── ai.py
│   └── import.py
├── services/
│   ├── deposit_query.py
│   ├── bank_import.py
│   └── ai_query.py
├── core/
│   ├── config.py
│   └── database.py
└── main.py
```

### 4.3 API Endpoints (MVP)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/properties` | List properties with owner summary |
| `GET` | `/api/v1/properties/{id}` | Property detail, accounts, recent deposits |
| `GET` | `/api/v1/owners` | List owners |
| `GET` | `/api/v1/deposits` | Paginated deposits with filters |
| `GET` | `/api/v1/deposits/gaps` | Expected vs actual deposits for a period |
| `POST` | `/api/v1/imports/deposits` | Upload Excel file |
| `POST` | `/api/v1/ai/query` | Natural-language deposit query |
| `GET` | `/api/v1/health` | Health check |

### 4.4 Deposit List Filters

Query parameters for `GET /api/v1/deposits`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `property_id` | UUID | Filter by property |
| `owner_id` | UUID | Filter by owner |
| `date_from` | date | Inclusive start date |
| `date_to` | date | Inclusive end date |
| `min_amount` | decimal | Minimum deposit amount |
| `max_amount` | decimal | Maximum deposit amount |
| `page` | int | Page number (default 1) |
| `page_size` | int | Items per page (default 50, max 200) |

### 4.5 AI Query Service

#### DepositQueryIntent Schema

```json
{
  "query_type": "list | sum | count | gap_analysis | compare_periods",
  "property_id": "uuid | null",
  "property_name": "string | null",
  "owner_id": "uuid | null",
  "owner_name": "string | null",
  "date_from": "YYYY-MM-DD | null",
  "date_to": "YYYY-MM-DD | null",
  "period_a": { "date_from": "...", "date_to": "..." },
  "period_b": { "date_from": "...", "date_to": "..." },
  "group_by": "property | owner | month | null"
}
```

#### Whitelisted Query Types

| Type | Description | Example question |
|------|-------------|------------------|
| `list` | Return matching deposit rows | "Show deposits for Property X in March" |
| `sum` | Aggregate amounts | "Total deposits this year" |
| `count` | Count deposits | "How many deposits did Owner Y make?" |
| `gap_analysis` | Missing expected deposits | "Which properties missed a deposit in March?" |
| `compare_periods` | Compare two date ranges | "Compare January vs February for Property Y" |

#### Safety Rules

- LLM **never** generates raw SQL
- Intent JSON is validated against a Pydantic schema before execution
- `query_type` must be in the whitelist
- Name-based lookups (`property_name`, `owner_name`) are resolved to IDs via parameterized DB lookup
- Out-of-scope topics return HTTP 400 with message: *"This question is outside MVP scope. Only deposit and income queries are supported."*
- AI query logs store `query_type` and timestamps only — no PII

### 4.6 Import Pipeline

#### Excel Column Template

| Column | Required | Type | Notes |
|--------|----------|------|-------|
| `account_number` | Yes | string | Maps to `bank_accounts.account_number` |
| `transaction_date` | Yes | date | ISO format `YYYY-MM-DD` |
| `amount` | Yes | decimal | Must be positive for deposits |
| `currency` | No | string | Default `ILS` |
| `reference` | No | string | Bank reference number |
| `description` | No | string | Free-text bank description |

#### Idempotency Key

Deposits are upserted by composite key:

```
(bank_account_id, transaction_date, amount, reference)
```

If `reference` is empty, use `(bank_account_id, transaction_date, amount, description)`.

#### Validation Rules

- Reject rows with negative or zero amounts
- Reject rows with unparseable dates
- Collect orphan rows (unknown `account_number`) as errors, not fatal
- Create one `import_batches` record per upload with `filename`, `imported_at`, `row_count`, `error_count`

### 4.7 Authentication (MVP)

- **Single-tenant** deployment; no multi-company isolation in MVP
- Optional API key via `X-API-Key` header (configurable in `.env`)
- Placeholder `deps.py` stub for future JWT/session auth and RBAC

### 4.8 Gap Detection Logic

For a given period (e.g., month):

1. Load all `expected_deposits` active in that period
2. For each property, check if at least one `deposits` row exists within the period matching the expected amount (± configurable tolerance, default 0)
3. Return properties where expected deposit is missing or amount differs beyond tolerance

---

## 5. Frontend Design

### 5.1 Pages (MVP)

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Dashboard | Summary cards: total deposits, deposit count, missing expected count |
| `/properties` | Properties | Table of properties; click opens detail drawer |
| `/properties/:id` | Property detail | Owner info, bank accounts, deposit history |
| `/deposits` | Deposits | Filterable/sortable table; CSV export |
| `/ai` | AI Query | Chat-style panel with example prompts and result table |

### 5.2 Component Structure

```
frontend/src/
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx
│   │   └── Sidebar.tsx
│   ├── deposits/
│   │   ├── DepositTable.tsx
│   │   └── DepositFilters.tsx
│   ├── properties/
│   │   ├── PropertyTable.tsx
│   │   └── PropertyDetail.tsx
│   ├── dashboard/
│   │   ├── SummaryCards.tsx
│   │   └── GapsWidget.tsx
│   └── ai/
│       ├── AIChatPanel.tsx
│       ├── ExamplePrompts.tsx
│       └── QueryResultTable.tsx
├── hooks/
│   ├── useProperties.ts
│   ├── useDeposits.ts
│   └── useAIQuery.ts
├── api/
│   └── client.ts
├── types/
│   └── index.ts
└── App.tsx
```

### 5.3 UI Patterns

- **Tables:** shadcn/ui `DataTable` with column sorting and pagination
- **Filters:** Inline filter bar above deposit table; debounced API calls
- **AI panel:** Text input + send button; example prompt chips; loading skeleton during LLM call
- **Results:** Natural-language answer above a data table; empty state when no rows match
- **Errors:** Toast notifications for API failures; inline validation on import upload

### 5.4 State Management

- **Server state:** TanStack React Query (`useQuery`, `useMutation`)
- **UI state:** React `useState` for filters, drawer open/close, chat input
- **No global store** required for MVP

### 5.5 Internationalization

- MVP UI in **English**
- Hebrew RTL support deferred to a future phase (note in UI copy where relevant)

---

## 6. Data Model

### 6.1 Entity Relationship Diagram

```mermaid
erDiagram
    owners ||--o{ properties : owns
    properties ||--o{ bank_accounts : has
    properties ||--o{ expected_deposits : expects
    bank_accounts ||--o{ deposits : receives
    properties ||--o{ deposits : attributed_to
    import_batches ||--o{ deposits : sourced_from
```

### 6.2 Table Definitions

#### `owners`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique owner identifier |
| `name` | VARCHAR(255) | NOT NULL | Full name or entity name |
| `contact_email` | VARCHAR(255) | NULL | Primary email |
| `contact_phone` | VARCHAR(50) | NULL | Phone number |
| `created_at` | TIMESTAMP | NOT NULL | Record creation time |
| `updated_at` | TIMESTAMP | NOT NULL | Last update time |

#### `properties`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | **Central key-id** for the asset |
| `owner_id` | UUID | FK → owners.id, NOT NULL | Property owner |
| `name` | VARCHAR(255) | NOT NULL | Short name (e.g., "Rothschild 12") |
| `address` | TEXT | NULL | Full address |
| `status` | VARCHAR(50) | NOT NULL, default `active` | `active`, `inactive`, `sold` |
| `created_at` | TIMESTAMP | NOT NULL | Record creation time |
| `updated_at` | TIMESTAMP | NOT NULL | Last update time |

#### `bank_accounts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Account identifier |
| `property_id` | UUID | FK → properties.id, NOT NULL | Linked property |
| `bank_name` | VARCHAR(255) | NOT NULL | Bank name |
| `account_number` | VARCHAR(50) | NOT NULL, UNIQUE | Used for Excel import mapping |
| `currency` | VARCHAR(3) | NOT NULL, default `ILS` | Account currency |
| `created_at` | TIMESTAMP | NOT NULL | Record creation time |

#### `expected_deposits`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Expected deposit rule identifier |
| `property_id` | UUID | FK → properties.id, NOT NULL | Property this rule applies to |
| `amount` | DECIMAL(12,2) | NOT NULL | Expected deposit amount |
| `frequency` | VARCHAR(20) | NOT NULL | `monthly`, `quarterly`, `annual` |
| `due_day` | INT | NOT NULL | Day of month (1–28) when deposit is expected |
| `active` | BOOLEAN | NOT NULL, default true | Whether rule is currently active |
| `created_at` | TIMESTAMP | NOT NULL | Record creation time |

#### `deposits`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Deposit transaction identifier |
| `bank_account_id` | UUID | FK → bank_accounts.id, NOT NULL | Source account |
| `property_id` | UUID | FK → properties.id, NOT NULL | Attributed property |
| `transaction_date` | DATE | NOT NULL | Date of deposit |
| `amount` | DECIMAL(12,2) | NOT NULL, CHECK > 0 | Deposit amount |
| `currency` | VARCHAR(3) | NOT NULL, default `ILS` | Transaction currency |
| `reference` | VARCHAR(100) | NULL | Bank reference number |
| `description` | TEXT | NULL | Bank description text |
| `source` | VARCHAR(50) | NOT NULL | `excel_import`, `manual` (future) |
| `import_batch_id` | UUID | FK → import_batches.id, NULL | Import batch if applicable |
| `created_at` | TIMESTAMP | NOT NULL | Record creation time |

**Unique constraint:** `(bank_account_id, transaction_date, amount, reference)` — with NULL-safe handling for empty reference.

#### `import_batches`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Import batch identifier |
| `filename` | VARCHAR(255) | NOT NULL | Original uploaded filename |
| `imported_at` | TIMESTAMP | NOT NULL | Import timestamp |
| `row_count` | INT | NOT NULL | Total rows processed |
| `imported_count` | INT | NOT NULL | Successfully imported rows |
| `error_count` | INT | NOT NULL | Rows with errors |
| `errors_json` | JSONB | NULL | Array of row-level error details |

---

## 7. Project Structure

```
SimplifAI/
├── docs/
│   └── IMPLEMENTATION_PLAN.md      # This document
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   └── v1/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── services/
│   │   └── core/
│   ├── alembic/
│   │   └── versions/
│   ├── tests/
│   ├── requirements.txt
│   └── main.py
├── frontend/
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── data/
│   └── seed/
│       └── bank_deposits.xlsx      # Task 2 — simulated bank data
├── scripts/
│   └── import_deposits.py          # CLI import alternative
├── .env.example
├── docker-compose.yml              # Optional: PostgreSQL + API
└── README.md
```

---

## 8. Environment and Configuration

### 8.1 Environment Variables (`.env.example`)

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/simplifai
# For local dev without PostgreSQL:
# DATABASE_URL=sqlite:///./simplifai.db

# API
API_HOST=0.0.0.0
API_PORT=8000
API_KEY=dev-api-key-change-in-production

# AI
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# Import
IMPORT_AMOUNT_TOLERANCE=0.00
DEFAULT_CURRENCY=ILS

# Frontend
VITE_API_BASE_URL=http://localhost:8000/api/v1
```

### 8.2 Local Development (Target)

```bash
# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev

# Import seed data (Task 2)
python scripts/import_deposits.py data/seed/bank_deposits.xlsx
```

---

## 9. Implementation Checklist

### Phase 0 — Project Setup

- [ ] Create monorepo folder structure (`backend/`, `frontend/`, `docs/`, `data/seed/`, `scripts/`)
- [ ] Add root `README.md` with project overview and link to this document
- [ ] Initialize Python virtual environment
- [ ] Create `backend/requirements.txt` with: `fastapi`, `uvicorn`, `sqlalchemy`, `alembic`, `psycopg2-binary`, `pydantic`, `pydantic-settings`, `pandas`, `openpyxl`, `python-multipart`, `httpx`, `pytest`
- [ ] Scaffold FastAPI app with `main.py`, `core/config.py`, `core/database.py`
- [ ] Initialize Alembic migration environment
- [ ] Scaffold React + TypeScript + Vite frontend
- [ ] Install Tailwind CSS and shadcn/ui
- [ ] Install TanStack React Query
- [ ] Create `.env.example` with all variables from [Section 8](#8-environment-and-configuration)
- [ ] Add `.gitignore` (`.env`, `__pycache__`, `node_modules`, `*.db`)
- [ ] (Optional) Add `docker-compose.yml` for PostgreSQL

**Definition of Done — Phase 0:**
- Backend starts at `http://localhost:8000` and returns `{ "status": "ok" }` on `/api/v1/health`
- Frontend starts at `http://localhost:5173` with placeholder page
- `.env.example` documents all required variables
- Both sub-projects have independent dependency files (`requirements.txt`, `package.json`)

---

### Phase 1 — Database and Core Domain

- [ ] Implement SQLAlchemy model: `Owner`
- [ ] Implement SQLAlchemy model: `Property` (with `owner_id` FK)
- [ ] Implement SQLAlchemy model: `BankAccount` (with `property_id` FK)
- [ ] Implement SQLAlchemy model: `ExpectedDeposit` (with `property_id` FK)
- [ ] Implement SQLAlchemy model: `Deposit` (with `bank_account_id`, `property_id` FKs)
- [ ] Implement SQLAlchemy model: `ImportBatch`
- [ ] Add unique constraints and check constraints per [Section 6](#6-data-model)
- [ ] Generate and apply Alembic initial migration
- [ ] Create seed script with:
  - [ ] 2 owners
  - [ ] 3 properties (at least 2 per owner)
  - [ ] 1 bank account per property
  - [ ] 1 monthly `expected_deposit` per property
- [ ] Define Pydantic schemas: `OwnerRead`, `PropertyRead`, `PropertyDetail`, `DepositRead`, `DepositFilters`
- [ ] Write unit tests: owner → properties relationship
- [ ] Write unit tests: property → bank_accounts relationship
- [ ] Write unit tests: deposit amount must be positive

**Definition of Done — Phase 1:**
- `alembic upgrade head` succeeds on a clean database
- Seed script populates 2 owners, 3 properties, 3 bank accounts, 3 expected deposit rules
- All model unit tests pass

---

### Phase 2 — Simulated Bank Data (Task 2)

> **Note:** This phase produces the Excel seed file and import tooling referenced in the project requirements.

- [ ] Finalize Excel template columns: `account_number`, `transaction_date`, `amount`, `currency`, `reference`, `description`
- [ ] Create `data/seed/bank_deposits.xlsx` with realistic data:
  - [ ] Deposits spanning at least 3 months
  - [ ] All 3 seed properties represented
  - [ ] At least 15 total deposit rows
  - [ ] One property intentionally missing a monthly expected deposit in one month
- [ ] Implement `BankImportService.parse_excel(file)` using pandas + openpyxl
- [ ] Implement account number → `bank_account_id` → `property_id` mapping
- [ ] Implement idempotent upsert logic per [Section 4.6](#46-import-pipeline)
- [ ] Implement `ImportBatch` record creation with error details
- [ ] Build `scripts/import_deposits.py` CLI wrapper
- [ ] Build `POST /api/v1/imports/deposits` endpoint (multipart file upload)
- [ ] Test: first import inserts all valid rows
- [ ] Test: second import of same file creates zero duplicates
- [ ] Test: row with unknown account number is reported as error, not fatal
- [ ] Test: row with negative amount is rejected

**Definition of Done — Phase 2:**
- `python scripts/import_deposits.py data/seed/bank_deposits.xlsx` imports deposits successfully
- Re-running import reports 0 new rows inserted
- Import summary shows correct `imported_count` and `error_count`
- One property has a detectable missing deposit vs its `expected_deposits` rule

---

### Phase 3 — Backend API (Deposits)

- [ ] Implement `GET /api/v1/owners` — list all owners
- [ ] Implement `GET /api/v1/properties` — list with owner name and deposit count
- [ ] Implement `GET /api/v1/properties/{id}` — detail with accounts and last 10 deposits
- [ ] Implement `GET /api/v1/deposits` — paginated list with all filters from [Section 4.4](#44-deposit-list-filters)
- [ ] Implement `GET /api/v1/deposits/gaps` — query params: `year`, `month` (or `date_from`/`date_to`)
- [ ] Implement `GET /api/v1/deposits/summary` — total amount and count for dashboard
- [ ] Add OpenAPI response models for all endpoints
- [ ] Write integration tests: list properties returns seeded data
- [ ] Write integration tests: deposit filters by `property_id` and date range
- [ ] Write integration tests: gaps endpoint returns the intentional missing deposit
- [ ] Write integration tests: import endpoint accepts Excel upload

**Definition of Done — Phase 3:**
- All endpoints documented at `/docs`
- Integration test suite passes
- `GET /api/v1/deposits/gaps?year=2026&month=3` returns the property with missing deposit

---

### Phase 4 — AI Query Layer

- [ ] Define Pydantic schema `DepositQueryIntent` per [Section 4.5](#45-ai-query-service)
- [ ] Implement `AIQueryService.build_system_prompt()` with schema description and examples
- [ ] Implement `AIQueryService.parse_question(question: str) -> DepositQueryIntent`
- [ ] Implement intent validation (whitelist `query_type`, date format, mutual exclusivity rules)
- [ ] Implement name resolution: `property_name` → `property_id`, `owner_name` → `owner_id`
- [ ] Implement query template: `list`
- [ ] Implement query template: `sum`
- [ ] Implement query template: `count`
- [ ] Implement query template: `gap_analysis`
- [ ] Implement query template: `compare_periods`
- [ ] Implement `POST /api/v1/ai/query` endpoint
- [ ] Return response shape: `{ "answer": "...", "data": [...], "query_used": {...} }`
- [ ] Add out-of-scope detection (expenses, credit cards, documents) → 400 response
- [ ] Add query logging (query_type, timestamp, no PII)
- [ ] Write tests: each query type with mock LLM response
- [ ] Write tests: out-of-scope question returns refusal

**Sample AI prompts (MVP):**

| # | Prompt | Expected query_type |
|---|--------|-------------------|
| 1 | "Show all deposits for Rothschild 12 in Q1 2026" | `list` |
| 2 | "Which properties had no deposit in March 2026?" | `gap_analysis` |
| 3 | "Total deposits per owner this year" | `sum` (group_by: owner) |
| 4 | "Compare deposits January vs February for Property X" | `compare_periods` |
| 5 | "How many deposits were made in the last 30 days?" | `count` |
| 6 | "What were the electricity expenses last month?" | out-of-scope refusal |

**Definition of Done — Phase 4:**
- All 5 in-scope sample prompts return correct structured data
- Out-of-scope prompt (#6) returns a clear refusal message
- No raw SQL appears in logs or LLM output
- Response includes `query_used` for transparency

---

### Phase 5 — Frontend (MVP UI)

- [ ] Build `AppShell` with sidebar navigation (Dashboard, Properties, Deposits, AI Query)
- [ ] Build Dashboard page:
  - [ ] Summary card: total deposit amount (current year)
  - [ ] Summary card: deposit count
  - [ ] `GapsWidget`: list properties with missing expected deposits
- [ ] Build Properties page:
  - [ ] `PropertyTable` with name, owner, status, account count
  - [ ] `PropertyDetail` drawer with accounts and recent deposits
- [ ] Build Deposits page:
  - [ ] `DepositFilters`: property, owner, date range, amount range
  - [ ] `DepositTable`: sortable columns, pagination
  - [ ] CSV export button
- [ ] Build AI Query page:
  - [ ] Chat input with send button
  - [ ] `ExamplePrompts` chips (click to fill input)
  - [ ] Loading state during API call
  - [ ] Natural-language answer display
  - [ ] `QueryResultTable` for structured data
- [ ] Implement API client (`frontend/src/api/client.ts`)
- [ ] Implement React Query hooks: `useProperties`, `useDeposits`, `useDepositGaps`, `useAIQuery`
- [ ] Add toast error handling for failed API calls
- [ ] Add empty states for tables with no data

**Definition of Done — Phase 5:**
- All four navigation items render and load data from the API
- Deposit filters update the table without page reload
- AI Query page answers at least 3 example prompts end-to-end
- Gaps widget shows the intentional missing deposit from seed data

---

### Phase 6 — MVP Verification

- [ ] Write manual test script (or checklist) covering full user flow:
  1. [ ] Start backend and frontend
  2. [ ] Run seed script (owners, properties, accounts)
  3. [ ] Import `bank_deposits.xlsx`
  4. [ ] Verify deposits appear in UI
  5. [ ] Filter deposits by property and date
  6. [ ] Verify gaps widget shows missing deposit
  7. [ ] Ask AI 5 sample questions; verify answers
  8. [ ] Ask 1 out-of-scope question; verify refusal
- [ ] Confirm gap detection matches seed data design
- [ ] Document known limitations in [Section 11](#11-known-limitations-mvp)
- [ ] Tag release or milestone: `mvp-v0.1`

**Definition of Done — Phase 6:**
- Full manual test flow passes without errors
- All Phase 0–5 Definition of Done criteria are met
- Known limitations section is complete

---

## 10. Future Phases

The following checklist items are **out of MVP scope** and serve as a roadmap for subsequent releases.

### Phase 7 — Expenses Module

- [ ] Add `expenses` table with category, source, and payment method
- [ ] Support standing orders (bank direct debit)
- [ ] Support credit card charge line identification
- [ ] Support manual payment entry (owner personal account, company on behalf of owner)
- [ ] Link expenses to properties and owners
- [ ] Classify expenses by type (maintenance, tax, insurance, utilities, etc.)

### Phase 8 — Document and Evidence Pipeline

- [ ] Design folder structure: `/storage/{owner_id}/{property_id}/{doc_type}/`
- [ ] Implement file upload endpoint
- [ ] Parse bank statement PDFs
- [ ] Parse credit card statement PDFs
- [ ] Ingest email attachments (IMAP/webhook)
- [ ] Ingest WhatsApp messages (Business API)
- [ ] OCR for receipts and invoices
- [ ] Link documents to expenses/income records
- [ ] Identify missing documents per property/period

### Phase 9 — Alerts and Notifications

- [ ] Configurable balance threshold per account
- [ ] Alert: account balance below threshold
- [ ] Alert: unusual charge amount (vs historical average)
- [ ] Alert: missing expected deposit
- [ ] Notification delivery: email (and optionally WhatsApp)
- [ ] Alert history and acknowledgment

### Phase 10 — Reporting and Trend Analysis

- [ ] Report: income and expenses by property
- [ ] Report: by date range and category
- [ ] Trend: expense increase/decrease over time
- [ ] Trend: deposit pattern analysis
- [ ] Anomaly detection vs historical baseline
- [ ] Export reports to PDF and Excel

### Phase 11 — Platform Hardening

- [ ] Multi-tenant support (property management company as tenant)
- [ ] Role-based access: admin, manager, owner (read-only)
- [ ] JWT authentication with refresh tokens
- [ ] Audit log for all data changes
- [ ] Hebrew RTL user interface
- [ ] Production deployment (Docker, CI/CD)

---

## 11. Known Limitations (MVP)

| Limitation | Notes |
|------------|-------|
| Income only | No expense tracking, credit cards, or standing orders |
| Excel import only | No live bank API integration; data is simulated |
| Single tenant | No multi-company or role-based access |
| English UI only | Hebrew RTL deferred |
| Basic AI guardrails | Intent-based queries only; no free-form SQL or cross-domain questions |
| No document storage | Receipts, statements, and emails not handled |
| No alerts | Gap detection is manual via UI/AI, not pushed notifications |
| No trend analysis | Historical comparison limited to `compare_periods` query type |
| SQLite in dev | Production should use PostgreSQL for concurrency and JSONB support |

---

## Appendix A — Seed Data Design (Task 2 Reference)

### Suggested Sample Owners and Properties

| Owner | Property | Bank Account | Expected Monthly Deposit |
|-------|----------|--------------|--------------------------|
| David Cohen | Rothschild 12, Tel Aviv | 12-345-678901 | ₪8,500 |
| David Cohen | Dizengoff 45, Tel Aviv | 12-345-678902 | ₪6,200 |
| Sarah Levi | Herzl 8, Haifa | 99-888-777001 | ₪4,800 |

### Intentional Gap

- **Property:** Dizengoff 45
- **Missing period:** March 2026
- **Expected:** ₪6,200 monthly deposit on the 5th
- **Purpose:** Validate `GET /api/v1/deposits/gaps` and AI `gap_analysis` queries

---

## Appendix B — Related Documents

| Document | Status | Description |
|----------|--------|-------------|
| `docs/IMPLEMENTATION_PLAN.md` | Current | This implementation specification |
| `data/seed/bank_deposits.xlsx` | Task 2 | Simulated bank deposit data |
| `scripts/import_deposits.py` | Task 2 | CLI import tool |
| `README.md` | Current | Project overview and quick start |

---

*End of implementation specification.*
