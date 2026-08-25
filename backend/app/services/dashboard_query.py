"""Dashboard period aggregates — company-float totals by property."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services.transaction_filters import (
    deposit_company_float_clause,
    expense_company_float_clauses,
)


class PeriodPropertyFloat(BaseModel):
    property_id: UUID
    deposit_total: Decimal
    expense_total: Decimal
    deposit_count: int
    expense_count: int


class PeriodFloatResponse(BaseModel):
    properties: list[PeriodPropertyFloat]


def get_period_property_floats(
    db: Session,
    *,
    date_from: date,
    date_to: date,
) -> PeriodFloatResponse:
    deposit_stmt = (
        select(
            Deposit.property_id,
            func.coalesce(func.sum(Deposit.amount), 0),
            func.count(Deposit.id),
        )
        .where(
            and_(
                Deposit.transaction_date >= date_from,
                Deposit.transaction_date <= date_to,
                deposit_company_float_clause(),
            )
        )
        .group_by(Deposit.property_id)
    )
    expense_stmt = (
        select(
            Expense.property_id,
            func.coalesce(func.sum(Expense.amount), 0),
            func.count(Expense.id),
        )
        .where(
            and_(
                Expense.transaction_date >= date_from,
                Expense.transaction_date <= date_to,
                *expense_company_float_clauses(),
            )
        )
        .group_by(Expense.property_id)
    )

    deposit_map = {
        property_id: (
            Decimal(str(total)).quantize(Decimal("0.01")),
            int(count),
        )
        for property_id, total, count in db.execute(deposit_stmt).all()
    }
    expense_map = {
        property_id: (
            Decimal(str(total)).quantize(Decimal("0.01")),
            int(count),
        )
        for property_id, total, count in db.execute(expense_stmt).all()
    }

    zero = Decimal("0.00")
    property_ids = set(deposit_map) | set(expense_map)
    rows = [
        PeriodPropertyFloat(
            property_id=property_id,
            deposit_total=deposit_map.get(property_id, (zero, 0))[0],
            expense_total=expense_map.get(property_id, (zero, 0))[0],
            deposit_count=deposit_map.get(property_id, (zero, 0))[1],
            expense_count=expense_map.get(property_id, (zero, 0))[1],
        )
        for property_id in property_ids
    ]
    rows.sort(key=lambda row: str(row.property_id))
    return PeriodFloatResponse(properties=rows)
