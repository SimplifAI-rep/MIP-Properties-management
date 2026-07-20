from fastapi import APIRouter

from app.api.v1 import (
    ai,
    alerts,
    deposits,
    expenses,
    feedback,
    health,
    imports,
    meta,
    owners,
    properties,
    uploads,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(meta.router)
api_router.include_router(owners.router)
api_router.include_router(properties.router)
api_router.include_router(deposits.router)
api_router.include_router(expenses.router)
api_router.include_router(imports.router)
api_router.include_router(uploads.router)
api_router.include_router(alerts.router)
api_router.include_router(ai.router)
api_router.include_router(feedback.router)
