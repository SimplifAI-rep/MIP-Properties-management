import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.services.seed import (
    OWNER_DAVID_ID,
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
    assert david["expense_count"] >= 2
    assert "balance" in david


def test_get_owner_detail(client):
    response = client.get(f"/api/v1/owners/{OWNER_DAVID_ID}")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "David Cohen"
    assert len(body["properties"]) == 2
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
