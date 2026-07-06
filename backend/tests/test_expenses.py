from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data, seed_sample_expenses


@pytest.fixture
def db():
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


def test_list_expenses_returns_seeded_data(client):
    response = client.get("/api/v1/expenses")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 6
    assert len(body["items"]) == 6
    assert body["items"][0]["property_name"]


def test_filter_expenses_by_category(client):
    response = client.get("/api/v1/expenses?category=utilities")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert all(item["category"] == "utilities" for item in body["items"])


def test_filter_expenses_by_source(client):
    response = client.get("/api/v1/expenses?source=standing_order")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert all(item["source"] == "standing_order" for item in body["items"])


def test_expense_summary(client):
    response = client.get("/api/v1/expenses/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["expense_count"] == 6
    assert Decimal(body["total_amount"]) > 0
    assert len(body["by_category"]) >= 3


def test_create_manual_expense(client):
    response = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-03-10",
            "amount": "350.00",
            "category": "maintenance",
            "source": "manual_owner",
            "payment_method": "owner_personal",
            "description": "Owner-paid locksmith",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["category"] == "maintenance"
    assert body["source"] == "manual_owner"
    assert body["property_name"] == "Rothschild 12"


def test_create_expense_rejects_invalid_category(client):
    response = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-03-10",
            "amount": "100.00",
            "category": "invalid",
            "source": "manual_owner",
            "payment_method": "owner_personal",
        },
    )
    assert response.status_code == 400


def test_create_expense_rejects_non_positive_amount(client):
    response = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-03-10",
            "amount": "0",
            "category": "maintenance",
            "source": "manual_owner",
            "payment_method": "owner_personal",
        },
    )
    assert response.status_code == 422
