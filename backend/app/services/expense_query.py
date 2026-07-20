from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import ExpenseCategoryTotal, ExpenseCreate, ExpenseRead
from app.services.running_balance import compute_running_balances
from app.services.source_file import load_upload_filenames, resolve_source_file


def expense_to_read(
    expense: Expense,
    property_name: str,
    owner_name: str,
    client_prop_id: str,
    *,
    upload_names: dict[str, str] | None = None,
    balances: dict[tuple[str, str], Decimal] | None = None,
) -> ExpenseRead:
    balance = None
    if balances is not None:
        balance = balances.get(("expense", str(expense.id)))
    return ExpenseRead(
        id=expense.id,
        property_id=expense.property_id,
        client_prop_id=client_prop_id,
        property_name=property_name,
        owner_name=owner_name,
        transaction_date=expense.transaction_date,
        amount=expense.amount,
        currency=expense.currency,
        category=expense.category,
        source=expense.source,
        payment_method=expense.payment_method,
        vendor_name=expense.vendor_name,
        reference=expense.reference,
        description=expense.description,
        notes=expense.notes,
        receipt_ref=expense.receipt_ref,
        source_file=resolve_source_file(
            source_file=expense.source_file,
            receipt_ref=expense.receipt_ref,
            source=expense.source,
            upload_names=upload_names,
        ),
        balance_after=balance,
        reconciled=bool(expense.reconciled),
        paid_by_resident=bool(expense.paid_by_resident),
        paid_by_company=bool(expense.paid_by_company),
        paid_by_owner=bool(expense.paid_by_owner),
        ledger_column=expense.ledger_column,
    )


def _validate_expense_enums(
    *,
    category: str,
    source: str,
    payment_method: str,
) -> None:
    """Validate required fields are non-empty. Preferred enums are optional."""
    if not category or not str(category).strip():
        raise HTTPException(status_code=400, detail="category is required")
    if not source or not str(source).strip():
        raise HTTPException(status_code=400, detail="source is required")
    if not payment_method or not str(payment_method).strip():
        raise HTTPException(status_code=400, detail="payment_method is required")


def list_expenses(
    db: Session,
    *,
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    search_text: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ExpenseRead], int]:
    page_size = min(max(page_size, 1), 2000)
    page = max(page, 1)

    stmt = (
        select(Expense, Property.name, Owner.name, Property.client_prop_id)
        .join(Property, Expense.property_id == Property.id)
        .join(Owner, Property.owner_id == Owner.id)
        .order_by(Expense.transaction_date.desc())
    )

    if property_id:
        stmt = stmt.where(Expense.property_id == property_id)
    if client_prop_id:
        stmt = stmt.where(func.upper(Property.client_prop_id) == client_prop_id.strip().upper())
    if owner_id:
        stmt = stmt.where(Property.owner_id == owner_id)
    if category:
        stmt = stmt.where(Expense.category == category)
    if source:
        stmt = stmt.where(Expense.source == source)
    if payment_method:
        stmt = stmt.where(Expense.payment_method == payment_method)
    if search_text:
        pattern = f"%{search_text}%"
        stmt = stmt.where(
            or_(
                Expense.description.ilike(pattern),
                Expense.vendor_name.ilike(pattern),
            )
        )
    if date_from:
        stmt = stmt.where(Expense.transaction_date >= date_from)
    if date_to:
        stmt = stmt.where(Expense.transaction_date <= date_to)
    if min_amount is not None:
        stmt = stmt.where(Expense.amount >= min_amount)
    if max_amount is not None:
        stmt = stmt.where(Expense.amount <= max_amount)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = db.scalar(count_stmt) or 0

    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).all()
    expenses = [row[0] for row in rows]
    upload_names = load_upload_filenames(db, [e.receipt_ref for e in expenses])
    balances = compute_running_balances(db, [e.property_id for e in expenses])
    items = [
        expense_to_read(
            expense,
            property_name,
            owner_name,
            client_prop_id_val,
            upload_names=upload_names,
            balances=balances,
        )
        for expense, property_name, owner_name, client_prop_id_val in rows
    ]
    return items, total


def create_expense(db: Session, payload: ExpenseCreate) -> ExpenseRead:
    _validate_expense_enums(
        category=payload.category,
        source=payload.source,
        payment_method=payload.payment_method,
    )

    property_row = db.get(Property, payload.property_id)
    if not property_row:
        raise HTTPException(status_code=404, detail="Property not found")

    owner = db.get(Owner, property_row.owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")

    expense = Expense(
        property_id=payload.property_id,
        transaction_date=payload.transaction_date,
        amount=payload.amount,
        currency=payload.currency,
        category=payload.category,
        source=payload.source,
        payment_method=payload.payment_method,
        vendor_name=payload.vendor_name,
        reference=payload.reference,
        description=payload.description,
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense_to_read(expense, property_row.name, owner.name, property_row.client_prop_id)


def get_expense_summary(
    db: Session,
    *,
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
) -> dict:
    # Default: resident/owner-paid rows are informational only — exclude from company totals
    filters = []
    if not include_all:
        filters.extend(
            [
                Expense.paid_by_resident.is_(False),
                Expense.paid_by_owner.is_(False),
            ]
        )

    needs_property_join = bool(client_prop_id or owner_id)
    if property_id:
        filters.append(Expense.property_id == property_id)
    if category:
        filters.append(Expense.category == category)
    if source:
        filters.append(Expense.source == source)
    if payment_method:
        filters.append(Expense.payment_method == payment_method)
    if date_from:
        filters.append(Expense.transaction_date >= date_from)
    if date_to:
        filters.append(Expense.transaction_date <= date_to)
    if min_amount is not None:
        filters.append(Expense.amount >= min_amount)
    if max_amount is not None:
        filters.append(Expense.amount <= max_amount)

    amount_stmt = select(func.coalesce(func.sum(Expense.amount), 0))
    count_stmt = select(func.count()).select_from(Expense)
    property_stmt = select(func.count(func.distinct(Expense.property_id))).select_from(
        Expense
    )
    category_stmt = select(
        Expense.category,
        func.coalesce(func.sum(Expense.amount), 0),
        func.count(),
    ).group_by(Expense.category)

    if needs_property_join:
        amount_stmt = amount_stmt.select_from(Expense).join(
            Property, Expense.property_id == Property.id
        )
        count_stmt = count_stmt.join(Property, Expense.property_id == Property.id)
        property_stmt = property_stmt.join(Property, Expense.property_id == Property.id)
        category_stmt = category_stmt.join(Property, Expense.property_id == Property.id)
        if client_prop_id:
            filters.append(
                func.upper(Property.client_prop_id) == client_prop_id.strip().upper()
            )
        if owner_id:
            filters.append(Property.owner_id == owner_id)
    elif filters:
        amount_stmt = amount_stmt.select_from(Expense)

    if filters:
        amount_stmt = amount_stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)
        property_stmt = property_stmt.where(*filters)
        category_stmt = category_stmt.where(*filters)

    total_amount = db.scalar(amount_stmt) or 0
    expense_count = db.scalar(count_stmt) or 0
    property_count = db.scalar(property_stmt) or 0

    category_rows = db.execute(category_stmt).all()

    by_category = [
        ExpenseCategoryTotal(
            category=category_name,
            total_amount=total,
            expense_count=count,
        )
        for category_name, total, count in category_rows
    ]

    return {
        "total_amount": total_amount,
        "expense_count": expense_count,
        "property_count": property_count,
        "by_category": by_category,
    }
