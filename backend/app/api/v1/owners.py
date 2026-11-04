from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import OwnerCreate, OwnerDetail, OwnerPropertySummary, OwnerSummary, OwnerUpdate
from app.services.client_import import PAST_CLIENTS_OWNER_NAME
from app.services.deposit_query import list_deposits
from app.services.expense_query import list_expenses
from app.services.running_balance import PropertyFloatTotals, property_float_totals

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


def _empty_float() -> PropertyFloatTotals:
    return PropertyFloatTotals(
        incoming=_zero(),
        outgoing=_zero(),
        incoming_count=0,
        outgoing_count=0,
    )


def _sum_owner_floats(
    floats: dict,
    property_ids: list,
) -> PropertyFloatTotals:
    incoming = _zero()
    outgoing = _zero()
    incoming_count = 0
    outgoing_count = 0
    for property_id in property_ids:
        totals = floats.get(property_id) or _empty_float()
        incoming += totals.incoming
        outgoing += totals.outgoing
        incoming_count += totals.incoming_count
        outgoing_count += totals.outgoing_count
    return PropertyFloatTotals(
        incoming=incoming.quantize(Decimal("0.01")),
        outgoing=outgoing.quantize(Decimal("0.01")),
        incoming_count=incoming_count,
        outgoing_count=outgoing_count,
    )


def _sorted_client_prop_ids(ids: list[str]) -> list[str]:
    def sort_key(value: str) -> tuple[int, int, str]:
        text = (value or "").strip()
        if text.isdigit():
            return (0, int(text), text.lower())
        return (1, 0, text.lower())

    return sorted(ids, key=sort_key)


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
        client_prop_ids=[],
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
    money = _sum_owner_floats(floats, [prop.id for prop in props])
    return OwnerSummary(
        id=owner.id,
        name=owner.name,
        contact_email=owner.contact_email,
        contact_phone=owner.contact_phone,
        property_count=len(props),
        client_prop_ids=_sorted_client_prop_ids([prop.client_prop_id for prop in props]),
        deposit_count=money.incoming_count,
        total_deposits=money.incoming,
        expense_count=money.outgoing_count,
        total_expenses=money.outgoing,
        balance=money.net,
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

    rows = db.execute(
        select(
            Owner,
            func.coalesce(property_stats.c.property_count, 0),
        )
        .outerjoin(property_stats, Owner.id == property_stats.c.owner_id)
        .order_by(Owner.name)
    ).all()

    owner_ids = [owner.id for owner, _ in rows]
    property_rows = (
        db.execute(
            select(
                Property.id,
                Property.owner_id,
                Property.status,
                Property.client_prop_id,
            ).where(Property.owner_id.in_(owner_ids))
        ).all()
        if owner_ids
        else []
    )
    floats = property_float_totals(
        db, [property_id for property_id, _, _, _ in property_rows]
    )
    money_by_owner: dict[UUID, PropertyFloatTotals] = {}
    statuses_by_owner: dict[UUID, list[str]] = {}
    ids_by_owner: dict[UUID, list[UUID]] = {}
    client_prop_ids_by_owner: dict[UUID, list[str]] = {}
    for property_id, owner_id, status, client_prop_id in property_rows:
        statuses_by_owner.setdefault(owner_id, []).append(status)
        ids_by_owner.setdefault(owner_id, []).append(property_id)
        client_prop_ids_by_owner.setdefault(owner_id, []).append(client_prop_id)
    for owner_id, prop_ids in ids_by_owner.items():
        money_by_owner[owner_id] = _sum_owner_floats(floats, prop_ids)

    return [
        OwnerSummary(
            id=owner.id,
            name=owner.name,
            contact_email=owner.contact_email,
            contact_phone=owner.contact_phone,
            property_count=property_count or 0,
            client_prop_ids=_sorted_client_prop_ids(
                client_prop_ids_by_owner.get(owner.id, [])
            ),
            deposit_count=(money_by_owner.get(owner.id) or _empty_float()).incoming_count,
            total_deposits=(money_by_owner.get(owner.id) or _empty_float()).incoming,
            expense_count=(money_by_owner.get(owner.id) or _empty_float()).outgoing_count,
            total_expenses=(money_by_owner.get(owner.id) or _empty_float()).outgoing,
            balance=(money_by_owner.get(owner.id) or _empty_float()).net,
            status=_owner_display_status(owner, statuses_by_owner.get(owner.id, [])),
        )
        for owner, property_count in rows
    ]


@router.get("/{owner_id}", response_model=OwnerDetail)
def get_owner(owner_id: UUID, db: Session = Depends(get_db)) -> OwnerDetail:
    owner = db.get(Owner, owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="Owner not found")

    props = list(
        db.scalars(
            select(Property).where(Property.owner_id == owner_id).order_by(Property.name)
        ).all()
    )
    floats = property_float_totals(db, [prop.id for prop in props])

    properties = []
    for prop in props:
        totals = floats.get(prop.id) or _empty_float()
        properties.append(
            OwnerPropertySummary(
                id=prop.id,
                client_prop_id=prop.client_prop_id,
                name=prop.name,
                address=prop.address,
                city=prop.city,
                status=prop.status,
                deposit_count=totals.incoming_count,
                total_deposits=totals.incoming,
                expense_count=totals.outgoing_count,
                total_expenses=totals.outgoing,
                balance=totals.net,
            )
        )

    recent_deposits, _ = list_deposits(db, owner_id=owner_id, page=1, page_size=5)
    recent_expenses, _ = list_expenses(db, owner_id=owner_id, page=1, page_size=5)
    money = _sum_owner_floats(floats, [prop.id for prop in props])

    return OwnerDetail(
        id=owner.id,
        name=owner.name,
        contact_email=owner.contact_email,
        contact_phone=owner.contact_phone,
        property_count=len(properties),
        client_prop_ids=_sorted_client_prop_ids(
            [prop.client_prop_id for prop in properties]
        ),
        deposit_count=money.incoming_count,
        total_deposits=money.incoming,
        expense_count=money.outgoing_count,
        total_expenses=money.outgoing,
        balance=money.net,
        status=_owner_display_status(owner, [p.status for p in properties]),
        properties=properties,
        recent_deposits=recent_deposits,
        recent_expenses=recent_expenses,
    )
