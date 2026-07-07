from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.expected_deposit import ExpectedDeposit
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import DepositCreate, DepositGap, DepositRead


def deposit_to_read(
    deposit: Deposit,
    property_name: str,
    owner_name: str,
    account_number: str,
) -> DepositRead:
    return DepositRead(
        id=deposit.id,
        property_id=deposit.property_id,
        property_name=property_name,
        owner_name=owner_name,
        bank_account_id=deposit.bank_account_id,
        account_number=account_number,
        transaction_date=deposit.transaction_date,
        amount=deposit.amount,
        currency=deposit.currency,
        reference=deposit.reference,
        description=deposit.description,
        source=deposit.source,
    )


def list_deposits(
    db: Session,
    *,
    property_id: UUID | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[DepositRead], int]:
    page_size = min(max(page_size, 1), 200)
    page = max(page, 1)

    stmt = (
        select(Deposit, Property.name, Owner.name, BankAccount.account_number)
        .join(Property, Deposit.property_id == Property.id)
        .join(Owner, Property.owner_id == Owner.id)
        .join(BankAccount, Deposit.bank_account_id == BankAccount.id)
        .order_by(Deposit.transaction_date.desc())
    )

    if property_id:
        stmt = stmt.where(Deposit.property_id == property_id)
    if owner_id:
        stmt = stmt.where(Property.owner_id == owner_id)
    if date_from:
        stmt = stmt.where(Deposit.transaction_date >= date_from)
    if date_to:
        stmt = stmt.where(Deposit.transaction_date <= date_to)
    if min_amount is not None:
        stmt = stmt.where(Deposit.amount >= min_amount)
    if max_amount is not None:
        stmt = stmt.where(Deposit.amount <= max_amount)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = db.scalar(count_stmt) or 0

    rows = db.execute(
        stmt.offset((page - 1) * page_size).limit(page_size)
    ).all()

    items = [
        deposit_to_read(deposit, property_name, owner_name, account_number)
        for deposit, property_name, owner_name, account_number in rows
    ]
    return items, total


def get_deposit_summary(
    db: Session,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict:
    amount_stmt = select(func.coalesce(func.sum(Deposit.amount), 0))
    count_stmt = select(func.count()).select_from(Deposit)
    property_stmt = select(func.count(func.distinct(Deposit.property_id))).select_from(
        Deposit
    )

    if date_from:
        amount_stmt = amount_stmt.where(Deposit.transaction_date >= date_from)
        count_stmt = count_stmt.where(Deposit.transaction_date >= date_from)
        property_stmt = property_stmt.where(Deposit.transaction_date >= date_from)
    if date_to:
        amount_stmt = amount_stmt.where(Deposit.transaction_date <= date_to)
        count_stmt = count_stmt.where(Deposit.transaction_date <= date_to)
        property_stmt = property_stmt.where(Deposit.transaction_date <= date_to)

    total_amount = db.scalar(amount_stmt) or 0
    deposit_count = db.scalar(count_stmt) or 0
    property_count = db.scalar(property_stmt) or 0

    today = date.today()
    gaps = find_deposit_gaps(db, year=today.year, month=today.month)

    return {
        "total_amount": total_amount,
        "deposit_count": deposit_count,
        "property_count": property_count,
        "missing_deposit_count": len(gaps),
    }


def find_deposit_gaps(
    db: Session,
    *,
    year: int | None = None,
    month: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[DepositGap]:
    settings = get_settings()
    tolerance = Decimal(str(settings.import_amount_tolerance))

    if year and month:
        from datetime import timedelta

        period_start = date(year, month, 1)
        if month == 12:
            period_end = date(year, 12, 31)
        else:
            period_end = date(year, month + 1, 1) - timedelta(days=1)
    elif date_from and date_to:
        period_start = date_from
        period_end = date_to
    else:
        today = date.today()
        period_start = date(today.year, today.month, 1)
        if today.month == 12:
            period_end = date(today.year, 12, 31)
        else:
            from datetime import timedelta

            next_month = date(today.year, today.month + 1, 1)
            period_end = next_month - timedelta(days=1)

    expected_rows = db.execute(
        select(ExpectedDeposit, Property, Owner)
        .join(Property, ExpectedDeposit.property_id == Property.id)
        .join(Owner, Property.owner_id == Owner.id)
        .where(ExpectedDeposit.active.is_(True))
    ).all()

    gaps: list[DepositGap] = []
    for expected, prop, owner in expected_rows:
        deposits = db.scalars(
            select(Deposit).where(
                and_(
                    Deposit.property_id == prop.id,
                    Deposit.transaction_date >= period_start,
                    Deposit.transaction_date <= period_end,
                )
            )
        ).all()

        matched = any(
            abs(dep.amount - expected.amount) <= tolerance for dep in deposits
        )
        if not matched:
            gaps.append(
                DepositGap(
                    property_id=prop.id,
                    property_name=prop.name,
                    owner_name=owner.name,
                    expected_amount=expected.amount,
                    due_day=expected.due_day,
                    period_start=period_start,
                    period_end=period_end,
                    status="missing",
                )
            )

    return gaps


def create_deposit(db: Session, payload: DepositCreate) -> DepositRead:
    property_row = db.get(Property, payload.property_id)
    if not property_row:
        raise HTTPException(status_code=404, detail="Property not found")

    owner = db.get(Owner, property_row.owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")

    bank_account = db.get(BankAccount, payload.bank_account_id)
    if not bank_account:
        raise HTTPException(status_code=404, detail="Bank account not found")
    if bank_account.property_id != payload.property_id:
        raise HTTPException(
            status_code=400,
            detail="Bank account does not belong to the selected property",
        )

    deposit = Deposit(
        bank_account_id=bank_account.id,
        property_id=payload.property_id,
        transaction_date=payload.transaction_date,
        amount=payload.amount,
        currency=payload.currency,
        reference=payload.reference,
        description=payload.description,
        source="manual_entry",
    )
    db.add(deposit)
    db.commit()
    db.refresh(deposit)
    return deposit_to_read(
        deposit,
        property_row.name,
        owner.name,
        bank_account.account_number,
    )
