from decimal import Decimal
from datetime import date
from uuid import UUID, uuid4
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.bank_reconcile_session import BankReconcileSession
from app.models.expense import Expense
from app.models.property import Property
from app.services.holding import (
    CREATED_FROM_VERIFICATION_REASON,
    UNASSIGNED_PROP_ID,
    ensure_unassigned_holding,
)
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
        filename="create-from-verification.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        lines_json=lines,
        unmatched_app_json=[],
    )
    db.add(session)
    db.commit()
    return session


def test_add_from_bank_requires_property(client, db):
    session = _open_session(db, [("debit-1", "debit", "40.00")])
    response = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={"actions": [{"action": "add_from_bank", "fingerprint": "debit-1"}]},
    )
    assert response.status_code == 400
    assert "property" in response.json()["detail"].lower()


def test_add_from_bank_tags_created_from_verification(client, db):
    session = _open_session(db, [("debit-1", "debit", "40.00")])
    response = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "add_from_bank",
                    "fingerprint": "debit-1",
                    "property_id": str(PROPERTY_ROTHSCHILD_ID),
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    line = next(row for row in response.json()["lines"] if row["fingerprint"] == "debit-1")
    assert line["status"] == "added"
    expense = db.get(Expense, UUID(line["proposed_tx_id"]))
    assert expense is not None
    assert expense.property_id == PROPERTY_ROTHSCHILD_ID
    assert expense.needs_review is False
    assert CREATED_FROM_VERIFICATION_REASON in (expense.review_reasons or "")
    listed = client.get(
        "/api/v1/expenses",
        params={"review_reason": CREATED_FROM_VERIFICATION_REASON, "page_size": 50},
    )
    assert listed.status_code == 200
    ids = {item["id"] for item in listed.json()["items"]}
    assert str(expense.id) in ids
    alerts = client.get("/api/v1/alerts?property_status=all").json()["items"]
    assert not any(
        item["alert_type"] == "unassigned_transaction" and item.get("expense_id") == str(expense.id)
        for item in alerts
    )


def test_open_session_rematch_picks_up_manual_create(client, db):
    session = _open_session(db, [("debit-1", "debit", "40.00")])
    first = client.get(f"/api/v1/bank-settings/reconcile/sessions/{session.id}")
    assert first.status_code == 200
    line = next(row for row in first.json()["lines"] if row["fingerprint"] == "debit-1")
    assert line["status"] == "unmatched"

    created = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-20",
            "amount": "40.00",
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
            "description": "manual match",
        },
    )
    assert created.status_code in (200, 201), created.text
    tx_id = created.json()["id"]

    again = client.get(f"/api/v1/bank-settings/reconcile/sessions/{session.id}")
    assert again.status_code == 200, again.text
    line = next(row for row in again.json()["lines"] if row["fingerprint"] == "debit-1")
    assert line["status"] == "proposed_match"
    assert line["proposed_tx_id"] == tx_id
    app_ids = {row["id"] for row in again.json().get("unmatched_app") or []}
    assert tx_id not in app_ids


def test_leftover_unassigned_property_still_alerts(client, db):
    holding = ensure_unassigned_holding(db)
    db.commit()
    expense = Expense(
        property_id=holding.id,
        transaction_date=date(2026, 7, 20),
        amount=Decimal("12.00"),
        category="maintenance",
        source="bank_statement",
        payment_method="bank_transfer",
        needs_review=True,
        review_reasons="unassigned_bank",
    )
    db.add(expense)
    db.commit()
    alerts = [
        item
        for item in client.get("/api/v1/alerts?property_status=all").json()["items"]
        if item["alert_type"] == "unassigned_transaction"
    ]
    assert len(alerts) == 1
    assert alerts[0]["expense_id"] == str(expense.id)
    assert alerts[0]["link_path"] == "/transactions"
    assert db.query(Property).filter(Property.client_prop_id == UNASSIGNED_PROP_ID).one()
