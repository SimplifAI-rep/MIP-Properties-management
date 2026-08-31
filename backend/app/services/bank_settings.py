"""Company bank reconcile settings: opening balance, last verification, cutover."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.company_bank_settings import CompanyBankSettings
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services.transaction_ref import ensure_company_bank_settings_row


def get_or_create_settings(db: Session) -> CompanyBankSettings:
    ensure_company_bank_settings_row(db)
    row = db.scalar(
        select(CompanyBankSettings).where(CompanyBankSettings.singleton_key == 1)
    )
    assert row is not None
    return row


def count_unverified_since(
    db: Session, *, last_verification_date: date | None
) -> int:
    """Bank-scoped txs still unverified after the last verification date.

    Includes rows with no date (incomplete) and rows dated after D_last.
    Excludes bank_reconcile_exclude and owner/resident-paid expenses.
    """
    deposit_filters = [
        Deposit.bank_verified_at.is_(None),
        Deposit.bank_reconcile_exclude.is_(False),
        Deposit.is_rental_income.is_(False),
    ]
    expense_filters = [
        Expense.bank_verified_at.is_(None),
        Expense.bank_reconcile_exclude.is_(False),
        Expense.paid_by_owner.is_(False),
        Expense.paid_by_resident.is_(False),
        Expense.payment_method != "credit_card",
    ]
    if last_verification_date is not None:
        deposit_filters.append(
            or_(
                Deposit.transaction_date.is_(None),
                Deposit.transaction_date > last_verification_date,
            )
        )
        expense_filters.append(
            or_(
                Expense.transaction_date.is_(None),
                Expense.transaction_date > last_verification_date,
            )
        )

    deposits = db.scalar(select(func.count()).select_from(Deposit).where(*deposit_filters))
    expenses = db.scalar(select(func.count()).select_from(Expense).where(*expense_filters))
    return int(deposits or 0) + int(expenses or 0)


def update_settings(
    db: Session,
    *,
    opening_balance: Decimal | None = None,
    opening_balance_as_of: date | None = None,
    last_verification_date: date | None = None,
    gap_tolerance_amount: Decimal | None = None,
    clear_opening_balance: bool = False,
    clear_opening_balance_as_of: bool = False,
    clear_last_verification_date: bool = False,
) -> CompanyBankSettings:
    row = get_or_create_settings(db)
    if clear_opening_balance:
        row.opening_balance = None
    elif opening_balance is not None:
        row.opening_balance = opening_balance
    if clear_opening_balance_as_of:
        row.opening_balance_as_of = None
    elif opening_balance_as_of is not None:
        row.opening_balance_as_of = opening_balance_as_of
    if clear_last_verification_date:
        row.last_verification_date = None
    elif last_verification_date is not None:
        row.last_verification_date = last_verification_date
    if gap_tolerance_amount is not None:
        if gap_tolerance_amount < 0:
            raise ValueError("gap_tolerance_amount must be >= 0")
        row.gap_tolerance_amount = gap_tolerance_amount
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def run_go_live_cutover(
    db: Session,
    *,
    opening_balance: Decimal,
    as_of_date: date,
    gap_tolerance_amount: Decimal | None = None,
) -> tuple[CompanyBankSettings, int, int]:
    """Set O + D₀, mark txs with transaction_date ≤ D₀ as bank-verified (no אסמכתא)."""
    if opening_balance is None:
        raise ValueError("opening_balance is required")
    now = datetime.now(timezone.utc)

    dep_result = db.execute(
        update(Deposit)
        .where(
            Deposit.transaction_date.is_not(None),
            Deposit.transaction_date <= as_of_date,
        )
        .values(bank_verified_at=now)
        # leave bank_asmachta null — cutover baseline
    )
    exp_result = db.execute(
        update(Expense)
        .where(
            Expense.transaction_date.is_not(None),
            Expense.transaction_date <= as_of_date,
        )
        .values(bank_verified_at=now)
    )

    row = get_or_create_settings(db)
    row.opening_balance = opening_balance
    row.opening_balance_as_of = as_of_date
    row.last_verification_date = as_of_date
    if gap_tolerance_amount is not None:
        if gap_tolerance_amount < 0:
            raise ValueError("gap_tolerance_amount must be >= 0")
        row.gap_tolerance_amount = gap_tolerance_amount
    db.add(row)
    db.commit()
    db.refresh(row)

    deposits_marked = int(dep_result.rowcount or 0)
    expenses_marked = int(exp_result.rowcount or 0)
    return row, deposits_marked, expenses_marked
