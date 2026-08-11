from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.services.dashboard_query import PeriodFloatResponse, get_period_property_floats

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/period-float", response_model=PeriodFloatResponse)
def period_float(
    date_from: date = Query(...),
    date_to: date = Query(...),
    db: Session = Depends(get_db),
) -> PeriodFloatResponse:
    """Company-float deposit/expense totals by property for a date range."""
    return get_period_property_floats(db, date_from=date_from, date_to=date_to)
