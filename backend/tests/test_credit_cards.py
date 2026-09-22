from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.services.account_scope import ensure_cc_account
from app.services.seed import seed_reference_data
from app.services.transaction_ref import register_transaction_ref_listeners


def _client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


def test_create_and_deactivate_credit_card():
    register_transaction_ref_listeners()
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    seed_reference_data(db)
    client = _client(db)
    try:
        created = client.post(
            "/api/v1/credit-cards",
            json={"card_last4": "1234", "label": "Office Visa"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["card_last4"] == "1234"
        assert body["label"] == "Office Visa"
        assert body["is_active"] is True

        listed = client.get("/api/v1/credit-cards")
        assert listed.status_code == 200
        assert any(row["card_last4"] == "1234" for row in listed.json())

        patched = client.patch(
            f"/api/v1/credit-cards/{body['id']}",
            json={"is_active": False},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["is_active"] is False

        workspace = client.get("/api/v1/bank-settings/verification-workspace")
        assert workspace.status_code == 200
        cards = workspace.json()["credit_cards"]
        inactive = next(row for row in cards if row["card_last4"] == "1234")
        assert inactive["is_active"] is False

        duplicate = client.post("/api/v1/credit-cards", json={"card_last4": "xx1234"})
        assert duplicate.status_code == 400

        # Uploading / ensuring the same last4 turns the card back on.
        ensure_cc_account(db, "1234")
        db.commit()
        again = client.get("/api/v1/credit-cards")
        restored = next(row for row in again.json() if row["card_last4"] == "1234")
        assert restored["is_active"] is True
    finally:
        app.dependency_overrides.clear()
        db.close()
