from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import (
    DepositCreate,
    DepositGap,
    DepositListResponse,
    DepositRead,
    DepositSummary,
    DepositUpdate,
)
from app.services.deposit_query import (
    create_deposit,
    delete_deposit,
    find_deposit_gaps,
    get_deposit_summary,
    list_deposits,
    update_deposit,
)

router = APIRouter(prefix="/deposits", tags=["deposits"])


@router.get("", response_model=DepositListResponse)
def get_deposits(
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    is_rental_income: bool | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=2000),
    db: Session = Depends(get_db),
) -> DepositListResponse:
    items, total = list_deposits(
        db,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        needs_review=needs_review,
        is_rental_income=is_rental_income,
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
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    is_rental_income: bool | None = None,
    include_all: bool = False,
    db: Session = Depends(get_db),
) -> DepositSummary:
    data = get_deposit_summary(
        db,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        needs_review=needs_review,
        is_rental_income=is_rental_income,
        include_all=include_all,
    )
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


@router.patch("/{deposit_id}", response_model=DepositRead)
def patch_deposit(
    deposit_id: UUID,
    payload: DepositUpdate,
    db: Session = Depends(get_db),
) -> DepositRead:
    return update_deposit(db, deposit_id, payload)


@router.delete("/{deposit_id}", status_code=204)
def remove_deposit(
    deposit_id: UUID,
    db: Session = Depends(get_db),
) -> None:
    delete_deposit(db, deposit_id)
