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
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.services.client_import import PAST_CLIENTS_OWNER_NAME
from app.services.seed import (
    OWNER_DAVID_ID,
    OWNER_SARAH_ID,
    PROPERTY_ROTHSCHILD_ID,
    seed_reference_data,
    seed_sample_expenses,
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


def test_list_owners_with_summaries(client):
    response = client.get("/api/v1/owners")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    names = {row["name"] for row in body}
    assert names == {"David Cohen", "Sarah Levi"}
    assert "Needs assignment" not in names
    david = next(row for row in body if row["id"] == str(OWNER_DAVID_ID))
    assert david["property_count"] == 2
    assert david["client_prop_ids"] == ["TEST-D45", "TEST-R12"]
    assert david["expense_count"] >= 2
    assert "balance" in david


def test_get_owner_detail(client):
    response = client.get(f"/api/v1/owners/{OWNER_DAVID_ID}")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "David Cohen"
    assert len(body["properties"]) == 2
    assert body["client_prop_ids"] == ["TEST-D45", "TEST-R12"]
    assert body["contact_email"] == "david.cohen@example.com"
    assert "balance" in body
    assert all("balance" in prop for prop in body["properties"])
    assert float(body["balance"]) == pytest.approx(
        sum(float(prop["balance"]) for prop in body["properties"]),
        abs=0.01,
    )
    assert "recent_deposits" in body
    assert "recent_expenses" in body
    assert len(body["recent_deposits"]) <= 5
    assert len(body["recent_expenses"]) <= 5


def test_create_owner_and_property(client):
    owner_response = client.post(
        "/api/v1/owners",
        json={"name": "New Client", "contact_email": "new@example.com"},
    )
    assert owner_response.status_code == 201, owner_response.text
    owner = owner_response.json()
    assert owner["name"] == "New Client"
    assert owner["property_count"] == 0
    assert owner["client_prop_ids"] == []

    duplicate = client.post("/api/v1/owners", json={"name": "new client"})
    assert duplicate.status_code == 409

    missing_owner = client.post(
        "/api/v1/properties",
        json={
            "owner_id": "00000000-0000-0000-0000-000000000000",
            "client_prop_id": "X1",
            "name": "Nowhere",
        },
    )
    assert missing_owner.status_code == 404

    created = client.post(
        "/api/v1/properties",
        json={
            "owner_id": owner["id"],
            "client_prop_id": "x1",
            "name": "New house",
            "city": "Tel Aviv",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["client_prop_id"] == "X1"
    assert body["owner_id"] == owner["id"]
    assert body["name"] == "New house"
    assert body["status"] == "active"

    clash = client.post(
        "/api/v1/properties",
        json={
            "owner_id": owner["id"],
            "client_prop_id": "X1",
            "name": "Duplicate",
        },
    )
    assert clash.status_code == 409

    listed = client.get("/api/v1/owners").json()
    created_owner = next(row for row in listed if row["id"] == owner["id"])
    assert created_owner["property_count"] == 1


def test_update_owner_and_property(client):
    owner_patch = client.patch(
        f"/api/v1/owners/{OWNER_DAVID_ID}",
        json={"name": "David Cohen Updated", "contact_phone": "050-000"},
    )
    assert owner_patch.status_code == 200, owner_patch.text
    body = owner_patch.json()
    assert body["name"] == "David Cohen Updated"
    assert body["contact_phone"] == "050-000"
    assert body["contact_email"] == "david.cohen@example.com"
    assert body["property_count"] == 2

    clash = client.patch(
        f"/api/v1/owners/{OWNER_DAVID_ID}",
        json={"name": "Sarah Levi"},
    )
    assert clash.status_code == 409

    missing = client.patch(
        "/api/v1/owners/00000000-0000-0000-0000-000000000000",
        json={"name": "Nobody"},
    )
    assert missing.status_code == 404

    prop_patch = client.patch(
        f"/api/v1/properties/{PROPERTY_ROTHSCHILD_ID}",
        json={
            "name": "Rothschild 12B",
            "city": "Jaffa",
            "client_prop_id": "r12b",
            "owner_id": str(OWNER_SARAH_ID),
        },
    )
    assert prop_patch.status_code == 200, prop_patch.text
    updated = prop_patch.json()
    assert updated["name"] == "Rothschild 12B"
    assert updated["city"] == "Jaffa"
    assert updated["client_prop_id"] == "R12B"
    assert updated["owner_id"] == str(OWNER_SARAH_ID)
    assert updated["status"] == "active"

    status_only = client.patch(
        f"/api/v1/properties/{PROPERTY_ROTHSCHILD_ID}",
        json={"status": "inactive"},
    )
    assert status_only.status_code == 200
    assert status_only.json()["status"] == "inactive"
    assert status_only.json()["name"] == "Rothschild 12B"

    duplicate_id = client.patch(
        f"/api/v1/properties/{PROPERTY_ROTHSCHILD_ID}",
        json={"client_prop_id": "TEST-H8"},
    )
    assert duplicate_id.status_code == 409


def test_past_clients_owner_is_listed_as_active(client, db):
    owner = Owner(name=PAST_CLIENTS_OWNER_NAME)
    db.add(owner)
    db.flush()
    db.add(
        Property(
            owner_id=owner.id,
            client_prop_id="H111",
            name="H111 past",
            status="inactive",
        )
    )
    db.commit()

    body = client.get("/api/v1/owners").json()
    past = next(row for row in body if row["name"] == PAST_CLIENTS_OWNER_NAME)
    assert past["status"] == "active"
    assert past["property_count"] == 1


def test_owner_and_property_totals_match_company_float(client, db):
    owner = Owner(name="Float Totals Client")
    db.add(owner)
    db.flush()
    prop = Property(
        owner_id=owner.id,
        client_prop_id="FT-1",
        name="Float house",
        status="active",
    )
    db.add(prop)
    db.flush()
    db.add_all(
        [
            Deposit(
                property_id=prop.id,
                transaction_date=date(2026, 1, 1),
                amount=Decimal("1000.00"),
                currency="ILS",
                source="management_ledger",
                is_rental_income=False,
            ),
            Deposit(
                property_id=prop.id,
                transaction_date=date(2026, 1, 2),
                amount=Decimal("3000.00"),
                currency="ILS",
                source="rental_income",
                is_rental_income=True,
            ),
            Expense(
                property_id=prop.id,
                transaction_date=date(2026, 1, 3),
                amount=Decimal("200.00"),
                currency="ILS",
                category="maintenance",
                source="management_ledger",
                payment_method="company_account",
                paid_by_resident=False,
                paid_by_owner=False,
            ),
            Expense(
                property_id=prop.id,
                transaction_date=date(2026, 1, 4),
                amount=Decimal("50.00"),
                currency="ILS",
                category="utilities",
                source="manual_owner",
                payment_method="owner_personal",
                paid_by_resident=True,
            ),
            Expense(
                property_id=prop.id,
                transaction_date=date(2026, 1, 5),
                amount=Decimal("75.00"),
                currency="ILS",
                category="tax",
                source="manual_owner",
                payment_method="owner_personal",
                paid_by_owner=True,
            ),
        ]
    )
    db.commit()

    listed = next(
        row for row in client.get("/api/v1/owners").json() if row["name"] == owner.name
    )
    assert listed["deposit_count"] == 1
    assert float(listed["total_deposits"]) == pytest.approx(1000.00)
    assert listed["expense_count"] == 1
    assert float(listed["total_expenses"]) == pytest.approx(200.00)
    assert float(listed["balance"]) == pytest.approx(800.00)

    detail = client.get(f"/api/v1/owners/{owner.id}").json()
    assert float(detail["total_deposits"]) == pytest.approx(1000.00)
    assert float(detail["total_expenses"]) == pytest.approx(200.00)
    assert float(detail["balance"]) == pytest.approx(800.00)
    assert float(detail["properties"][0]["total_deposits"]) == pytest.approx(1000.00)
    assert float(detail["properties"][0]["total_expenses"]) == pytest.approx(200.00)

    property_row = next(
        row
        for row in client.get("/api/v1/properties").json()
        if row["client_prop_id"] == "FT-1"
    )
    assert float(property_row["total_incoming"]) == pytest.approx(1000.00)
    assert float(property_row["total_outgoing"]) == pytest.approx(200.00)
    assert float(property_row["net_balance"]) == pytest.approx(800.00)
    assert float(property_row["total_deposits"]) == pytest.approx(1000.00)
