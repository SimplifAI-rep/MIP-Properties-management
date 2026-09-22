"""Company credit cards: list, add by hand, activate / deactivate."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.bank_account import BankAccount
from app.models.cc_reconcile_session import CcReconcileSession
from app.services.account_scope import (
    COMPANY_CC_ACCOUNT_PREFIX,
    account_display_name,
    card_last4_from_account,
    is_credit_card_account,
    list_credit_card_accounts,
)


def normalize_card_last4(value: str | None) -> str:
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) < 4:
        raise ValueError("Enter the last 4 digits of the card")
    return digits[-4:]


def _open_session_id(db: Session, last4: str) -> str | None:
    session = db.scalars(
        select(CcReconcileSession).where(
            CcReconcileSession.status == "in_progress",
            CcReconcileSession.card_last4 == last4,
        )
    ).first()
    return str(session.id) if session else None


def card_to_read(db: Session, account: BankAccount) -> dict:
    last4 = card_last4_from_account(account) or ""
    return {
        "id": str(account.id),
        "card_last4": last4,
        "label": account_display_name(account),
        "bank_name": account.bank_name,
        "is_active": bool(getattr(account, "is_active", True)),
        "open_session_id": _open_session_id(db, last4) if last4 else None,
    }


def list_cards(db: Session) -> list[dict]:
    return [card_to_read(db, account) for account in list_credit_card_accounts(db)]


def create_card(
    db: Session,
    *,
    card_last4: str,
    label: str | None = None,
    bank_name: str | None = None,
    is_active: bool = True,
) -> BankAccount:
    last4 = normalize_card_last4(card_last4)
    account_number = f"{COMPANY_CC_ACCOUNT_PREFIX}{last4}"
    existing = db.scalars(
        select(BankAccount).where(BankAccount.account_number == account_number)
    ).first()
    if existing:
        raise ValueError(f"Card ••{last4} is already on the list")
    name = (label or "").strip() or f"Credit card ••{last4}"
    account = BankAccount(
        property_id=None,
        bank_name=(bank_name or "").strip() or "Bank Leumi Mastercard",
        account_number=account_number,
        currency="ILS",
        label=name,
        is_active=is_active,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


def get_card(db: Session, card_id: UUID | str) -> BankAccount:
    account = db.get(BankAccount, UUID(str(card_id)))
    if account is None or not is_credit_card_account(account):
        raise ValueError("Credit card not found")
    return account


def update_card(
    db: Session,
    card_id: UUID | str,
    *,
    label: str | None = None,
    bank_name: str | None = None,
    is_active: bool | None = None,
) -> BankAccount:
    account = get_card(db, card_id)
    if label is not None:
        text = label.strip()
        last4 = card_last4_from_account(account)
        account.label = text or (f"Credit card ••{last4}" if last4 else "Credit card")
    if bank_name is not None:
        account.bank_name = bank_name.strip() or account.bank_name
    if is_active is not None:
        account.is_active = is_active
    db.add(account)
    db.commit()
    db.refresh(account)
    return account
