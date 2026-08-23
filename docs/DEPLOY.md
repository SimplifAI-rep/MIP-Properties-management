# Deployment Guide

Deploy **frontend on Vercel** and **backend on Render**. The API cannot run on Vercel as-is (FastAPI + SQLite).

## 1. Backend — Render (persistent SQLite)

Production uses **SQLite on a Render persistent disk** so data and uploads survive redeploys. Disks require a **paid** web service plan (Starter or higher). Free-tier filesystem is ephemeral and will lose data.

### A. One-time: upgrade + disk (dashboard)

Do this **before** pointing env vars at `/var/data` if the service is still on Free.

1. Open the `simplifai-api` web service on [render.com](https://render.com)
2. Change instance type to **Starter** (or higher)
3. **Disks** → **Add disk**:
   - Mount path: `/var/data`
   - Size: **1 GB** (enough for demo ClientData + uploads)
4. **Environment** → set/update:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | `sqlite:////var/data/simplifai.db` (four slashes after `sqlite:`) |
| `STORAGE_DIR` | `/var/data/storage` |
| `CORS_ORIGINS` | `http://localhost:5173,https://your-app.vercel.app` |
| `CORS_ORIGIN_REGEX` | `https://.*\.vercel\.app` |
| `LLM_API_KEY` | (optional) your OpenAI key |
| `ADMIN_PASSWORD` | (required for admin login / DB reset) a strong password |

5. Save → wait for redeploy → open `https://YOUR-SERVICE.onrender.com/api/v1/health` → `{"status":"ok"}`
6. In the Vercel app: **Data Import** with ClientData Excel files (use admin login if you reset). The disk DB starts empty after first attach.

If you use **Blueprint** (`render.yaml` at repo root): it already sets `plan: starter`, the `/var/data` disk, and the env defaults above. Sync/apply the blueprint, then still set `ADMIN_PASSWORD` / `LLM_API_KEY` / your real `CORS_ORIGINS` in the dashboard (`sync: false` secrets).

### B. Manual service settings (reference)

| Setting | Value |
|---------|--------|
| Root Directory | `backend` |
| Runtime | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/v1/health` |
| Plan | Starter+ |
| Disk mount | `/var/data` |

### Notes

- Only files under `/var/data` persist. Do **not** leave `DATABASE_URL` / `STORAGE_DIR` on the default project paths.
- A service with a disk is **single-instance**; zero-downtime rolling deploys are disabled (brief downtime on each deploy is expected).
- After attaching a new disk, **re-import** ClientData — previous ephemeral DB is not copied automatically.
- Smoke test: Manual Deploy on Render → Dashboard / Transactions data still present.

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

5. Deploy from the `frontend` directory (or with Root Directory = `frontend`).

`frontend/vercel.json` handles React Router (SPA) rewrites.

6. After first deploy, add your exact Vercel URL to Render `CORS_ORIGINS` if preview regex is not enough.

## 3. Verify

1. Open `https://YOUR-RENDER-SERVICE.onrender.com/api/v1/health` → `{"status":"ok"}`
2. Open your Vercel URL → Data Import → load ClientData
3. Dashboard shows owners / properties / transactions
4. Trigger **Manual Deploy** on Render → data still present
5. Spot-check Transactions, Alerts, AI Query

## 4. Local development (unchanged)

```powershell
.\start.ps1
```

Uses `frontend/.env` and root `.env` for localhost. Leave `DATABASE_URL` unset to use `simplifai.db` at the project root.
