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
from app.schemas import DepositCreate, DepositGap, DepositRead, DepositUpdate
from app.services.running_balance import compute_running_balances
from app.services.source_file import (
    load_batch_filenames,
    load_upload_filenames,
    load_upload_locations,
    resolve_source_file,
)


def deposit_to_read(
    deposit: Deposit,
    property_name: str,
    owner_name: str,
    account_number: str | None,
    client_prop_id: str,
    *,
    upload_names: dict[str, str] | None = None,
    upload_locations: dict[str, tuple[str, str | None]] | None = None,
    batch_names: dict[str, str] | None = None,
    balances: dict[tuple[str, str], Decimal] | None = None,
) -> DepositRead:
    balance = None
    if balances is not None:
        balance = balances.get(("deposit", str(deposit.id)))
    file_url = None
    storage_uri = None
    if deposit.receipt_ref and upload_locations:
        loc = upload_locations.get(str(deposit.receipt_ref))
        if loc:
            file_url, storage_uri = loc
    return DepositRead(
        id=deposit.id,
        property_id=deposit.property_id,
        client_prop_id=client_prop_id,
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
        is_rental_income=bool(deposit.is_rental_income),
        receipt_ref=deposit.receipt_ref,
        source_file=resolve_source_file(
            source_file=deposit.source_file,
            receipt_ref=deposit.receipt_ref,
            import_batch_id=deposit.import_batch_id,
            source=deposit.source,
            upload_names=upload_names,
            batch_names=batch_names,
        ),
        balance_after=balance,
        needs_review=bool(getattr(deposit, "needs_review", False)),
        review_reasons=getattr(deposit, "review_reasons", None),
        file_url=file_url,
        storage_uri=storage_uri,
    )


def list_deposits(
    db: Session,
    *,
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[DepositRead], int]:
    page_size = min(max(page_size, 1), 2000)
    page = max(page, 1)

    stmt = (
        select(
            Deposit,
            Property.name,
            Owner.name,
            BankAccount.account_number,
            Property.client_prop_id,
        )
        .join(Property, Deposit.property_id == Property.id)
        .join(Owner, Property.owner_id == Owner.id)
        .outerjoin(BankAccount, Deposit.bank_account_id == BankAccount.id)
        .order_by(Deposit.transaction_date.desc())
    )

    if property_id:
        stmt = stmt.where(Deposit.property_id == property_id)
    if client_prop_id:
        stmt = stmt.where(func.upper(Property.client_prop_id) == client_prop_id.strip().upper())
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

    deposits = [row[0] for row in rows]
    upload_names = load_upload_filenames(db, [d.receipt_ref for d in deposits])
    upload_locations = load_upload_locations(db, [d.receipt_ref for d in deposits])
    batch_names = load_batch_filenames(db, [d.import_batch_id for d in deposits])
    balances = compute_running_balances(db, [d.property_id for d in deposits])

    items = [
        deposit_to_read(
            deposit,
            property_name,
            owner_name,
            account_number,
            client_prop_id_val,
            upload_names=upload_names,
            upload_locations=upload_locations,
            batch_names=batch_names,
            balances=balances,
        )
        for deposit, property_name, owner_name, account_number, client_prop_id_val in rows
    ]
    return items, total


def get_deposit_summary(
    db: Session,
    *,
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    include_all: bool = False,
) -> dict:
    # Default: rental-income rows are informational only — exclude from company float totals
    filters = []
    if not include_all:
        filters.append(Deposit.is_rental_income.is_(False))

    needs_property_join = bool(client_prop_id or owner_id)
    if property_id:
        filters.append(Deposit.property_id == property_id)
    if date_from:
        filters.append(Deposit.transaction_date >= date_from)
    if date_to:
        filters.append(Deposit.transaction_date <= date_to)
    if min_amount is not None:
        filters.append(Deposit.amount >= min_amount)
    if max_amount is not None:
        filters.append(Deposit.amount <= max_amount)

    amount_stmt = select(func.coalesce(func.sum(Deposit.amount), 0))
    count_stmt = select(func.count()).select_from(Deposit)
    property_stmt = select(func.count(func.distinct(Deposit.property_id))).select_from(
        Deposit
    )

    if needs_property_join:
        amount_stmt = amount_stmt.select_from(Deposit).join(
            Property, Deposit.property_id == Property.id
        )
        count_stmt = count_stmt.join(Property, Deposit.property_id == Property.id)
        property_stmt = property_stmt.join(Property, Deposit.property_id == Property.id)
        if client_prop_id:
            filters.append(
                func.upper(Property.client_prop_id) == client_prop_id.strip().upper()
            )
        if owner_id:
            filters.append(Property.owner_id == owner_id)
    elif filters:
        amount_stmt = amount_stmt.select_from(Deposit)

    if filters:
        amount_stmt = amount_stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)
        property_stmt = property_stmt.where(*filters)

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
                    Deposit.is_rental_income.is_(False),
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

    bank_account = None
    account_number = None
    if payload.bank_account_id:
        bank_account = db.get(BankAccount, payload.bank_account_id)
        if not bank_account:
            raise HTTPException(status_code=404, detail="Bank account not found")
        if (
            bank_account.property_id is not None
            and bank_account.property_id != payload.property_id
        ):
            raise HTTPException(
                status_code=400,
                detail="Bank account does not belong to the selected property",
            )
        account_number = bank_account.account_number

    deposit = Deposit(
        bank_account_id=bank_account.id if bank_account else None,
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
        account_number,
        property_row.client_prop_id,
    )


def update_deposit(db: Session, deposit_id: UUID, payload: DepositUpdate) -> DepositRead:
    deposit = db.get(Deposit, deposit_id)
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")

    data = payload.model_dump(exclude_unset=True)
    property_id = data.get("property_id", deposit.property_id)
    property_row = db.get(Property, property_id)
    if not property_row:
        raise HTTPException(status_code=404, detail="Property not found")

    owner = db.get(Owner, property_row.owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")

    account_number = None
    if "bank_account_id" in data:
        bank_account_id = data["bank_account_id"]
        if bank_account_id is None:
            deposit.bank_account_id = None
        else:
            bank_account = db.get(BankAccount, bank_account_id)
            if not bank_account:
                raise HTTPException(status_code=404, detail="Bank account not found")
            if (
                bank_account.property_id is not None
                and bank_account.property_id != property_id
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Bank account does not belong to the selected property",
                )
            deposit.bank_account_id = bank_account.id
            account_number = bank_account.account_number
            data.pop("bank_account_id", None)
    elif deposit.bank_account_id:
        bank_account = db.get(BankAccount, deposit.bank_account_id)
        account_number = bank_account.account_number if bank_account else None

    for key, value in data.items():
        setattr(deposit, key, value)

    if (
        getattr(deposit, "needs_review", False)
        and deposit.transaction_date is not None
        and deposit.amount is not None
        and deposit.amount > 0
    ):
        deposit.needs_review = False
        deposit.review_reasons = None

    db.commit()
    db.refresh(deposit)
    return deposit_to_read(
        deposit,
        property_row.name,
        owner.name,
        account_number,
        property_row.client_prop_id,
    )
