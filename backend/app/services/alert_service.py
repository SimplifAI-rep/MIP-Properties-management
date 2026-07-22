from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.models.alert_action import AlertAction
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.models.uploaded_document import UploadedDocument
from app.schemas import (
    AlertListResponse,
    AlertRead,
    AlertResolveRequest,
    AlertSummary,
    DepositCreate,
    FixIncompletePayload,
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


def _incomplete_expense_key(expense_id: UUID) -> str:
    return f"incomplete_import:expense:{expense_id}"


def _incomplete_deposit_key(deposit_id: UUID) -> str:
    return f"incomplete_import:deposit:{deposit_id}"


def _missing_fields_message(reasons: str | None, tx_date: date | None, amount: Decimal) -> str:
    parts: list[str] = []
    reason_set = {r.strip() for r in (reasons or "").split(",") if r.strip()}
    if "missing_date" in reason_set or tx_date is None:
        parts.append("missing date")
    if "no_money_columns" in reason_set or amount <= 0:
        parts.append("missing amount")
    if not parts:
        parts.append("needs review")
    return "Incomplete import: " + " and ".join(parts)


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

    incomplete_expenses = db.scalars(
        select(Expense)
        .options(joinedload(Expense.property).joinedload(Property.owner))
        .where(Expense.needs_review.is_(True))
        .order_by(Expense.created_at.desc())
    ).unique().all()

    for expense in incomplete_expenses:
        alert_id = _incomplete_expense_key(expense.id)
        if alert_id in closed_keys:
            continue
        prop = expense.property
        alerts.append(
            AlertRead(
                id=alert_id,
                alert_type="incomplete_import",
                severity="warning",
                title=f"Incomplete expense — {prop.client_prop_id if prop else 'Unknown'}",
                message=_missing_fields_message(
                    expense.review_reasons, expense.transaction_date, expense.amount
                ),
                property_id=expense.property_id,
                property_name=prop.name if prop else None,
                owner_name=prop.owner.name if prop and prop.owner else None,
                transaction_type="expense",
                expense_id=expense.id,
                transaction_date=expense.transaction_date,
                amount=expense.amount,
                section=expense.category,
                notes=expense.notes,
                review_reasons=expense.review_reasons,
                created_at=expense.created_at,
            )
        )

    incomplete_deposits = db.scalars(
        select(Deposit)
        .options(joinedload(Deposit.property).joinedload(Property.owner))
        .where(Deposit.needs_review.is_(True))
        .order_by(Deposit.created_at.desc())
    ).unique().all()

    for deposit in incomplete_deposits:
        alert_id = _incomplete_deposit_key(deposit.id)
        if alert_id in closed_keys:
            continue
        prop = deposit.property
        alerts.append(
            AlertRead(
                id=alert_id,
                alert_type="incomplete_import",
                severity="warning",
                title=f"Incomplete deposit — {prop.client_prop_id if prop else 'Unknown'}",
                message=_missing_fields_message(
                    deposit.review_reasons, deposit.transaction_date, deposit.amount
                ),
                property_id=deposit.property_id,
                property_name=prop.name if prop else None,
                owner_name=prop.owner.name if prop and prop.owner else None,
                transaction_type="deposit",
                deposit_id=deposit.id,
                transaction_date=deposit.transaction_date,
                amount=deposit.amount,
                section=deposit.description,
                notes=None,
                review_reasons=deposit.review_reasons,
                created_at=deposit.created_at,
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


def fix_incomplete_transaction(db: Session, payload: FixIncompletePayload) -> dict:
    """Set date/amount on an incomplete import row; clear needs_review when complete."""
    if payload.transaction_type == "expense":
        row = db.get(Expense, payload.id)
        if row is None:
            raise HTTPException(status_code=404, detail="Expense not found")
        if not row.needs_review:
            raise HTTPException(status_code=400, detail="Expense does not need review")

        if payload.transaction_date is not None:
            row.transaction_date = payload.transaction_date
        if payload.amount is not None:
            row.amount = payload.amount

        if row.transaction_date is not None and row.amount > 0:
            row.needs_review = False
            row.review_reasons = None

        db.commit()
        db.refresh(row)
        return {
            "transaction_type": "expense",
            "id": str(row.id),
            "needs_review": row.needs_review,
            "transaction_date": row.transaction_date.isoformat() if row.transaction_date else None,
            "amount": str(row.amount),
        }

    row = db.get(Deposit, payload.id)
    if row is None:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if not row.needs_review:
        raise HTTPException(status_code=400, detail="Deposit does not need review")

    if payload.transaction_date is not None:
        row.transaction_date = payload.transaction_date
    if payload.amount is not None:
        row.amount = payload.amount

    if row.transaction_date is not None and row.amount > 0:
        row.needs_review = False
        row.review_reasons = None

    db.commit()
    db.refresh(row)
    return {
        "transaction_type": "deposit",
        "id": str(row.id),
        "needs_review": row.needs_review,
        "transaction_date": row.transaction_date.isoformat() if row.transaction_date else None,
        "amount": str(row.amount),
    }


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
    elif alert.alert_type == "incomplete_import":
        if payload.action != "fix_incomplete" or payload.fix_incomplete is None:
            raise HTTPException(
                status_code=400,
                detail="Incomplete import alerts require action=fix_incomplete with fix payload",
            )
        fix = payload.fix_incomplete
        if alert.transaction_type == "expense":
            if fix.transaction_type != "expense" or alert.expense_id != fix.id:
                raise HTTPException(status_code=400, detail="Fix payload does not match alert")
        elif alert.transaction_type == "deposit":
            if fix.transaction_type != "deposit" or alert.deposit_id != fix.id:
                raise HTTPException(status_code=400, detail="Fix payload does not match alert")
        else:
            raise HTTPException(status_code=400, detail="Incomplete alert missing transaction type")

        result = fix_incomplete_transaction(db, fix)
        # Alert disappears when needs_review clears; only close permanently if still incomplete
        if result.get("needs_review"):
            return alert
        # Re-fetch: if fixed, alert may already be gone — return prior snapshot
        return alert
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
