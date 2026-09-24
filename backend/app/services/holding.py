"""Holding owner/property for bank-created rows that still need assignment."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property

UNASSIGNED_OWNER_NAME = "Needs assignment"
UNASSIGNED_PROP_ID = "UNASSIGNED"
UNASSIGNED_PROP_NAME = "Unassigned — needs handling"
UNASSIGNED_REVIEW_REASON = "unassigned_bank"


def is_unassigned_property(prop: Property | None) -> bool:
    return prop is not None and prop.client_prop_id == UNASSIGNED_PROP_ID


def ensure_unassigned_holding(db: Session) -> Property:
    """Create the Needs assignment / UNASSIGNED pair if missing."""
    owner = db.scalars(select(Owner).where(Owner.name == UNASSIGNED_OWNER_NAME)).first()
    if owner is None:
        owner = Owner(name=UNASSIGNED_OWNER_NAME)
        db.add(owner)
        db.flush()

    prop = db.scalars(
        select(Property).where(Property.client_prop_id == UNASSIGNED_PROP_ID)
    ).first()
    if prop is None:
        prop = Property(
            owner_id=owner.id,
            client_prop_id=UNASSIGNED_PROP_ID,
            name=UNASSIGNED_PROP_NAME,
            address="Bank lines waiting for a real property",
            city=None,
            status="active",
        )
        db.add(prop)
        db.flush()
    elif prop.owner_id != owner.id:
        prop.owner_id = owner.id
        db.add(prop)
        db.flush()
    return prop


def reject_unassigned_for_manual_create(prop: Property) -> None:
    """Manual create must pick a real property, not the holding bucket."""
    from fastapi import HTTPException

    if is_unassigned_property(prop):
        raise HTTPException(
            status_code=400,
            detail="Choose a real owner and property. UNASSIGNED is only for bank-created rows.",
        )


def clear_unassigned_review(row: Expense | Deposit, prop: Property) -> None:
    """Drop needs-handling once the row leaves UNASSIGNED and has date + amount."""
    reason = getattr(row, "review_reasons", None) or ""
    if UNASSIGNED_REVIEW_REASON not in reason.split(","):
        return
    if is_unassigned_property(prop):
        return
    if row.transaction_date is None:
        return
    if row.amount is None or row.amount <= 0:
        return
    row.needs_review = False
    parts = [part for part in reason.split(",") if part and part != UNASSIGNED_REVIEW_REASON]
    row.review_reasons = ",".join(parts) or None


def session_unassigned_count(db: Session, lines: list[dict]) -> int:
    """How many session-created/matched rows still sit on UNASSIGNED."""
    count = 0
    for line in lines:
        if line.get("status") not in {"added", "matched"}:
            continue
        raw_id = line.get("proposed_tx_id")
        if not raw_id:
            continue
        kind = line.get("proposed_kind")
        try:
            uid = UUID(str(raw_id))
        except (TypeError, ValueError):
            continue
        row: Expense | Deposit | None
        if kind == "deposit":
            row = db.get(Deposit, uid)
        else:
            row = db.get(Expense, uid)
        if row is None:
            continue
        prop = db.get(Property, row.property_id)
        if is_unassigned_property(prop):
            count += 1
    return count
