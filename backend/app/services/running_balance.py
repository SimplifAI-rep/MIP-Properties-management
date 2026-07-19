"""Per-property running net balance (company float), matching Transactions summary.

Rules (same as deposit/expense summary with include_all=false):
- Deposits: include unless is_rental_income
- Expenses: include unless paid_by_resident or paid_by_owner
- Balance after each row = cumulative inflows − outflows for that property
- Rows that do not count still show the prior balance (Excel-style unchanged Balance)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense


@dataclass(frozen=True)
class PropertyFloatTotals:
    incoming: Decimal
    outgoing: Decimal

    @property
    def net(self) -> Decimal:
        return (self.incoming - self.outgoing).quantize(Decimal("0.01"))


def property_float_totals(
    db: Session,
    property_ids: list[UUID] | None = None,
) -> dict[UUID, PropertyFloatTotals]:
    """Company-float incoming/outgoing totals keyed by property_id."""
    deposit_stmt = (
        select(
            Deposit.property_id,
            func.coalesce(func.sum(Deposit.amount), 0),
        )
        .where(Deposit.is_rental_income.is_(False))
        .group_by(Deposit.property_id)
    )
    expense_stmt = (
        select(
            Expense.property_id,
            func.coalesce(func.sum(Expense.amount), 0),
        )
        .where(
            and_(
                Expense.paid_by_resident.is_(False),
                Expense.paid_by_owner.is_(False),
            )
        )
        .group_by(Expense.property_id)
    )
    if property_ids is not None:
        unique_ids = list({pid for pid in property_ids if pid is not None})
        if not unique_ids:
            return {}
        deposit_stmt = deposit_stmt.where(Deposit.property_id.in_(unique_ids))
        expense_stmt = expense_stmt.where(Expense.property_id.in_(unique_ids))

    incoming_map = {
        property_id: Decimal(str(total)).quantize(Decimal("0.01"))
        for property_id, total in db.execute(deposit_stmt).all()
    }
    outgoing_map = {
        property_id: Decimal(str(total)).quantize(Decimal("0.01"))
        for property_id, total in db.execute(expense_stmt).all()
    }

    keys = set(incoming_map) | set(outgoing_map)
    if property_ids is not None:
        keys |= set(unique_ids)

    zero = Decimal("0.00")
    return {
        property_id: PropertyFloatTotals(
            incoming=incoming_map.get(property_id, zero),
            outgoing=outgoing_map.get(property_id, zero),
        )
        for property_id in keys
    }


@dataclass(frozen=True)
class _LedgerEvent:
    property_id: UUID
    transaction_date: date
    created_at: datetime | None
    kind: str  # deposit | expense
    id: UUID
    delta: Decimal  # 0 if row does not affect company float


def compute_running_balances(
    db: Session,
    property_ids: list[UUID],
) -> dict[tuple[str, str], Decimal]:
    """Return {(kind, transaction_id_str): balance_after} for all txs on those properties."""
    if not property_ids:
        return {}

    unique_ids = list({pid for pid in property_ids if pid is not None})
    if not unique_ids:
        return {}

    deposits = db.scalars(
        select(Deposit).where(Deposit.property_id.in_(unique_ids))
    ).all()
    expenses = db.scalars(
        select(Expense).where(Expense.property_id.in_(unique_ids))
    ).all()

    events: list[_LedgerEvent] = []
    for deposit in deposits:
        counts = not bool(deposit.is_rental_income)
        events.append(
            _LedgerEvent(
                property_id=deposit.property_id,
                transaction_date=deposit.transaction_date,
                created_at=getattr(deposit, "created_at", None),
                kind="deposit",
                id=deposit.id,
                delta=deposit.amount if counts else Decimal("0"),
            )
        )
    for expense in expenses:
        counts = not bool(expense.paid_by_resident) and not bool(expense.paid_by_owner)
        events.append(
            _LedgerEvent(
                property_id=expense.property_id,
                transaction_date=expense.transaction_date,
                created_at=getattr(expense, "created_at", None),
                kind="expense",
                id=expense.id,
                delta=-expense.amount if counts else Decimal("0"),
            )
        )

    events.sort(
        key=lambda event: (
            str(event.property_id),
            event.transaction_date.isoformat(),
            event.created_at.isoformat() if event.created_at else "",
            event.kind,
            str(event.id),
        )
    )

    balances: dict[tuple[str, str], Decimal] = {}
    running: dict[UUID, Decimal] = {}
    for event in events:
        current = running.get(event.property_id, Decimal("0.00"))
        current = (current + event.delta).quantize(Decimal("0.01"))
        running[event.property_id] = current
        balances[(event.kind, str(event.id))] = current
    return balances
