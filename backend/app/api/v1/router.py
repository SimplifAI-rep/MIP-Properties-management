from fastapi import APIRouter

from app.api.v1 import ai, deposits, expenses, health, imports, owners, properties, uploads

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(owners.router)
api_router.include_router(properties.router)
api_router.include_router(deposits.router)
api_router.include_router(expenses.router)
api_router.include_router(imports.router)
api_router.include_router(uploads.router)
api_router.include_router(ai.router)
