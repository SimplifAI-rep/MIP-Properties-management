from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import DepositGap, DepositListResponse, DepositSummary
from app.services.deposit_query import (
    find_deposit_gaps,
    get_deposit_summary,
    list_deposits,
)

router = APIRouter(prefix="/deposits", tags=["deposits"])


@router.get("", response_model=DepositListResponse)
def get_deposits(
    property_id: UUID | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> DepositListResponse:
    items, total = list_deposits(
        db,
        property_id=property_id,
        owner_id=owner_id,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        page=page,
        page_size=page_size,
    )
    return DepositListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


@router.get("/summary", response_model=DepositSummary)
def deposit_summary(db: Session = Depends(get_db)) -> DepositSummary:
    data = get_deposit_summary(db)
    return DepositSummary(**data)


@router.get("/gaps", response_model=list[DepositGap])
def deposit_gaps(
    year: int | None = None,
    month: int | None = Query(None, ge=1, le=12),
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
) -> list[DepositGap]:
    return find_deposit_gaps(
        db,
        year=year,
        month=month,
        date_from=date_from,
        date_to=date_to,
    )
