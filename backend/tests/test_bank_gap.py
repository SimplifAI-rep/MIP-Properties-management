from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.expense import Expense
from app.services.bank_reconcile_gap import parse_bank_statement_balance, sum_bank_scoped_nets
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data, seed_sample_expenses
from app.services.transaction_ref import register_transaction_ref_listeners

SAMPLE_BANK = (
    Path(__file__).resolve().parents[2] / "data" / "ClientData" / "Bank Account example.xlsx"
)
# Repo layout: SimplifAI/data/... vs backend/tests → parents[2] is SimplifAI if tests under backend/tests
if not SAMPLE_BANK.exists():
    SAMPLE_BANK = (
        Path(__file__).resolve().parents[2].parent
        / "data"
        / "ClientData"
        / "Bank Account example.xlsx"
    )


@pytest.fixture
def db():
    register_transaction_ref_listeners()
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    seed_sample_expenses(session)
    yield session
    session.close()


@pytest.fixture
def client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_sum_bank_scoped_nets_excludes_owner_paid(db):
    before_all, before_ver, _, _ = sum_bank_scoped_nets(db, after_date=None)
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 3, 1),
            amount=Decimal("999.00"),
            category="maintenance",
            source="manual_owner",
            payment_method="owner_personal",
            paid_by_owner=True,
            description="Owner paid plumber",
        )
    )
    db.commit()
    after_all, after_ver, _, _ = sum_bank_scoped_nets(db, after_date=None)
    assert after_all == before_all
    assert after_ver == before_ver


def test_gap_endpoint_with_balance(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "1000.00",
            "opening_balance_as_of": "2025-12-31",
            "last_verification_date": "2025-12-31",
        },
    )
    # Mark seeded expenses verified so verified net moves
    for expense in db.query(Expense).all():
        expense.bank_verified_at = date(2026, 1, 1)
    db.commit()

    response = client.get("/api/v1/bank-settings/gap", params={"bank_balance": "5000"})
    assert response.status_code == 200
    body = response.json()
    assert Decimal(body["opening_balance"]) == Decimal("1000.00")
    assert body["gap_verified"] is not None
    assert body["gap_all_scoped"] is not None
    # Gap = B - (O + N) → with B=5000, O=1000, N = expenses sum as negative net
    assert Decimal(body["all_scoped_expenses"]) > 0


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_parse_bank_statement_balance_from_sample():
    content = SAMPLE_BANK.read_bytes()
    parsed = parse_bank_statement_balance(content)
    assert parsed["bank_balance"] is not None
    assert parsed["movement_row_count"] > 0
    assert isinstance(parsed["statement_start_date"], date)
    assert isinstance(parsed["statement_end_date"], date)
    assert parsed["statement_start_date"] <= parsed["statement_end_date"]


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_parse_bank_balance_upload_endpoint(client):
    with SAMPLE_BANK.open("rb") as handle:
        response = client.post(
            "/api/v1/bank-settings/parse-bank-balance",
            files={
                "file": (
                    "Bank Account example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert Decimal(body["bank_balance"]) != 0
    assert body["movement_row_count"] > 0
    # Net-through-date default: earliest movement date as plain YYYY-MM-DD
    assert body["statement_start_date"] == "2026-06-02"
    assert body["statement_end_date"] == "2026-07-08"
    assert "T" not in body["statement_start_date"]
