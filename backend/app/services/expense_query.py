from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.expense import (
    EXPENSE_CATEGORIES,
    EXPENSE_SOURCES,
    PAYMENT_METHODS,
    Expense,
)
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import ExpenseCategoryTotal, ExpenseCreate, ExpenseRead


def expense_to_read(
    expense: Expense,
    property_name: str,
    owner_name: str,
) -> ExpenseRead:
    return ExpenseRead(
        id=expense.id,
        property_id=expense.property_id,
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
    )


def _validate_expense_enums(
    *,
    category: str,
    source: str,
    payment_method: str,
) -> None:
    if category not in EXPENSE_CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Allowed: {', '.join(EXPENSE_CATEGORIES)}",
        )
    if source not in EXPENSE_SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid source. Allowed: {', '.join(EXPENSE_SOURCES)}",
        )
    if payment_method not in PAYMENT_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid payment_method. Allowed: {', '.join(PAYMENT_METHODS)}",
        )


def list_expenses(
    db: Session,
    *,
    property_id: UUID | None = None,
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
    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)

    stmt = (
        select(Expense, Property.name, Owner.name)
        .join(Property, Expense.property_id == Property.id)
        .join(Owner, Property.owner_id == Owner.id)
        .order_by(Expense.transaction_date.desc())
    )

    if property_id:
        stmt = stmt.where(Expense.property_id == property_id)
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
    items = [
        expense_to_read(expense, property_name, owner_name)
        for expense, property_name, owner_name in rows
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
    return expense_to_read(expense, property_row.name, owner.name)


def get_expense_summary(db: Session) -> dict:
    total_amount = db.scalar(select(func.coalesce(func.sum(Expense.amount), 0))) or 0
    expense_count = db.scalar(select(func.count()).select_from(Expense)) or 0
    property_count = db.scalar(
        select(func.count(func.distinct(Expense.property_id))).select_from(Expense)
    ) or 0

    category_rows = db.execute(
        select(
            Expense.category,
            func.coalesce(func.sum(Expense.amount), 0),
            func.count(),
        ).group_by(Expense.category)
    ).all()

    by_category = [
        ExpenseCategoryTotal(
            category=category,
            total_amount=total,
            expense_count=count,
        )
        for category, total, count in category_rows
    ]

    return {
        "total_amount": total_amount,
        "expense_count": expense_count,
        "property_count": property_count,
        "by_category": by_category,
    }
