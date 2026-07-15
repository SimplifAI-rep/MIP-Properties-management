from __future__ import annotations

from datetime import date, datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.alert_action import AlertAction
from app.models.owner import Owner
from app.models.property import Property
from app.models.uploaded_document import UploadedDocument
from app.schemas import (
    AlertListResponse,
    AlertRead,
    AlertResolveRequest,
    AlertSummary,
    DepositCreate,
    TransactionDraft,
)
from app.services.deposit_query import create_deposit, find_deposit_gaps
from app.services.document_import import DocumentImportService


def _load_closed_keys(db: Session) -> set[str]:
    rows = db.scalars(select(AlertAction.alert_key)).all()
    return set(rows)


def _gap_alert_key(property_id: UUID, period_start: date) -> str:
    return f"missing_deposit:{property_id}:{period_start.isoformat()}"


def _upload_alert_key(upload_id: UUID) -> str:
    return f"upload_pending:{upload_id}"


def list_alerts(db: Session) -> AlertListResponse:
    closed_keys = _load_closed_keys(db)
    alerts: list[AlertRead] = []

    for gap in find_deposit_gaps(db):
        alert_id = _gap_alert_key(gap.property_id, gap.period_start)
        if alert_id in closed_keys:
            continue
        alerts.append(
            AlertRead(
                id=alert_id,
                alert_type="missing_deposit",
                severity="warning",
                title=f"Missing deposit — {gap.property_name}",
                message=(
                    f"Expected {gap.expected_amount} {gap.owner_name} deposit "
                    f"for {gap.period_start.strftime('%B %Y')} was not received."
                ),
                property_id=gap.property_id,
                property_name=gap.property_name,
                owner_name=gap.owner_name,
                created_at=None,
                gap=gap,
            )
        )

    pending_uploads = db.execute(
        select(UploadedDocument, Property.name, Owner.name)
        .outerjoin(Property, UploadedDocument.property_id == Property.id)
        .outerjoin(Owner, UploadedDocument.owner_id == Owner.id)
        .where(UploadedDocument.status == "pending_review")
        .order_by(UploadedDocument.created_at.desc())
    ).all()

    for document, property_name, owner_name in pending_uploads:
        alert_id = _upload_alert_key(document.id)
        if alert_id in closed_keys:
            continue

        extraction = document.extraction_json or {}
        raw_drafts = extraction.get("drafts", [])
        drafts = [TransactionDraft.model_validate(item) for item in raw_drafts]

        ready_count = sum(1 for draft in drafts if draft.status == "ready")
        review_count = sum(1 for draft in drafts if draft.status == "needs_review")
        error_count = sum(1 for draft in drafts if draft.status == "error")
        duplicate_count = sum(
            1
            for draft in drafts
            for warning in draft.warnings
            if "duplicate" in warning.message.lower()
        )

        if error_count:
            severity = "error"
        elif review_count or duplicate_count:
            severity = "warning"
        else:
            severity = "info"

        alert_type = "upload_pending"
        if duplicate_count and not error_count:
            alert_type = "duplicate_deposit"

        message_parts = [
            f"{len(drafts)} extracted row(s)",
            f"{ready_count} ready" if ready_count else None,
            f"{review_count} need review" if review_count else None,
            f"{error_count} with errors" if error_count else None,
            f"{duplicate_count} possible duplicate(s)" if duplicate_count else None,
        ]
        message = ", ".join(part for part in message_parts if part)

        alerts.append(
            AlertRead(
                id=alert_id,
                alert_type=alert_type,  # type: ignore[arg-type]
                severity=severity,  # type: ignore[arg-type]
                title=f"Review upload — {document.filename}",
                message=message,
                property_id=document.property_id,
                property_name=property_name or "Unmatched client",
                owner_name=owner_name,
                upload_id=document.id,
                transaction_type=document.transaction_type,  # type: ignore[arg-type]
                created_at=document.created_at,
                drafts=drafts,
            )
        )

    alerts.sort(
        key=lambda alert: (
            0 if alert.severity == "error" else 1 if alert.severity == "warning" else 2,
            alert.created_at or datetime.min,
        )
    )

    return AlertListResponse(
        items=alerts,
        total=len(alerts),
        error_count=sum(1 for alert in alerts if alert.severity == "error"),
        warning_count=sum(1 for alert in alerts if alert.severity == "warning"),
    )


def get_alert_summary(db: Session) -> AlertSummary:
    data = list_alerts(db)
    return AlertSummary(
        open_count=data.total,
        error_count=data.error_count,
        warning_count=data.warning_count,
    )


def dismiss_alert(db: Session, alert_id: str) -> AlertRead:
    alerts = list_alerts(db)
    alert = next((item for item in alerts.items if item.id == alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found or already closed")

    existing = db.scalars(
        select(AlertAction).where(AlertAction.alert_key == alert_id)
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Alert already closed")

    db.add(
        AlertAction(
            alert_key=alert_id,
            action="dismissed",
            metadata_json={"alert_type": alert.alert_type},
        )
    )
    db.commit()
    return alert


def resolve_alert(db: Session, alert_id: str, payload: AlertResolveRequest) -> AlertRead:
    alerts = list_alerts(db)
    alert = next((item for item in alerts.items if item.id == alert_id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found or already closed")

    if alert.alert_type == "missing_deposit":
        if payload.action != "add_deposit" or payload.deposit is None:
            raise HTTPException(
                status_code=400,
                detail="Missing deposit alerts require action=add_deposit with deposit payload",
            )
        create_deposit(db, payload.deposit)
    elif alert.alert_type in {"upload_pending", "duplicate_deposit"}:
        if payload.action != "confirm_upload":
            raise HTTPException(
                status_code=400,
                detail="Upload alerts require action=confirm_upload",
            )
        if alert.upload_id is None:
            raise HTTPException(status_code=400, detail="Upload alert is missing upload_id")
        if not payload.drafts:
            raise HTTPException(status_code=400, detail="At least one draft is required")

        import_service = DocumentImportService(db)
        from app.schemas import UploadConfirmRequest

        import_service.confirm(
            alert.upload_id,
            UploadConfirmRequest(drafts=payload.drafts),
        )
    else:
        raise HTTPException(status_code=400, detail="Unsupported alert type")

    db.add(
        AlertAction(
            alert_key=alert_id,
            action="resolved",
            metadata_json={
                "alert_type": alert.alert_type,
                "resolve_action": payload.action,
            },
        )
    )
    db.commit()
    return alert
