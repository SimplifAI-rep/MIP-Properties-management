from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models import Deposit, Expense

router = APIRouter(prefix="/meta", tags=["meta"])


class TransactionYearsResponse(BaseModel):
    years: list[int]


@router.get("/transaction-years", response_model=TransactionYearsResponse)
def list_transaction_years(db: Session = Depends(get_db)) -> TransactionYearsResponse:
    """Return distinct years present in deposits and expenses, newest first.

    Years before 2000 are excluded — those usually come from Excel serial-date
    misreads (e.g. day number 28 → 1900-01-28), not real ledger history.
    """
    years: set[int] = set()
    min_year = 2000

    for model in (Deposit, Expense):
        # SQLite-friendly year extraction via strftime
        rows = db.execute(
            select(func.strftime("%Y", model.transaction_date)).distinct()
        ).all()
        for (value,) in rows:
            if value is None:
                continue
            try:
                year = int(value)
            except (TypeError, ValueError):
                continue
            if year >= min_year:
                years.add(year)

    if not years:
        from datetime import date

        years.add(date.today().year)

    return TransactionYearsResponse(years=sorted(years, reverse=True))
