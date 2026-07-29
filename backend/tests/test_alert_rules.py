from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import create_admin_token
from app.core.config import get_settings
from app.core.database import Base
from app.main import app
from app.models.alert_action import AlertAction
from app.models.alert_rule import AlertRule
from app.models.deposit import Deposit
from app.models.expense import Expense
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
    yield session
    session.close()


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-secret")
    get_settings.cache_clear()

    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def _auth_headers() -> dict[str, str]:
    token, _ = create_admin_token()
    return {"Authorization": f"Bearer {token}"}


def test_alert_rules_require_admin(client):
    denied = client.get("/api/v1/alert-rules")
    assert denied.status_code == 401


def test_create_global_and_property_override(client, db):
    headers = _auth_headers()
    global_resp = client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "rule_type": "low_balance",
            "name": "Global low balance",
            "scope_type": "global",
            "threshold_amount": "1000.00",
            "severity": "warning",
            "enabled": True,
        },
    )
    assert global_resp.status_code == 201, global_resp.text
    body = global_resp.json()
    assert body["scope_type"] == "global"
    assert body["threshold_amount"] == "1000.00"

    dup = client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "name": "Another global",
            "scope_type": "global",
            "threshold_amount": "500",
        },
    )
    assert dup.status_code == 409

    override = client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "name": "Rothschild override",
            "scope_type": "property",
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "threshold_amount": "50.00",
            "severity": "error",
        },
    )
    assert override.status_code == 201, override.text
    assert override.json()["client_prop_id"] is not None

    listed = client.get("/api/v1/alert-rules", headers=headers)
    assert listed.status_code == 200
    assert len(listed.json()) == 2

    rule_id = override.json()["id"]
    patched = client.patch(
        f"/api/v1/alert-rules/{rule_id}",
        headers=headers,
        json={"threshold_amount": "75.00", "enabled": False},
    )
    assert patched.status_code == 200
    assert patched.json()["threshold_amount"] == "75.00"
    assert patched.json()["enabled"] is False

    deleted = client.delete(f"/api/v1/alert-rules/{rule_id}", headers=headers)
    assert deleted.status_code == 204
    assert len(client.get("/api/v1/alert-rules", headers=headers).json()) == 1


def test_low_balance_alert_global_and_override(client, db):
    headers = _auth_headers()
    # Rothschild has sample expenses from seed_sample_expenses if we add them;
    # with only reference data, balance may be 0.
    seed_sample_expenses(db)

    client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "name": "Global",
            "scope_type": "global",
            "threshold_amount": "1000000",
            "enabled": True,
        },
    )

    alerts = client.get("/api/v1/alerts").json()["items"]
    low = [a for a in alerts if a["alert_type"] == "low_balance"]
    assert any(a["property_id"] == str(PROPERTY_ROTHSCHILD_ID) for a in low)

    override = client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "name": "Rothschild low bar",
            "scope_type": "property",
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "threshold_amount": "-999999",
            "enabled": True,
        },
    )
    assert override.status_code == 201, override.text
    alerts2 = client.get("/api/v1/alerts").json()["items"]
    low2 = [
        a
        for a in alerts2
        if a["alert_type"] == "low_balance"
        and a["property_id"] == str(PROPERTY_ROTHSCHILD_ID)
    ]
    assert low2 == []


def test_low_balance_dismiss_until_recovery(client, db):
    headers = _auth_headers()
    # Force a known under-threshold balance: no deposits, one expense
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=__import__("datetime").date(2026, 1, 1),
            amount=Decimal("200.00"),
            currency="ILS",
            category="maintenance",
            description="test",
            source="manual_company",
            payment_method="company_account",
            paid_by_resident=False,
            paid_by_owner=False,
        )
    )
    db.commit()

    client.post(
        "/api/v1/alert-rules",
        headers=headers,
        json={
            "name": "Global",
            "scope_type": "global",
            "threshold_amount": "0",
            "enabled": True,
        },
    )

    alerts = client.get("/api/v1/alerts").json()["items"]
    match = next(
        a
        for a in alerts
        if a["alert_type"] == "low_balance"
        and a["property_id"] == str(PROPERTY_ROTHSCHILD_ID)
    )
    assert Decimal(match["amount"]) < 0

    dismiss = client.post(f"/api/v1/alerts/{match['id']}/dismiss")
    assert dismiss.status_code == 200
    assert not any(
        a["id"] == match["id"] for a in client.get("/api/v1/alerts").json()["items"]
    )

    # Recover balance with a large deposit → dismiss key cleared
    db.add(
        Deposit(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=__import__("datetime").date(2026, 1, 2),
            amount=Decimal("5000.00"),
            currency="ILS",
            source="manual",
            is_rental_income=False,
        )
    )
    db.commit()

    # Raise threshold so property is under again after recovery cleared dismiss
    rules = client.get("/api/v1/alert-rules", headers=headers).json()
    global_id = next(r["id"] for r in rules if r["scope_type"] == "global")
    # First list clears dismiss because balance is above old threshold of 0
    client.get("/api/v1/alerts")
    assert (
        db.scalar(select(AlertAction).where(AlertAction.alert_key == match["id"]))
        is None
    )

    client.patch(
        f"/api/v1/alert-rules/{global_id}",
        headers=headers,
        json={"threshold_amount": "100000"},
    )
    again = [
        a
        for a in client.get("/api/v1/alerts").json()["items"]
        if a["alert_type"] == "low_balance"
        and a["property_id"] == str(PROPERTY_ROTHSCHILD_ID)
    ]
    assert len(again) == 1
