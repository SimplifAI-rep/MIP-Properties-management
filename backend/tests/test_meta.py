from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.services.seed import seed_reference_data, seed_sample_expenses


def test_transaction_years_from_data():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    seed_sample_expenses(session)

    def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as client:
        response = client.get("/api/v1/meta/transaction-years")
    app.dependency_overrides.clear()
    session.close()

    assert response.status_code == 200
    body = response.json()
    assert "years" in body
    assert isinstance(body["years"], list)
    assert len(body["years"]) >= 1
    assert body["years"] == sorted(body["years"], reverse=True)
