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
    david = next(row for row in body if row["id"] == str(OWNER_DAVID_ID))
    assert david["property_count"] == 2
    assert david["expense_count"] >= 2


def test_get_owner_detail(client):
    response = client.get(f"/api/v1/owners/{OWNER_DAVID_ID}")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "David Cohen"
    assert len(body["properties"]) == 2
    assert body["contact_email"] == "david.cohen@example.com"
