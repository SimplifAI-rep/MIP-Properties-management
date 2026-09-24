from datetime import date
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.bank_reconcile_session import BankReconcileSession
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data
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
    yield session
    session.close()


@pytest.fixture
def client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_admin] = lambda: "test-admin"
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _open_session(db, fingerprints: list[tuple[str, str, str]]) -> BankReconcileSession:
    lines = []
    for index, (fingerprint, side, amount) in enumerate(fingerprints, start=1):
        lines.append(
            {
                "fingerprint": fingerprint,
                "row_number": index,
                "transaction_date": "2026-07-20",
                "side": side,
                "amount": amount,
                "asmachta": f"A{index}",
                "description": f"{side} {amount}",
                "status": "unmatched",
            }
        )
    session = BankReconcileSession(
        id=uuid4(),
        status="in_progress",
        filename="unassigned-alert.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        lines_json=lines,
        unmatched_app_json=[],
    )
    db.add(session)
    db.commit()
    return session


def _add_from_bank(client, session_id, fingerprint: str):
    response = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session_id}/actions",
        json={"actions": [{"action": "add_from_bank", "fingerprint": fingerprint}]},
    )
    assert response.status_code == 200, response.text
    line = next(row for row in response.json()["lines"] if row["fingerprint"] == fingerprint)
    return line["proposed_tx_id"], line["proposed_kind"]


def test_add_from_bank_raises_one_unassigned_alert(client, db):
    session = _open_session(db, [("debit-1", "debit", "40.00")])
    tx_id, kind = _add_from_bank(client, session.id, "debit-1")
    assert kind == "expense"

    alerts = client.get("/api/v1/alerts?property_status=all").json()["items"]
    unassigned = [item for item in alerts if item["alert_type"] == "unassigned_transaction"]
    assert len(unassigned) == 1
    alert = unassigned[0]
    assert alert["expense_id"] == tx_id
    assert alert["id"] == f"unassigned_transaction:expense:{tx_id}"
    assert alert["link_path"] == f"/verification?session={session.id}"
    assert not any(
        item["alert_type"] == "incomplete_import" and item.get("expense_id") == tx_id
        for item in alerts
    )


def test_assigning_property_clears_unassigned_alert(client, db):
    session = _open_session(db, [("credit-1", "credit", "5.00")])
    tx_id, kind = _add_from_bank(client, session.id, "credit-1")
    assert kind == "deposit"

    before = client.get("/api/v1/alerts?property_status=all").json()["items"]
    assert any(
        item["alert_type"] == "unassigned_transaction" and item.get("deposit_id") == tx_id
        for item in before
    )

    patched = client.patch(
        f"/api/v1/deposits/{tx_id}",
        json={"property_id": str(PROPERTY_ROTHSCHILD_ID)},
    )
    assert patched.status_code == 200, patched.text

    after = client.get("/api/v1/alerts?property_status=all").json()["items"]
    assert not any(
        item["alert_type"] == "unassigned_transaction" and item.get("deposit_id") == tx_id
        for item in after
    )


def test_dismissed_unassigned_alert_can_fire_again_after_reassign(client, db):
    session = _open_session(db, [("debit-2", "debit", "12.00")])
    tx_id, _ = _add_from_bank(client, session.id, "debit-2")
    alert_id = f"unassigned_transaction:expense:{tx_id}"
    dismissed = client.post(f"/api/v1/alerts/{alert_id}/dismiss", json={})
    assert dismissed.status_code == 200, dismissed.text

    hidden = client.get("/api/v1/alerts?property_status=all").json()["items"]
    assert not any(item["id"] == alert_id for item in hidden)

    assigned = client.patch(
        f"/api/v1/expenses/{tx_id}",
        json={"property_id": str(PROPERTY_ROTHSCHILD_ID)},
    )
    assert assigned.status_code == 200, assigned.text
    # Listing after assign drops the dismiss record so a later UNASSIGNED move can alert again.
    client.get("/api/v1/alerts?property_status=all")

    from app.models.property import Property
    from app.services.holding import UNASSIGNED_PROP_ID

    holding = db.query(Property).filter(Property.client_prop_id == UNASSIGNED_PROP_ID).one()
    moved_back = client.patch(
        f"/api/v1/expenses/{tx_id}",
        json={"property_id": str(holding.id)},
    )
    assert moved_back.status_code == 200, moved_back.text

    again = client.get("/api/v1/alerts?property_status=all").json()["items"]
    assert any(item["id"] == alert_id for item in again)


def test_one_alert_per_unassigned_transaction(client, db):
    session = _open_session(
        db,
        [("debit-a", "debit", "10.00"), ("credit-b", "credit", "7.00")],
    )
    first_id, _ = _add_from_bank(client, session.id, "debit-a")
    second_id, _ = _add_from_bank(client, session.id, "credit-b")
    alerts = [
        item
        for item in client.get("/api/v1/alerts?property_status=all").json()["items"]
        if item["alert_type"] == "unassigned_transaction"
    ]
    ids = {item.get("expense_id") or item.get("deposit_id") for item in alerts}
    assert ids == {first_id, second_id}
    assert UUID(first_id)
    assert UUID(second_id)
