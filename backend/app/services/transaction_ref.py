"""SimplifAI transaction_ref (date-based) allocation and backfill."""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense

_REF_SUFFIX_RE = re.compile(r"^(\d{8})-(\d+)$")


def _prefix_for(tx_date: date | None) -> str:
    d = tx_date or date.today()
    return d.strftime("%Y%m%d")


def _max_seq_for_prefix(db: Session, prefix: str) -> int:
    """Highest #### used for this date prefix across deposits and expenses."""
    pattern = f"{prefix}-%"
    max_seq = 0
    for model in (Deposit, Expense):
        rows = db.scalars(
            select(model.transaction_ref).where(model.transaction_ref.like(pattern))
        ).all()
        for ref in rows:
            if not ref:
                continue
            match = _REF_SUFFIX_RE.match(ref)
            if match and match.group(1) == prefix:
                max_seq = max(max_seq, int(match.group(2)))
    return max_seq


def allocate_transaction_ref(db: Session, tx_date: date | None = None) -> str:
    """Next unique date-based ref, e.g. 20260708-0042 (session-cached per prefix)."""
    prefix = _prefix_for(tx_date)
    key = f"_tx_ref_seq_{prefix}"
    if key not in db.info:
        db.info[key] = _max_seq_for_prefix(db, prefix)
    db.info[key] = int(db.info[key]) + 1
    return f"{prefix}-{db.info[key]:04d}"


def backfill_missing_transaction_refs(db: Session) -> int:
    """Assign refs to existing rows missing transaction_ref. Returns count updated."""
    updated = 0
    for model in (Deposit, Expense):
        rows = db.scalars(
            select(model).where(
                (model.transaction_ref.is_(None)) | (model.transaction_ref == "")
            )
        ).all()
        # Stable order: date then created_at then id
        rows.sort(
            key=lambda r: (
                r.transaction_date or date.min,
                getattr(r, "created_at", None) or datetime.min.replace(tzinfo=timezone.utc),
                str(r.id),
            )
        )
        for row in rows:
            row.transaction_ref = allocate_transaction_ref(db, row.transaction_date)
            updated += 1
    if updated:
        db.commit()
    return updated


def _assign_ref_before_insert(mapper, connection, target) -> None:  # noqa: ARG001
    if getattr(target, "transaction_ref", None):
        return
    session = Session.object_session(target)
    if session is None:
        # Fallback if somehow no session (should be rare)
        prefix = _prefix_for(getattr(target, "transaction_date", None))
        target.transaction_ref = f"{prefix}-0001"
        return
    target.transaction_ref = allocate_transaction_ref(
        session, getattr(target, "transaction_date", None)
    )


def register_transaction_ref_listeners() -> None:
    """Idempotent: attach before_insert listeners so all create paths get a ref."""
    for model in (Deposit, Expense):
        # Avoid double-registration across reloads
        if getattr(model, "_tx_ref_listener_registered", False):
            continue
        event.listen(model, "before_insert", _assign_ref_before_insert)
        setattr(model, "_tx_ref_listener_registered", True)


def ensure_company_bank_settings_row(db: Session) -> None:
    from decimal import Decimal

    from app.models.company_bank_settings import CompanyBankSettings

    existing = db.scalar(
        select(CompanyBankSettings).where(CompanyBankSettings.singleton_key == 1)
    )
    if existing:
        return
    db.add(
        CompanyBankSettings(
            singleton_key=1,
            gap_tolerance_amount=Decimal("0.01"),
        )
    )
    db.commit()
