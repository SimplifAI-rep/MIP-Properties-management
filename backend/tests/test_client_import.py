"""Unit tests for client property-id normalization and Excel import."""

from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import PROJECT_ROOT
from app.core.database import Base
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property
from app.services.client_import import (
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
    assert report["database"]["expenses"] == report["excel"]["expected_expenses_total"]
    assert report["database"]["deposits"] == report["excel"]["expected_deposits_total"]

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
