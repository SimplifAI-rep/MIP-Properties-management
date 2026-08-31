from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.expense import Expense
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data, seed_sample_expenses
from app.services.transaction_ref import register_transaction_ref_listeners


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


def test_get_bank_settings_defaults(client):
    response = client.get("/api/v1/bank-settings")
    assert response.status_code == 200
    body = response.json()
    assert body["opening_balance"] is None
    assert body["last_verification_date"] is None
    assert Decimal(body["gap_tolerance_amount"]) == Decimal("0.01")
    assert body["unverified_count"] >= 0


def test_patch_bank_settings(client):
    response = client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "114834.88",
            "opening_balance_as_of": "2026-07-09",
            "last_verification_date": "2026-07-09",
            "gap_tolerance_amount": "1.00",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert Decimal(body["opening_balance"]) == Decimal("114834.88")
    assert body["opening_balance_as_of"] == "2026-07-09"
    assert body["last_verification_date"] == "2026-07-09"
    assert Decimal(body["gap_tolerance_amount"]) == Decimal("1.00")


def test_go_live_cutover_marks_verified(client, db):
    # Seed expenses are dated in 2026-01 / 2026-02 range typically — use late cutover
    cutover = "2026-12-31"
    response = client.post(
        "/api/v1/bank-settings/cutover",
        json={
            "opening_balance": "100000.00",
            "as_of_date": cutover,
            "gap_tolerance_amount": "0.01",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["expenses_marked"] >= 6
    assert body["settings"]["last_verification_date"] == cutover
    assert Decimal(body["settings"]["opening_balance"]) == Decimal("100000.00")

    expenses = db.scalars(select(Expense)).all()
    assert all(e.bank_verified_at is not None for e in expenses)
    assert all(e.bank_asmachta is None for e in expenses)

    # New expense after cutover stays unverified
    create = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2027-01-15",
            "amount": "50.00",
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
        },
    )
    assert create.status_code == 201
    assert create.json().get("bank_verified_at") is None

    settings = client.get("/api/v1/bank-settings").json()
    assert settings["unverified_count"] >= 1
