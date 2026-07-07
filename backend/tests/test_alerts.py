from io import BytesIO
from uuid import UUID

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.alert_action import AlertAction
from app.models.deposit import Deposit
from app.services.seed import (
    ACCOUNT_ROTHSCHILD,
    PROPERTY_ROTHSCHILD_ID,
    seed_reference_data,
)


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


def _make_excel(rows: list[dict]) -> bytes:
    df = pd.DataFrame(rows)
    buffer = BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)
    return buffer.read()


def test_list_alerts_includes_missing_deposit_gaps(client):
    response = client.get("/api/v1/alerts")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 1
    assert any(item["alert_type"] == "missing_deposit" for item in body["items"])


def test_list_alerts_includes_pending_upload(client):
    payload = _make_excel(
        [
            {
                "transaction_date": "2026-05-01",
                "amount": 120,
                "category": "maintenance",
                "source": "manual_company",
                "payment_method": "company_account",
            }
        ]
    )
    analyze = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "expense",
        },
        files={"file": ("expenses.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert analyze.status_code == 200

    response = client.get("/api/v1/alerts")
    assert response.status_code == 200
    body = response.json()
    assert any(item["alert_type"] in {"upload_pending", "duplicate_deposit"} for item in body["items"])


def test_dismiss_alert_removes_from_list(client):
    initial = client.get("/api/v1/alerts").json()
    gap_alert = next(item for item in initial["items"] if item["alert_type"] == "missing_deposit")

    dismiss = client.post(f"/api/v1/alerts/{gap_alert['id']}/dismiss")
    assert dismiss.status_code == 200

    after = client.get("/api/v1/alerts").json()
    assert all(item["id"] != gap_alert["id"] for item in after["items"])


def test_resolve_missing_deposit_adds_deposit_and_closes_alert(client, db):
    initial = client.get("/api/v1/alerts").json()
    gap_alert = next(item for item in initial["items"] if item["alert_type"] == "missing_deposit")
    property_id = gap_alert["property_id"]

    property_detail = client.get(f"/api/v1/properties/{property_id}").json()
    bank_account_id = property_detail["bank_accounts"][0]["id"]

    resolve = client.post(
        f"/api/v1/alerts/{gap_alert['id']}/resolve",
        json={
            "action": "add_deposit",
            "deposit": {
                "property_id": property_id,
                "bank_account_id": bank_account_id,
                "transaction_date": gap_alert["gap"]["period_start"],
                "amount": gap_alert["gap"]["expected_amount"],
                "description": "Resolved from alerts tab",
            },
        },
    )
    assert resolve.status_code == 200

    deposits = db.scalars(
        select(Deposit).where(Deposit.description == "Resolved from alerts tab")
    ).all()
    assert len(deposits) == 1

    after = client.get("/api/v1/alerts").json()
    assert all(item["id"] != gap_alert["id"] for item in after["items"])
    assert db.scalars(select(AlertAction)).all().__len__() >= 1


def test_alert_summary_returns_open_count(client):
    response = client.get("/api/v1/alerts/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["open_count"] >= 1


def test_create_manual_deposit_endpoint(client):
    property_detail = client.get(f"/api/v1/properties/{PROPERTY_ROTHSCHILD_ID}").json()
    response = client.post(
        "/api/v1/deposits",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "bank_account_id": property_detail["bank_accounts"][0]["id"],
            "transaction_date": "2026-07-01",
            "amount": "8500.00",
            "description": "Manual deposit test",
        },
    )
    assert response.status_code == 201
    assert response.json()["source"] == "manual_entry"
