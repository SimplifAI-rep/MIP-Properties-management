from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import (
    AttachmentRead,
    AwaitingReturnRead,
    ExpenseCreate,
    ExpenseListResponse,
    ExpenseRead,
    ExpenseSummary,
    ExpenseUpdate,
)
from app.services.attachments import add_attachment, list_attachments, remove_attachment
from app.services.expense_query import (
    create_expense,
    delete_expense,
    expense_to_read,
    get_expense_summary,
    list_expenses,
    update_expense,
)
from app.services.deposit_query import deposit_to_read
from app.services.holding import record_awaiting_return, write_off_awaiting_to_buffer
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property

router = APIRouter(prefix="/expenses", tags=["expenses"])


@router.get("", response_model=ExpenseListResponse)
def get_expenses(
    property_id: UUID | None = None,
    property_ids: list[UUID] | None = Query(None),
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = Query(None),
    owner_id: UUID | None = None,
    owner_ids: list[UUID] | None = Query(None),
    property_status: str | None = Query(
        None, pattern="^(active|inactive)$", description="Filter by property status"
    ),
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    card_last4: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    review_reason: str | None = None,
    paid_by_resident: bool | None = None,
    paid_by_owner: bool | None = None,
    paid_by_company: bool | None = None,
    include_running_balance: bool = Query(True),
    deferred_only: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=2000),
    db: Session = Depends(get_db),
) -> ExpenseListResponse:
    items, total = list_expenses(
        db,
        property_id=property_id,
        property_ids=property_ids,
        client_prop_id=client_prop_id,
        client_prop_ids=client_prop_ids,
        owner_id=owner_id,
        owner_ids=owner_ids,
        property_status=property_status,
        category=category,
        source=source,
        payment_method=payment_method,
        card_last4=card_last4,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        needs_review=needs_review,
        review_reason=review_reason,
        paid_by_resident=paid_by_resident,
        paid_by_owner=paid_by_owner,
        paid_by_company=paid_by_company,
        deferred_only=deferred_only,
        page=page,
        page_size=page_size,
        include_running_balance=include_running_balance,
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
    property_status: str | None = Query(
        None, pattern="^(active|inactive)$", description="Filter by property status"
    ),
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    paid_by_resident: bool | None = None,
    paid_by_owner: bool | None = None,
    paid_by_company: bool | None = None,
    include_all: bool = False,
    db: Session = Depends(get_db),
) -> ExpenseSummary:
    data = get_expense_summary(
        db,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        property_status=property_status,
        category=category,
        source=source,
        payment_method=payment_method,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        needs_review=needs_review,
        paid_by_resident=paid_by_resident,
        paid_by_owner=paid_by_owner,
        paid_by_company=paid_by_company,
        include_all=include_all,
    )
    return ExpenseSummary(**data)


@router.get("/{expense_id}/attachments", response_model=list[AttachmentRead])
def get_expense_attachments(
    expense_id: UUID,
    db: Session = Depends(get_db),
) -> list[AttachmentRead]:
    return list_attachments(db, "expense", expense_id)


@router.post("/{expense_id}/attachments", response_model=list[AttachmentRead])
async def post_expense_attachment(
    expense_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> list[AttachmentRead]:
    content = await file.read()
    return add_attachment(
        db,
        "expense",
        expense_id,
        filename=file.filename or "attachment",
        content=content,
        content_type=file.content_type,
    )


@router.delete("/{expense_id}/attachments/{attachment_id}", response_model=list[AttachmentRead])
def delete_expense_attachment(
    expense_id: UUID,
    attachment_id: str,
    db: Session = Depends(get_db),
) -> list[AttachmentRead]:
    return remove_attachment(db, "expense", expense_id, attachment_id)


@router.patch("/{expense_id}", response_model=ExpenseRead)
def patch_expense(
    expense_id: UUID,
    payload: ExpenseUpdate,
    db: Session = Depends(get_db),
) -> ExpenseRead:
    return update_expense(db, expense_id, payload)


def _expense_read(db: Session, expense: Expense) -> ExpenseRead:
    prop = db.get(Property, expense.property_id)
    owner = db.get(Owner, prop.owner_id) if prop else None
    return expense_to_read(
        expense,
        prop.name if prop else "",
        owner.name if owner else "",
        prop.client_prop_id if prop else "",
    )


@router.post("/{expense_id}/write-off-to-buffer", response_model=ExpenseRead)
def write_off_expense_to_buffer(
    expense_id: UUID,
    db: Session = Depends(get_db),
) -> ExpenseRead:
    expense = db.get(Expense, expense_id)
    if expense is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    try:
        write_off_awaiting_to_buffer(db, expense)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(expense)
    return _expense_read(db, expense)


@router.post("/{expense_id}/record-return", response_model=AwaitingReturnRead)
def record_expense_return(
    expense_id: UUID,
    db: Session = Depends(get_db),
) -> AwaitingReturnRead:
    expense = db.get(Expense, expense_id)
    if expense is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    try:
        deposit = record_awaiting_return(db, expense)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(expense)
    db.refresh(deposit)
    prop = db.get(Property, deposit.property_id)
    owner = db.get(Owner, prop.owner_id) if prop else None
    return AwaitingReturnRead(
        expense=_expense_read(db, expense),
        return_deposit=deposit_to_read(
            deposit,
            prop.name if prop else "",
            owner.name if owner else "",
            None,
            prop.client_prop_id if prop else "",
        ),
    )


@router.delete("/{expense_id}", status_code=204)
def remove_expense(
    expense_id: UUID,
    db: Session = Depends(get_db),
) -> None:
    delete_expense(db, expense_id)
