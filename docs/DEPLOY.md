# Deployment Guide

Deploy **frontend on Vercel** and **backend on Render**. The API cannot run on Vercel as-is (FastAPI + SQLite).

## 1. Backend — Render

1. Go to [render.com](https://render.com) → **New → Blueprint** (or **Web Service**)
2. Connect your GitHub repo
3. If using **Blueprint**: Render reads `render.yaml` at the repo root
4. If manual setup:

| Setting | Value |
|---------|--------|
| Root Directory | `backend` |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/v1/health` |

5. **Environment variables** (Render dashboard):

| Variable | Value |
|----------|--------|
| `CORS_ORIGINS` | `http://localhost:5173,https://your-app.vercel.app` |
| `CORS_ORIGIN_REGEX` | `https://.*\.vercel\.app` |
| `LLM_API_KEY` | (optional) your OpenAI key |

6. Deploy and copy the service URL, e.g. `https://simplifai-api.onrender.com`

The API starts with an empty database (tables only). Load owners, properties, deposits, and expenses via **Data Import** in the web UI.

> **Note:** Render free tier uses ephemeral disk — data may reset on redeploy. Fine for demos.

## 2. Frontend — Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import the same GitHub repo
3. Configure:

| Setting | Value |
|---------|--------|
| Root Directory | `frontend` |
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |

4. **Environment variable**:

```
VITE_API_BASE_URL = https://YOUR-RENDER-SERVICE.onrender.com/api/v1
```

5. Deploy

`frontend/vercel.json` handles React Router (SPA) rewrites.

6. After first deploy, add your exact Vercel URL to Render `CORS_ORIGINS` if preview regex is not enough.

## 3. Verify

1. Open `https://YOUR-RENDER-SERVICE.onrender.com/api/v1/health` → `{"status":"ok"}`
2. Open your Vercel URL → Dashboard loads with data
3. Test Transactions, Alerts, AI Query

## 4. Local development (unchanged)

```powershell
.\start.ps1
```

Uses `frontend/.env` and root `.env` for localhost.
