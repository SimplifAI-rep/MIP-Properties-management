from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense


def apply_payback_fields(
    db: Session,
    deposit: Deposit,
    *,
    is_payback: bool,
    payback_of_expense_id: UUID | None,
    as_http: bool = True,
) -> None:
    """Tag a deposit as a bank payback and optionally link the original expense."""
    if not is_payback:
        deposit.is_payback = False
        deposit.payback_of_expense_id = None
        return

    if getattr(deposit, "is_rental_income", False):
        deposit.is_rental_income = False

    deposit.is_payback = True
    if payback_of_expense_id is None:
        deposit.payback_of_expense_id = None
        return

    expense = db.get(Expense, payback_of_expense_id)
    if expense is None:
        message = "Original expense not found."
        if as_http:
            raise HTTPException(status_code=400, detail=message)
        raise ValueError(message)
    deposit.payback_of_expense_id = expense.id
