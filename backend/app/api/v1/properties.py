from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import PropertyDetail, PropertyRead
from app.services.deposit_query import deposit_to_read, list_deposits

router = APIRouter(prefix="/properties", tags=["properties"])


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
        .order_by(Property.name)
    ).all()

    return [
        PropertyRead(
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
        )
        for prop, owner_name, deposit_count, total_deposits in rows
    ]


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
        owner=owner,
        bank_accounts=accounts,
        recent_deposits=recent,
    )
