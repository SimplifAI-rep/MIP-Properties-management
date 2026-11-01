"""Unit tests for client property-id normalization and Excel import."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from openpyxl import Workbook
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import PROJECT_ROOT
from app.core.database import Base
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property
from app.services.bank_settings import mark_reset_import_verified, resolve_account_settings
from app.services.client_import import (
    CLIENT_LIST_FILE,
    MANAGEMENT_FILE,
    normalize_prop_key,
    prop_key_aliases,
    import_client_data,
)
from app.services.client_import_verify import verify_against_excel

CLIENT_DATA = PROJECT_ROOT / "data" / "ClientData"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("5 or 05 ex", "5"),
        ("05 ex", "5"),
        ("C4or c4 EX", "C4"),
        ("C6 or 06 ex", "C6"),
        ("N160", "N160"),
        ("p14", "P14"),
        ("273 or 273 EX", "273"),
        (5, "5"),
        ("  111  ", "111"),
    ],
)
def test_normalize_prop_key(raw, expected):
    assert normalize_prop_key(raw) == expected


def test_prop_key_aliases_include_both_sides():
    aliases = prop_key_aliases("C6 or 06 ex")
    assert "C6" in aliases
    assert "6" in aliases


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.mark.skipif(not CLIENT_DATA.exists(), reason="ClientData folder missing")
def test_client_excel_import_matches_verify(db):
    stats = import_client_data(db, data_dir=CLIENT_DATA)
    assert stats.expenses_created > 0
    assert stats.deposits_created > 0
    assert not stats.errors

    report = verify_against_excel(db, CLIENT_DATA)
    assert report["ok"] is True, report["mismatches"]
    # Totals include incomplete/needs_review mgmt rows beyond unique dated Excel keys
    assert report["database"]["expenses"] >= report["excel"]["expected_expenses_total"]
    assert report["database"]["deposits"] >= report["excel"]["expected_deposits_total"]
    # Incomplete (needs_review) rows explain surplus over dated Excel money keys
    expense_surplus = (
        report["database"]["expenses"] - report["excel"]["expected_expenses_total"]
    )
    deposit_surplus = (
        report["database"]["deposits"] - report["excel"]["expected_deposits_total"]
    )
    assert expense_surplus + deposit_surplus <= stats.needs_review_created + 15
    assert expense_surplus >= 0 and deposit_surplus >= 0
    assert stats.skip_reason_counts.get("imported_needs_review", 0) == 0

    # Idempotent second pass
    stats2 = import_client_data(db, data_dir=CLIENT_DATA)
    assert stats2.expenses_created == 0
    assert stats2.deposits_created == 0

    prop_count = db.scalar(select(func.count()).select_from(Property)) or 0
    assert prop_count >= 29  # current clients + BUFFER (+ ledger-only)


@pytest.mark.skipif(not CLIENT_DATA.exists(), reason="ClientData folder missing")
def test_sample_property_5_has_ledger_rows(db):
    import_client_data(db, data_dir=CLIENT_DATA)
    prop = db.scalars(select(Property).where(Property.client_prop_id == "5")).first()
    assert prop is not None
    expenses = db.scalar(
        select(func.count()).select_from(Expense).where(Expense.property_id == prop.id)
    )
    deposits = db.scalar(
        select(func.count()).select_from(Deposit).where(Deposit.property_id == prop.id)
    )
    assert expenses and expenses > 0
    assert deposits and deposits > 0


def _write_mini_client_data(data_dir: Path) -> None:
    clients = Workbook()
    ws = clients.active
    ws.title = "current clients"
    ws.append(["Property number", "Last", "First", "Hebrew", "Address", "City"])
    ws.append(["H111", "Test", "Owner", None, "1 Test St", "Tel Aviv"])
    clients.save(data_dir / CLIENT_LIST_FILE)

    mgmt = Workbook()
    sheet = mgmt.active
    sheet.title = "H111"
    sheet.append(["Date", "Amount", "Inflow", "Section", "Notes"])
    sheet.append([date(2026, 1, 15), 100, None, "Electric", "first"])
    sheet.append([date(2026, 1, 15), 100, None, "Electric", "second"])
    sheet.append([date(2026, 1, 16), None, 250, "Inflow", "deposit one"])
    sheet.append([date(2026, 1, 16), None, 250, "Inflow", "deposit two"])
    sheet.append([None, 80, None, "Missing date", "incomplete with amount"])
    mgmt.save(data_dir / MANAGEMENT_FILE)


def test_duplicate_ledger_rows_with_amount_all_import(db, tmp_path):
    _write_mini_client_data(tmp_path)
    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors
    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    assert len(expenses) == 3
    assert len(deposits) == 2
    assert stats.expenses_skipped == 0
    assert stats.deposits_skipped == 0
    assert stats.skip_reason_counts.get("duplicate_expense", 0) == 0
    assert stats.skip_reason_counts.get("duplicate_deposit", 0) == 0
    assert stats.skip_reason_counts.get("imported_needs_review", 0) == 0
    assert stats.needs_review_created == 1
    incomplete = [row for row in expenses if row.needs_review]
    assert len(incomplete) == 1
    assert incomplete[0].amount == Decimal("80.00")
    assert incomplete[0].transaction_date is None

    stats2 = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert stats2.expenses_created == 0
    assert stats2.deposits_created == 0
    assert stats2.expenses_skipped >= 2
    assert stats2.deposits_skipped >= 2


def test_reset_import_marks_dated_transactions_verified(db, tmp_path):
    _write_mini_client_data(tmp_path)
    import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    dep_n, exp_n, as_of = mark_reset_import_verified(db)
    db.expire_all()
    assert dep_n == 2
    assert exp_n == 2
    assert as_of == date(2026, 1, 16)

    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    dated = [row for row in expenses if row.transaction_date is not None]
    undated = [row for row in expenses if row.transaction_date is None]
    assert dated and all(row.bank_verified_at is not None for row in dated)
    assert undated and all(row.bank_verified_at is None for row in undated)
    assert all(row.bank_verified_at is not None for row in deposits)

    account, company = resolve_account_settings(db)
    last = (
        account.last_verification_date
        if account is not None and account.last_verification_date is not None
        else company.last_verification_date
    )
    assert last == date(2026, 1, 16)
    opening = account.opening_balance if account is not None else company.opening_balance
    assert opening is None
