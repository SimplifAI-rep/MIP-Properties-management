from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import PropertyCreate, PropertyDetail, PropertyRead, PropertyUpdate
from app.services.client_import import normalize_prop_key
from app.services.deposit_query import list_deposits
from app.services.expense_query import list_expenses
from app.services.running_balance import property_float_totals

router = APIRouter(prefix="/properties", tags=["properties"])


def _zero() -> Decimal:
    return Decimal("0.00")


def _property_read(
    prop: Property,
    owner_name: str,
    deposit_count: int,
    total_deposits: Decimal,
    *,
    incoming: Decimal,
    outgoing: Decimal,
    net: Decimal,
) -> PropertyRead:
    return PropertyRead(
        id=prop.id,
        client_prop_id=prop.client_prop_id,
        name=prop.name,
        address=prop.address,
        city=prop.city,
        status=prop.status,
        owner_id=prop.owner_id,
        owner_name=owner_name,
        deposit_count=deposit_count or 0,
        total_deposits=total_deposits or 0,
        total_incoming=incoming,
        total_outgoing=outgoing,
        net_balance=net,
    )


@router.post("", response_model=PropertyRead, status_code=201)
def create_property(payload: PropertyCreate, db: Session = Depends(get_db)) -> PropertyRead:
    owner = db.get(Owner, payload.owner_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="Owner not found")
    raw_id = (payload.client_prop_id or "").strip()
    client_prop_id = normalize_prop_key(raw_id) or raw_id
    if not client_prop_id:
        raise HTTPException(status_code=400, detail="Property ID is required")
    if len(client_prop_id) > 50:
        raise HTTPException(status_code=400, detail="Property ID is too long")
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Property name is required")
    existing = db.scalars(
        select(Property).where(Property.client_prop_id == client_prop_id)
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Property ID {client_prop_id} is already in use",
        )
    address = (payload.address or "").strip() or None
    city = (payload.city or "").strip() or None
    prop = Property(
        owner_id=owner.id,
        client_prop_id=client_prop_id,
        name=name,
        address=address,
        city=city,
        status=payload.status,
    )
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return _property_read(
        prop,
        owner.name,
        0,
        _zero(),
        incoming=_zero(),
        outgoing=_zero(),
        net=_zero(),
    )


@router.get("", response_model=list[PropertyRead])
def list_properties(db: Session = Depends(get_db)) -> list[PropertyRead]:
    rows = db.execute(
        select(
            Property,
            Owner.name,
            func.count(Deposit.id),
            func.coalesce(func.sum(Deposit.amount), 0),
        )
        .join(Owner, Property.owner_id == Owner.id)
        .outerjoin(Deposit, Deposit.property_id == Property.id)
        .group_by(Property.id, Owner.name)
        .order_by(Property.client_prop_id)
    ).all()

    floats = property_float_totals(db, [prop.id for prop, *_ in rows])

    return [
        _property_read(
            prop,
            owner_name,
            deposit_count or 0,
            total_deposits or _zero(),
            incoming=(floats.get(prop.id).incoming if prop.id in floats else _zero()),
            outgoing=(floats.get(prop.id).outgoing if prop.id in floats else _zero()),
            net=(floats.get(prop.id).net if prop.id in floats else _zero()),
        )
        for prop, owner_name, deposit_count, total_deposits in rows
    ]


@router.patch("/{property_id}", response_model=PropertyRead)
def update_property(
    property_id: UUID,
    payload: PropertyUpdate,
    db: Session = Depends(get_db),
) -> PropertyRead:
    prop = db.get(Property, property_id)
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    data = payload.model_dump(exclude_unset=True)
    if "owner_id" in data:
        owner = db.get(Owner, data["owner_id"])
        if owner is None:
            raise HTTPException(status_code=404, detail="Owner not found")
        prop.owner_id = owner.id
    if "client_prop_id" in data:
        raw_id = (data["client_prop_id"] or "").strip()
        client_prop_id = normalize_prop_key(raw_id) or raw_id
        if not client_prop_id:
            raise HTTPException(status_code=400, detail="Property ID is required")
        if len(client_prop_id) > 50:
            raise HTTPException(status_code=400, detail="Property ID is too long")
        clash = db.scalars(
            select(Property).where(
                Property.client_prop_id == client_prop_id,
                Property.id != prop.id,
            )
        ).first()
        if clash is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Property ID {client_prop_id} is already in use",
            )
        prop.client_prop_id = client_prop_id
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Property name is required")
        prop.name = name
    if "address" in data:
        prop.address = (data["address"] or "").strip() or None
    if "city" in data:
        prop.city = (data["city"] or "").strip() or None
    if "status" in data and data["status"] is not None:
        prop.status = data["status"]
    db.commit()
    db.refresh(prop)

    owner = db.get(Owner, prop.owner_id)
    deposit_count = db.scalar(
        select(func.count(Deposit.id)).where(Deposit.property_id == property_id)
    ) or 0
    total_deposits = db.scalar(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.property_id == property_id
        )
    ) or _zero()
    floats = property_float_totals(db, [property_id])
    totals = floats.get(property_id)

    return _property_read(
        prop,
        owner.name if owner else "",
        int(deposit_count),
        total_deposits if isinstance(total_deposits, Decimal) else _zero(),
        incoming=totals.incoming if totals else _zero(),
        outgoing=totals.outgoing if totals else _zero(),
        net=totals.net if totals else _zero(),
    )


@router.get("/{property_id}", response_model=PropertyDetail)
def get_property(property_id: UUID, db: Session = Depends(get_db)) -> PropertyDetail:
    row = db.execute(
        select(Property, Owner, func.count(Deposit.id), func.coalesce(func.sum(Deposit.amount), 0))
        .join(Owner, Property.owner_id == Owner.id)
        .outerjoin(Deposit, Deposit.property_id == Property.id)
        .where(Property.id == property_id)
        .group_by(Property.id, Owner.id)
    ).first()

    if not row:
        raise HTTPException(status_code=404, detail="Property not found")

    prop, owner, deposit_count, total_deposits = row
    accounts = list(
        db.scalars(
            select(BankAccount).where(BankAccount.property_id == property_id)
        ).all()
    )
    recent, _ = list_deposits(db, property_id=property_id, page=1, page_size=10)
    recent_expenses, _ = list_expenses(db, property_id=property_id, page=1, page_size=10)
    floats = property_float_totals(db, [property_id])
    totals = floats.get(property_id)

    return PropertyDetail(
        id=prop.id,
        client_prop_id=prop.client_prop_id,
        name=prop.name,
        address=prop.address,
        city=prop.city,
        status=prop.status,
        owner_id=prop.owner_id,
        owner_name=owner.name,
        deposit_count=deposit_count or 0,
        total_deposits=total_deposits or 0,
        total_incoming=totals.incoming if totals else _zero(),
        total_outgoing=totals.outgoing if totals else _zero(),
        net_balance=totals.net if totals else _zero(),
        owner=owner,
        bank_accounts=accounts,
        recent_deposits=recent,
        recent_expenses=recent_expenses,
    )
