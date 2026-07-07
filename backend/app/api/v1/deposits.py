from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import DepositCreate, DepositGap, DepositListResponse, DepositRead, DepositSummary
from app.services.deposit_query import (
    create_deposit,
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


@router.post("", response_model=DepositRead, status_code=201)
def post_deposit(
    payload: DepositCreate,
    db: Session = Depends(get_db),
) -> DepositRead:
    return create_deposit(db, payload)


@router.get("/summary", response_model=DepositSummary)
def deposit_summary(
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
) -> DepositSummary:
    data = get_deposit_summary(db, date_from=date_from, date_to=date_to)
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
