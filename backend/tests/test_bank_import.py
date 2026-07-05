import uuid
from datetime import date
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.database import Base
from app.models.deposit import Deposit
from app.models.import_batch import ImportBatch
from app.services.bank_import import BankImportService
from app.services.seed import (
    ACCOUNT_DIZENGOFF,
    ACCOUNT_ROTHSCHILD,
    PROPERTY_DIZENGOFF_ID,
    seed_reference_data,
)


@pytest.fixture
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    yield session
    session.close()


def _make_excel(rows: list[dict]) -> bytes:
    df = pd.DataFrame(rows)
    buffer = BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)
    return buffer.read()


def test_first_import_inserts_all_valid_rows(db: Session) -> None:
    seed_path = Path(__file__).resolve().parents[2] / "data" / "seed" / "bank_deposits.xlsx"
    if not seed_path.exists():
        pytest.skip("Seed file not generated yet")

    service = BankImportService(db)
    result = service.import_deposits(seed_path)

    assert result.imported_count == 15
    assert result.error_count == 0
    assert db.scalars(select(Deposit)).all()
    assert len(db.scalars(select(ImportBatch)).all()) == 1


def test_second_import_creates_no_duplicates(db: Session) -> None:
    rows = [
        {
            "account_number": ACCOUNT_ROTHSCHILD,
            "transaction_date": "2026-01-05",
            "amount": 8500.00,
            "currency": "ILS",
            "reference": "DEP-TEST-001",
            "description": "Test deposit",
        }
    ]
    payload = _make_excel(rows)
    service = BankImportService(db)

    first = service.import_deposits(payload, filename="test.xlsx")
    second = service.import_deposits(payload, filename="test.xlsx")

    assert first.imported_count == 1
    assert second.imported_count == 0
    assert second.skipped_count == 1
    assert db.scalars(select(Deposit)).all().__len__() == 1


def test_unknown_account_number_reported_as_error(db: Session) -> None:
    rows = [
        {
            "account_number": "00-000-000000",
            "transaction_date": "2026-01-05",
            "amount": 1000.00,
            "currency": "ILS",
            "reference": "DEP-ORPHAN",
            "description": "Unknown account",
        },
        {
            "account_number": ACCOUNT_ROTHSCHILD,
            "transaction_date": "2026-01-05",
            "amount": 8500.00,
            "currency": "ILS",
            "reference": "DEP-VALID",
            "description": "Valid row",
        },
    ]
    service = BankImportService(db)
    result = service.import_deposits(_make_excel(rows), filename="mixed.xlsx")

    assert result.imported_count == 1
    assert result.error_count == 1
    assert result.errors[0].message.startswith("Unknown account_number")


def test_negative_amount_rejected(db: Session) -> None:
    rows = [
        {
            "account_number": ACCOUNT_ROTHSCHILD,
            "transaction_date": "2026-01-05",
            "amount": -500.00,
            "currency": "ILS",
            "reference": "DEP-NEG",
            "description": "Invalid negative",
        }
    ]
    service = BankImportService(db)
    result = service.import_deposits(_make_excel(rows), filename="negative.xlsx")

    assert result.imported_count == 0
    assert result.error_count == 1
    assert "positive" in result.errors[0].message


def test_march_gap_for_dizengoff(db: Session) -> None:
    """Dizengoff 45 has no March 2026 deposit in seed data."""
    seed_path = Path(__file__).resolve().parents[2] / "data" / "seed" / "bank_deposits.xlsx"
    if not seed_path.exists():
        pytest.skip("Seed file not generated yet")

    service = BankImportService(db)
    service.import_deposits(seed_path)

    march_deposits = db.scalars(
        select(Deposit).where(
            Deposit.property_id == PROPERTY_DIZENGOFF_ID,
            Deposit.transaction_date >= date(2026, 3, 1),
            Deposit.transaction_date <= date(2026, 3, 31),
        )
    ).all()

    assert len(march_deposits) == 0

    april_deposits = db.scalars(
        select(Deposit).where(
            Deposit.property_id == PROPERTY_DIZENGOFF_ID,
            Deposit.transaction_date >= date(2026, 4, 1),
            Deposit.transaction_date <= date(2026, 4, 30),
        )
    ).all()
    assert len(april_deposits) >= 1
    assert april_deposits[0].amount == Decimal("6200.00")
