from urllib.parse import unquote

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import (
    AlertListResponse,
    AlertRead,
    AlertResolveRequest,
    AlertSummary,
    FixIncompletePayload,
)
from app.services.alert_service import (
    dismiss_alert,
    fix_incomplete_transaction,
    get_alert_summary,
    list_alerts,
    resolve_alert,
)

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=AlertListResponse)
def get_alerts(db: Session = Depends(get_db)) -> AlertListResponse:
    return list_alerts(db)


@router.get("/summary", response_model=AlertSummary)
def alerts_summary(db: Session = Depends(get_db)) -> AlertSummary:
    return get_alert_summary(db)


@router.post("/fix-incomplete")
def post_fix_incomplete(
    payload: FixIncompletePayload,
    db: Session = Depends(get_db),
) -> dict:
    """Fix date/amount on an incomplete import expense or deposit (Transactions + Alerts)."""
    return fix_incomplete_transaction(db, payload)


@router.post("/{alert_id}/dismiss", response_model=AlertRead)
def post_dismiss_alert(
    alert_id: str,
    db: Session = Depends(get_db),
) -> AlertRead:
    return dismiss_alert(db, unquote(alert_id))


@router.post("/{alert_id}/resolve", response_model=AlertRead)
def post_resolve_alert(
    alert_id: str,
    payload: AlertResolveRequest,
    db: Session = Depends(get_db),
) -> AlertRead:
    return resolve_alert(db, unquote(alert_id), payload)
