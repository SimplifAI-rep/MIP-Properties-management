"""Holding owner/property leftovers, plus create-from-verification tagging."""

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
CREATED_FROM_VERIFICATION_REASON = "created_from_verification"
COMPANY_OWNER_NAME = "My Israel Property (MIP)"
BUFFER_PROP_ID = "BUFFER"
BUFFER_PROP_NAME = "MIP Company Buffer"
AWAITING_RETURN_PROP_ID = "AWAITING"
AWAITING_RETURN_PROP_NAME = "Awaiting return"


def is_unassigned_property(prop: Property | None) -> bool:
    return prop is not None and prop.client_prop_id == UNASSIGNED_PROP_ID


def is_awaiting_return_property(prop: Property | None) -> bool:
    return prop is not None and prop.client_prop_id == AWAITING_RETURN_PROP_ID


def _company_owner(db: Session) -> Owner:
    owner = db.scalars(select(Owner).where(Owner.name == COMPANY_OWNER_NAME)).first()
    if owner is None:
        owner = Owner(name=COMPANY_OWNER_NAME)
        db.add(owner)
        db.flush()
    return owner


def _ensure_named_property(
    db: Session,
    *,
    client_prop_id: str,
    name: str,
    address: str,
) -> Property:
    owner = _company_owner(db)
    prop = db.scalars(
        select(Property).where(Property.client_prop_id == client_prop_id)
    ).first()
    if prop is None:
        prop = Property(
            owner_id=owner.id,
            client_prop_id=client_prop_id,
            name=name,
            address=address,
            city=None,
            status="active",
        )
        db.add(prop)
        db.flush()
        return prop
    changed = False
    if prop.status != "active":
        prop.status = "active"
        changed = True
    if prop.owner_id != owner.id:
        prop.owner_id = owner.id
        changed = True
    if changed:
        db.add(prop)
        db.flush()
    return prop


def ensure_buffer_property(db: Session) -> Property:
    return _ensure_named_property(
        db,
        client_prop_id=BUFFER_PROP_ID,
        name=BUFFER_PROP_NAME,
        address="Company float / unallocated",
    )


def ensure_awaiting_return_property(db: Session) -> Property:
    """Park money-left / service-not-delivered rows without locking Finish."""
    return _ensure_named_property(
        db,
        client_prop_id=AWAITING_RETURN_PROP_ID,
        name=AWAITING_RETURN_PROP_NAME,
        address="Money left; waiting for a return or Buffer write-off",
    )


def ensure_company_holdings(db: Session) -> tuple[Property, Property]:
    return ensure_buffer_property(db), ensure_awaiting_return_property(db)


def split_review_reasons(value: str | None) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def join_review_reasons(parts: list[str]) -> str | None:
    unique: list[str] = []
    for part in parts:
        if part and part not in unique:
            unique.append(part)
    return ",".join(unique) or None


def has_review_reason(value: str | None, token: str) -> bool:
    return token in split_review_reasons(value)


def stamp_created_from_verification(row: Expense | Deposit) -> None:
    parts = split_review_reasons(getattr(row, "review_reasons", None))
    if CREATED_FROM_VERIFICATION_REASON not in parts:
        parts.append(CREATED_FROM_VERIFICATION_REASON)
    row.review_reasons = join_review_reasons(parts)


def keep_created_from_verification(reasons: str | None) -> str | None:
    """Drop other review tags but keep the created-from-verification marker."""
    if has_review_reason(reasons, CREATED_FROM_VERIFICATION_REASON):
        return CREATED_FROM_VERIFICATION_REASON
    return None


def ensure_unassigned_holding(db: Session) -> Property:
    """Create the Needs assignment / UNASSIGNED pair if missing.

    New creates no longer use this bucket. Kept so leftover rows on old
    databases can still be assigned, and so tests can seed it.
    """
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


def require_real_property(db: Session, property_id: UUID | str | None) -> Property:
    """Create-from-verification must land on a real owner/property."""
    if not property_id:
        raise ValueError("Choose an owner and property before creating the transaction.")
    try:
        uid = UUID(str(property_id))
    except (TypeError, ValueError) as exc:
        raise ValueError("Choose an owner and property before creating the transaction.") from exc
    prop = db.get(Property, uid)
    if prop is None:
        raise ValueError("Property not found.")
    if is_unassigned_property(prop):
        raise ValueError("Choose a real owner and property.")
    return prop


def reject_unassigned_for_manual_create(prop: Property) -> None:
    """Manual create must pick a real property, not the leftover holding bucket."""
    from fastapi import HTTPException

    if is_unassigned_property(prop):
        raise HTTPException(
            status_code=400,
            detail="Choose a real owner and property. UNASSIGNED is only for leftover rows.",
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
    if CREATED_FROM_VERIFICATION_REASON not in parts and has_review_reason(
        reason, CREATED_FROM_VERIFICATION_REASON
    ):
        parts.append(CREATED_FROM_VERIFICATION_REASON)
    row.review_reasons = join_review_reasons(parts)


def session_unassigned_count(db: Session, lines: list[dict]) -> int:
    """How many session-created/matched rows still sit on leftover UNASSIGNED."""
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


def _require_awaiting_row(db: Session, row: Deposit | Expense) -> Property:
    prop = db.get(Property, row.property_id)
    if not is_awaiting_return_property(prop):
        raise ValueError("That row is not on Awaiting return.")
    return prop


def write_off_awaiting_to_buffer(db: Session, row: Deposit | Expense) -> Property:
    """Give up on the return and keep the row as company Buffer."""
    _require_awaiting_row(db, row)
    buffer = ensure_buffer_property(db)
    row.property_id = buffer.id
    db.add(row)
    db.flush()
    return buffer


def record_awaiting_return(db: Session, expense: Expense) -> Deposit:
    """Money came back: Buffer payback deposit, and the expense leaves Awaiting return."""
    from datetime import date

    from app.services.payback import apply_payback_fields

    _require_awaiting_row(db, expense)
    buffer = write_off_awaiting_to_buffer(db, expense)
    label = expense.vendor_name or expense.description or expense.transaction_ref or "awaiting return"
    deposit = Deposit(
        property_id=buffer.id,
        transaction_date=expense.transaction_date or date.today(),
        amount=expense.amount,
        currency=expense.currency or "ILS",
        source="manual_entry",
        description=f"Buffer return — {label}",
        is_rental_income=False,
    )
    apply_payback_fields(
        db,
        deposit,
        is_payback=True,
        payback_of_expense_id=expense.id,
        as_http=False,
    )
    db.add(deposit)
    db.flush()
    return deposit
