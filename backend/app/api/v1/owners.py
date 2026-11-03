from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import OwnerCreate, OwnerDetail, OwnerPropertySummary, OwnerSummary, OwnerUpdate
from app.services.client_import import PAST_CLIENTS_OWNER_NAME
from app.services.deposit_query import list_deposits
from app.services.expense_query import list_expenses
from app.services.running_balance import property_float_totals

router = APIRouter(prefix="/owners", tags=["owners"])


def _zero() -> Decimal:
    return Decimal("0.00")


def _owner_status_from_property_statuses(statuses: list[str]) -> str:
    """Inactive only when every linked property is inactive."""
    if not statuses:
        return "active"
    if all((status or "").strip().lower() != "active" for status in statuses):
        return "inactive"
    return "active"


def _owner_display_status(owner: Owner, statuses: list[str]) -> str:
    """PAST CLIENTS stays visible on the default Active owners filter."""
    if owner.name == PAST_CLIENTS_OWNER_NAME:
        return "active"
    return _owner_status_from_property_statuses(statuses)


def _deposit_stats_by_owner_subquery():
    return (
        select(
            Property.owner_id.label("owner_id"),
            func.count(Deposit.id).label("deposit_count"),
            func.coalesce(func.sum(Deposit.amount), 0).label("total_deposits"),
        )
        .join(Property, Deposit.property_id == Property.id)
        .group_by(Property.owner_id)
        .subquery()
    )


def _expense_stats_by_owner_subquery():
    return (
        select(
            Property.owner_id.label("owner_id"),
            func.count(Expense.id).label("expense_count"),
            func.coalesce(func.sum(Expense.amount), 0).label("total_expenses"),
        )
        .join(Property, Expense.property_id == Property.id)
        .group_by(Property.owner_id)
        .subquery()
    )


def _property_count_by_owner_subquery():
    return (
        select(
            Property.owner_id.label("owner_id"),
            func.count(Property.id).label("property_count"),
        )
        .group_by(Property.owner_id)
        .subquery()
    )


@router.post("", response_model=OwnerSummary, status_code=201)
def create_owner(payload: OwnerCreate, db: Session = Depends(get_db)) -> OwnerSummary:
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Owner name is required")
    email = (payload.contact_email or "").strip() or None
    phone = (payload.contact_phone or "").strip() or None
    duplicate = db.scalars(
        select(Owner).where(func.lower(Owner.name) == name.lower())
    ).first()
    if duplicate is not None:
        raise HTTPException(status_code=409, detail="An owner with this name already exists")
    owner = Owner(name=name, contact_email=email, contact_phone=phone)
    db.add(owner)
    db.commit()
    db.refresh(owner)
    return OwnerSummary(
        id=owner.id,
        name=owner.name,
        contact_email=owner.contact_email,
        contact_phone=owner.contact_phone,
        property_count=0,
        deposit_count=0,
        total_deposits=_zero(),
        expense_count=0,
        total_expenses=_zero(),
        balance=_zero(),
        status="active",
    )


def _build_owner_summary(db: Session, owner: Owner) -> OwnerSummary:
    props = list(db.scalars(select(Property).where(Property.owner_id == owner.id)).all())
    floats = property_float_totals(db, [prop.id for prop in props])
    deposit_count = (
        db.scalar(
            select(func.count(Deposit.id))
            .select_from(Deposit)
            .join(Property, Deposit.property_id == Property.id)
            .where(Property.owner_id == owner.id)
        )
        or 0
    )
    total_deposits = db.scalar(
        select(func.coalesce(func.sum(Deposit.amount), 0))
        .select_from(Deposit)
        .join(Property, Deposit.property_id == Property.id)
        .where(Property.owner_id == owner.id)
    ) or _zero()
    expense_count = (
        db.scalar(
            select(func.count(Expense.id))
            .select_from(Expense)
            .join(Property, Expense.property_id == Property.id)
            .where(Property.owner_id == owner.id)
        )
        or 0
    )
    total_expenses = db.scalar(
        select(func.coalesce(func.sum(Expense.amount), 0))
        .select_from(Expense)
        .join(Property, Expense.property_id == Property.id)
        .where(Property.owner_id == owner.id)
    ) or _zero()
    balance = sum(
        (floats[prop.id].net if prop.id in floats else _zero() for prop in props),
        _zero(),
    ).quantize(Decimal("0.01"))
    return OwnerSummary(
        id=owner.id,
        name=owner.name,
        contact_email=owner.contact_email,
        contact_phone=owner.contact_phone,
        property_count=len(props),
        deposit_count=int(deposit_count),
        total_deposits=total_deposits if isinstance(total_deposits, Decimal) else _zero(),
        expense_count=int(expense_count),
        total_expenses=total_expenses if isinstance(total_expenses, Decimal) else _zero(),
        balance=balance,
        status=_owner_display_status(owner, [prop.status for prop in props]),
    )


@router.patch("/{owner_id}", response_model=OwnerSummary)
def update_owner(
    owner_id: UUID,
    payload: OwnerUpdate,
    db: Session = Depends(get_db),
) -> OwnerSummary:
    owner = db.get(Owner, owner_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="Owner not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Owner name is required")
        duplicate = db.scalars(
            select(Owner).where(
                func.lower(Owner.name) == name.lower(),
                Owner.id != owner.id,
            )
        ).first()
        if duplicate is not None:
            raise HTTPException(status_code=409, detail="An owner with this name already exists")
        owner.name = name
    if "contact_email" in data:
        owner.contact_email = (data["contact_email"] or "").strip() or None
    if "contact_phone" in data:
        owner.contact_phone = (data["contact_phone"] or "").strip() or None
    db.commit()
    db.refresh(owner)
    return _build_owner_summary(db, owner)


@router.get("", response_model=list[OwnerSummary])
def list_owners(db: Session = Depends(get_db)) -> list[OwnerSummary]:
    property_stats = _property_count_by_owner_subquery()
    deposit_stats = _deposit_stats_by_owner_subquery()
    expense_stats = _expense_stats_by_owner_subquery()

    rows = db.execute(
        select(
            Owner,
            func.coalesce(property_stats.c.property_count, 0),
            func.coalesce(deposit_stats.c.deposit_count, 0),
            func.coalesce(deposit_stats.c.total_deposits, 0),
            func.coalesce(expense_stats.c.expense_count, 0),
            func.coalesce(expense_stats.c.total_expenses, 0),
        )
        .outerjoin(property_stats, Owner.id == property_stats.c.owner_id)
        .outerjoin(deposit_stats, Owner.id == deposit_stats.c.owner_id)
        .outerjoin(expense_stats, Owner.id == expense_stats.c.owner_id)
        .order_by(Owner.name)
    ).all()

    owner_ids = [owner.id for owner, *_ in rows]
    property_rows = (
        db.execute(
            select(Property.id, Property.owner_id, Property.status).where(
                Property.owner_id.in_(owner_ids)
            )
        ).all()
        if owner_ids
        else []
    )
    floats = property_float_totals(db, [property_id for property_id, _, _ in property_rows])
    balance_by_owner: dict[UUID, Decimal] = {}
    statuses_by_owner: dict[UUID, list[str]] = {}
    for property_id, owner_id, status in property_rows:
        statuses_by_owner.setdefault(owner_id, []).append(status)
        totals = floats.get(property_id)
        if not totals:
            continue
        balance_by_owner[owner_id] = balance_by_owner.get(owner_id, _zero()) + totals.net

    return [
        OwnerSummary(
            id=owner.id,
            name=owner.name,
            contact_email=owner.contact_email,
            contact_phone=owner.contact_phone,
            property_count=property_count or 0,
            deposit_count=deposit_count or 0,
            total_deposits=total_deposits or 0,
            expense_count=expense_count or 0,
            total_expenses=total_expenses or 0,
            balance=balance_by_owner.get(owner.id, _zero()).quantize(Decimal("0.01")),
            status=_owner_display_status(owner, statuses_by_owner.get(owner.id, [])),
        )
        for owner, property_count, deposit_count, total_deposits, expense_count, total_expenses in rows
    ]


def _property_deposit_stats_subquery():
    return (
        select(
            Deposit.property_id.label("property_id"),
            func.count(Deposit.id).label("deposit_count"),
            func.coalesce(func.sum(Deposit.amount), 0).label("total_deposits"),
        )
        .group_by(Deposit.property_id)
        .subquery()
    )


def _property_expense_stats_subquery():
    return (
        select(
            Expense.property_id.label("property_id"),
            func.count(Expense.id).label("expense_count"),
            func.coalesce(func.sum(Expense.amount), 0).label("total_expenses"),
        )
        .group_by(Expense.property_id)
        .subquery()
    )


@router.get("/{owner_id}", response_model=OwnerDetail)
def get_owner(owner_id: UUID, db: Session = Depends(get_db)) -> OwnerDetail:
    owner = db.get(Owner, owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")

    deposit_stats = _property_deposit_stats_subquery()
    expense_stats = _property_expense_stats_subquery()

    property_rows = db.execute(
        select(
            Property,
            func.coalesce(deposit_stats.c.deposit_count, 0),
            func.coalesce(deposit_stats.c.total_deposits, 0),
            func.coalesce(expense_stats.c.expense_count, 0),
            func.coalesce(expense_stats.c.total_expenses, 0),
        )
        .outerjoin(deposit_stats, Property.id == deposit_stats.c.property_id)
        .outerjoin(expense_stats, Property.id == expense_stats.c.property_id)
        .where(Property.owner_id == owner_id)
        .order_by(Property.name)
    ).all()

    floats = property_float_totals(db, [prop.id for prop, *_ in property_rows])

    properties = [
        OwnerPropertySummary(
            id=prop.id,
            client_prop_id=prop.client_prop_id,
            name=prop.name,
            address=prop.address,
            city=prop.city,
            status=prop.status,
            deposit_count=deposit_count or 0,
            total_deposits=total_deposits or 0,
            expense_count=expense_count or 0,
            total_expenses=total_expenses or 0,
            balance=(floats.get(prop.id).net if prop.id in floats else _zero()),
        )
        for prop, deposit_count, total_deposits, expense_count, total_expenses in property_rows
    ]

    recent_deposits, _ = list_deposits(db, owner_id=owner_id, page=1, page_size=5)
    recent_expenses, _ = list_expenses(db, owner_id=owner_id, page=1, page_size=5)

    return OwnerDetail(
        id=owner.id,
        name=owner.name,
        contact_email=owner.contact_email,
        contact_phone=owner.contact_phone,
        property_count=len(properties),
        deposit_count=sum(p.deposit_count for p in properties),
        total_deposits=sum(p.total_deposits for p in properties),
        expense_count=sum(p.expense_count for p in properties),
        total_expenses=sum(p.total_expenses for p in properties),
        balance=sum((p.balance for p in properties), _zero()).quantize(Decimal("0.01")),
        status=_owner_display_status(owner, [p.status for p in properties]),
        properties=properties,
        recent_deposits=recent_deposits,
        recent_expenses=recent_expenses,
    )
