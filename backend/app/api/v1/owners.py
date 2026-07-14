from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import OwnerDetail, OwnerPropertySummary, OwnerSummary

router = APIRouter(prefix="/owners", tags=["owners"])


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
        )
        for prop, deposit_count, total_deposits, expense_count, total_expenses in property_rows
    ]

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
        properties=properties,
    )
