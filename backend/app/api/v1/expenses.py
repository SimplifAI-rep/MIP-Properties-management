from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import ExpenseCreate, ExpenseListResponse, ExpenseRead, ExpenseSummary, ExpenseUpdate
from app.services.expense_query import (
    create_expense,
    get_expense_summary,
    list_expenses,
    update_expense,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])


@router.get("", response_model=ExpenseListResponse)
def get_expenses(
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=2000),
    db: Session = Depends(get_db),
) -> ExpenseListResponse:
    items, total = list_expenses(
        db,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        category=category,
        source=source,
        payment_method=payment_method,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        page=page,
        page_size=page_size,
    )
    return ExpenseListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


@router.post("", response_model=ExpenseRead, status_code=201)
def post_expense(
    payload: ExpenseCreate,
    db: Session = Depends(get_db),
) -> ExpenseRead:
    return create_expense(db, payload)


@router.get("/summary", response_model=ExpenseSummary)
def expense_summary(
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    include_all: bool = False,
    db: Session = Depends(get_db),
) -> ExpenseSummary:
    data = get_expense_summary(
        db,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        category=category,
        source=source,
        payment_method=payment_method,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        include_all=include_all,
    )
    return ExpenseSummary(**data)


@router.patch("/{expense_id}", response_model=ExpenseRead)
def patch_expense(
    expense_id: UUID,
    payload: ExpenseUpdate,
    db: Session = Depends(get_db),
) -> ExpenseRead:
    return update_expense(db, expense_id, payload)
