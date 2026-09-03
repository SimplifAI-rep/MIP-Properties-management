"""Company bank reconcile settings: opening balance, last verification, cutover."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.bank_account import BankAccount
from app.models.company_bank_settings import CompanyBankSettings
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services.account_scope import (
    get_default_operating_account,
    get_operating_account,
)
from app.services.transaction_ref import ensure_company_bank_settings_row


def get_or_create_settings(db: Session) -> CompanyBankSettings:
    ensure_company_bank_settings_row(db)
    row = db.scalar(
        select(CompanyBankSettings).where(CompanyBankSettings.singleton_key == 1)
    )
    assert row is not None
    return row


def _sync_account_from_company_if_empty(db: Session, account: BankAccount) -> None:
    """One-time seed: copy company singleton O/D_last onto default account when empty."""
    if account.opening_balance is not None or account.last_verification_date is not None:
        return
    company = get_or_create_settings(db)
    if company.opening_balance is None and company.last_verification_date is None:
        return
    account.opening_balance = company.opening_balance
    account.opening_balance_as_of = company.opening_balance_as_of
    account.last_verification_date = company.last_verification_date
    db.add(account)
    db.flush()


def resolve_account_settings(
    db: Session, *, bank_account_id: UUID | str | None = None
) -> tuple[BankAccount | None, CompanyBankSettings]:
    """Return (operating account, company settings) with account fields preferred."""
    company = get_or_create_settings(db)
    account = get_operating_account(db, bank_account_id)
    if account is not None:
        _sync_account_from_company_if_empty(db, account)
    return account, company


def effective_opening_balance(
    account: BankAccount | None, company: CompanyBankSettings
) -> Decimal | None:
    if account is not None and account.opening_balance is not None:
        return account.opening_balance
    return company.opening_balance


def effective_opening_as_of(
    account: BankAccount | None, company: CompanyBankSettings
) -> date | None:
    if account is not None and account.opening_balance_as_of is not None:
        return account.opening_balance_as_of
    return company.opening_balance_as_of


def effective_last_verification(
    account: BankAccount | None, company: CompanyBankSettings
) -> date | None:
    if account is not None and account.last_verification_date is not None:
        return account.last_verification_date
    return company.last_verification_date


def count_unverified_since(
    db: Session,
    *,
    last_verification_date: date | None,
    bank_account_id: UUID | None = None,
) -> int:
    """Bank-scoped txs still unverified after the last verification date."""
    from app.services.account_scope import (
        deposit_belongs_to_account_clause,
        get_default_operating_account,
    )

    default = get_default_operating_account(db)
    is_default = (
        bank_account_id is None
        or (default is not None and bank_account_id == default.id)
    )
    deposit_filters = [
        Deposit.bank_verified_at.is_(None),
        Deposit.bank_reconcile_exclude.is_(False),
        Deposit.is_rental_income.is_(False),
    ]
    if bank_account_id is not None:
        deposit_filters.append(
            deposit_belongs_to_account_clause(bank_account_id, is_default=is_default)
        )

    expense_filters = [
        Expense.bank_verified_at.is_(None),
        Expense.bank_reconcile_exclude.is_(False),
        Expense.paid_by_owner.is_(False),
        Expense.paid_by_resident.is_(False),
        Expense.payment_method != "credit_card",
    ]
    # Expenses only count against the default operating account
    include_expenses = is_default

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
    expenses = 0
    if include_expenses:
        expenses = db.scalar(
            select(func.count()).select_from(Expense).where(*expense_filters)
        )
    return int(deposits or 0) + int(expenses or 0)


def update_settings(
    db: Session,
    *,
    bank_account_id: UUID | str | None = None,
    opening_balance: Decimal | None = None,
    opening_balance_as_of: date | None = None,
    last_verification_date: date | None = None,
    gap_tolerance_amount: Decimal | None = None,
    clear_opening_balance: bool = False,
    clear_opening_balance_as_of: bool = False,
    clear_last_verification_date: bool = False,
) -> tuple[BankAccount | None, CompanyBankSettings]:
    account, company = resolve_account_settings(db, bank_account_id=bank_account_id)

    if gap_tolerance_amount is not None:
        if gap_tolerance_amount < 0:
            raise ValueError("gap_tolerance_amount must be >= 0")
        company.gap_tolerance_amount = gap_tolerance_amount
        db.add(company)

    target = account if account is not None else company
    if clear_opening_balance:
        target.opening_balance = None
    elif opening_balance is not None:
        target.opening_balance = opening_balance
    if clear_opening_balance_as_of:
        target.opening_balance_as_of = None
    elif opening_balance_as_of is not None:
        target.opening_balance_as_of = opening_balance_as_of
    if clear_last_verification_date:
        target.last_verification_date = None
    elif last_verification_date is not None:
        target.last_verification_date = last_verification_date

    # Keep company singleton mirrored when editing the default account
    default = get_default_operating_account(db)
    if account is not None and default is not None and account.id == default.id:
        company.opening_balance = account.opening_balance
        company.opening_balance_as_of = account.opening_balance_as_of
        company.last_verification_date = account.last_verification_date
        db.add(company)

    db.add(target)
    db.commit()
    if account is not None:
        db.refresh(account)
    db.refresh(company)
    return account, company


def run_go_live_cutover(
    db: Session,
    *,
    opening_balance: Decimal,
    as_of_date: date,
    gap_tolerance_amount: Decimal | None = None,
    bank_account_id: UUID | str | None = None,
) -> tuple[BankAccount | None, CompanyBankSettings, int, int]:
    """Set O + as-of, mark txs with transaction_date ≤ as-of as bank-verified."""
    if opening_balance is None:
        raise ValueError("opening_balance is required")
    now = datetime.now(timezone.utc)
    account, company = resolve_account_settings(db, bank_account_id=bank_account_id)
    default = get_default_operating_account(db)
    is_default = account is None or (
        default is not None and account.id == default.id
    )

    from app.services.account_scope import deposit_belongs_to_account_clause

    dep_filters = [
        Deposit.transaction_date.is_not(None),
        Deposit.transaction_date <= as_of_date,
    ]
    if account is not None:
        dep_filters.append(
            deposit_belongs_to_account_clause(account.id, is_default=is_default)
        )

    dep_result = db.execute(update(Deposit).where(*dep_filters).values(bank_verified_at=now))

    expenses_marked = 0
    if is_default:
        exp_result = db.execute(
            update(Expense)
            .where(
                Expense.transaction_date.is_not(None),
                Expense.transaction_date <= as_of_date,
            )
            .values(bank_verified_at=now)
        )
        expenses_marked = int(exp_result.rowcount or 0)

    if gap_tolerance_amount is not None:
        if gap_tolerance_amount < 0:
            raise ValueError("gap_tolerance_amount must be >= 0")
        company.gap_tolerance_amount = gap_tolerance_amount

    if account is not None:
        account.opening_balance = opening_balance
        account.opening_balance_as_of = as_of_date
        account.last_verification_date = as_of_date
        db.add(account)
        if is_default:
            company.opening_balance = opening_balance
            company.opening_balance_as_of = as_of_date
            company.last_verification_date = as_of_date
    else:
        company.opening_balance = opening_balance
        company.opening_balance_as_of = as_of_date
        company.last_verification_date = as_of_date

    db.add(company)
    db.commit()
    if account is not None:
        db.refresh(account)
    db.refresh(company)

    deposits_marked = int(dep_result.rowcount or 0)
    return account, company, deposits_marked, expenses_marked


def settings_read_payload(
    db: Session, *, bank_account_id: UUID | str | None = None
) -> dict:
    account, company = resolve_account_settings(db, bank_account_id=bank_account_id)
    last = effective_last_verification(account, company)
    opening = effective_opening_balance(account, company)
    as_of = effective_opening_as_of(account, company)
    tolerance = (
        company.gap_tolerance_amount
        if company.gap_tolerance_amount is not None
        else Decimal("0.01")
    )
    return {
        "bank_account_id": str(account.id) if account else None,
        "bank_account_label": account.label if account else None,
        "account_number": account.account_number if account else None,
        "opening_balance": opening,
        "opening_balance_as_of": as_of,
        "last_verification_date": last,
        "gap_tolerance_amount": tolerance,
        "unverified_count": count_unverified_since(
            db,
            last_verification_date=last,
            bank_account_id=account.id if account else None,
        ),
    }
