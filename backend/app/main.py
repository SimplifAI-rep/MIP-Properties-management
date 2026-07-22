import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.database import init_db

logging.basicConfig(level=logging.INFO)

app = FastAPI(
    title="SimplifAI Property Management",
    description="MVP API for property deposit tracking",
    version="0.1.0",
)

settings = get_settings()
allowed_origins = [
    origin.strip()
    for origin in settings.cors_origins.split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    """Create/migrate tables only — data is loaded via Data Import in the UI."""
    init_db()


app.include_router(api_router, prefix="/api/v1")
