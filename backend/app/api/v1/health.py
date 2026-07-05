from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.owner import Owner
from app.schemas import HealthResponse, OwnerRead

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    return HealthResponse(status="ok", timestamp=datetime.now())


@router.get("/owners", response_model=list[OwnerRead])
def list_owners(db: Session = Depends(get_db)) -> list[Owner]:
    return list(db.scalars(select(Owner).order_by(Owner.name)).all())
