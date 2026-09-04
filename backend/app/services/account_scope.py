"""Helpers for multi bank-account and multi credit-card verification scope."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.bank_account import BankAccount

COMPANY_ACCOUNT_NUMBER = "MIP-LEUMI-OPS"
COMPANY_CC_ACCOUNT_PREFIX = "MIP-LEUMI-CC-"


def is_credit_card_account(account: BankAccount) -> bool:
    number = (account.account_number or "").upper()
    label = (account.label or "").lower()
    return number.startswith(COMPANY_CC_ACCOUNT_PREFIX) or "credit card" in label


def card_last4_from_account(account: BankAccount) -> str | None:
    number = account.account_number or ""
    if number.upper().startswith(COMPANY_CC_ACCOUNT_PREFIX):
        last4 = number[len(COMPANY_CC_ACCOUNT_PREFIX) :]
        return last4 or None
    label = account.label or ""
    if "••" in label:
        return label.rsplit("••", 1)[-1].strip() or None
    return None


def account_display_name(account: BankAccount) -> str:
    if account.label:
        return account.label
    if is_credit_card_account(account):
        last4 = card_last4_from_account(account)
        return f"Credit card ••{last4}" if last4 else "Credit card"
    return f"{account.bank_name} · {account.account_number}"


def list_operating_accounts(db: Session) -> list[BankAccount]:
    """Company-level bank accounts used for bank statement verification (not cards)."""
    rows = list(
        db.scalars(
            select(BankAccount)
            .where(BankAccount.property_id.is_(None))
            .order_by(BankAccount.label.asc().nullslast(), BankAccount.account_number.asc())
        )
    )
    company = [a for a in rows if not is_credit_card_account(a)]
    if company:
        return company
    # Fallback when only property-linked accounts exist (e.g. seed data)
    all_rows = list(
        db.scalars(
            select(BankAccount).order_by(
                BankAccount.label.asc().nullslast(), BankAccount.account_number.asc()
            )
        )
    )
    return [a for a in all_rows if not is_credit_card_account(a)]


def list_credit_card_accounts(db: Session) -> list[BankAccount]:
    rows = list(
        db.scalars(
            select(BankAccount)
            .where(BankAccount.property_id.is_(None))
            .order_by(BankAccount.account_number.asc())
        )
    )
    return [a for a in rows if is_credit_card_account(a)]


def get_default_operating_account(db: Session) -> BankAccount | None:
    ops = db.scalars(
        select(BankAccount).where(BankAccount.account_number == COMPANY_ACCOUNT_NUMBER)
    ).first()
    if ops:
        return ops
    accounts = list_operating_accounts(db)
    return accounts[0] if accounts else None


def ensure_default_operating_account(db: Session, *, currency: str = "ILS") -> BankAccount:
    existing = get_default_operating_account(db)
    if existing:
        return existing
    account = BankAccount(
        property_id=None,
        bank_name="Bank Leumi",
        account_number=COMPANY_ACCOUNT_NUMBER,
        currency=currency,
        label="MIP operating account",
    )
    db.add(account)
    db.flush()
    return account


def get_operating_account(
    db: Session, bank_account_id: UUID | str | None
) -> BankAccount | None:
    if bank_account_id is None:
        return ensure_default_operating_account(db)
    account = db.get(BankAccount, UUID(str(bank_account_id)))
    if account is None:
        raise ValueError("Bank account not found")
    if is_credit_card_account(account):
        raise ValueError("Selected account is a credit card, not a bank operating account")
    return account


def ensure_cc_account(db: Session, card_last4: str, *, currency: str = "ILS") -> BankAccount:
    last4 = (card_last4 or "").strip()
    if not last4 or last4 == "unknown":
        raise ValueError("card_last4 is required")
    account_number = f"{COMPANY_CC_ACCOUNT_PREFIX}{last4}"
    existing = db.scalars(
        select(BankAccount).where(BankAccount.account_number == account_number)
    ).first()
    if existing:
        return existing
    account = BankAccount(
        property_id=None,
        bank_name="Bank Leumi Mastercard",
        account_number=account_number,
        currency=currency,
        label=f"Credit card ••{last4}",
    )
    db.add(account)
    db.flush()
    return account


def deposit_belongs_to_account_clause(bank_account_id: UUID | None, *, is_default: bool):
    """SQLAlchemy filter for deposits belonging to a bank account.

    Null deposit.bank_account_id is treated as the default operating account
    (legacy rows from before multi-account support).
    """
    from app.models.deposit import Deposit

    if bank_account_id is None:
        return True
    if is_default:
        return or_(
            Deposit.bank_account_id == bank_account_id,
            Deposit.bank_account_id.is_(None),
        )
    return Deposit.bank_account_id == bank_account_id
