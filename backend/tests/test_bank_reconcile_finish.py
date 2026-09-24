"""Phase F: finish only when lists are handled and |gap| ≤ 0.01."""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

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
from app.models.expense import Expense
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


def _matched_expense(db, *, amount="50.00"):
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal(amount),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="Matched bank debit",
        bank_verified_at=datetime.now(timezone.utc),
        bank_asmachta="F50",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense


def _session(db, *, expense, closing: str) -> BankReconcileSession:
    session = BankReconcileSession(
        id=uuid4(),
        status="in_progress",
        filename="finish-gap.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        opening_balance=Decimal("100.00"),
        bank_balance=Decimal(closing),
        gap_tolerance_amount=Decimal("0.01"),
        lines_json=[
            {
                "fingerprint": "debit-50",
                "row_number": 1,
                "transaction_date": "2026-07-10",
                "side": "debit",
                "amount": "50.00",
                "asmachta": "F50",
                "description": "Matched bank debit",
                "status": "matched",
                "proposed_kind": "expense",
                "proposed_tx_id": str(expense.id),
            }
        ],
        unmatched_app_json=[],
    )
    db.add(session)
    db.commit()
    return session


def test_finish_blocked_when_gap_is_off(client, db):
    expense = _matched_expense(db)
    # closing 80 vs opening 100 + app net -50 → gap 30
    session = _session(db, expense=expense, closing="80.00")

    body = client.get(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}"
    ).json()
    assert body["counts"]["unresolved_bank"] == 0
    assert body["counts"]["unresolved_app"] == 0
    assert body["counts"]["unassigned"] == 0
    assert Decimal(body["gap_verified"]) == Decimal("30.00")
    assert body["can_complete"] is False

    completed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/complete"
    )
    assert completed.status_code == 400
    detail = completed.json()["detail"].lower()
    assert "off by" in detail
    assert "create a transaction" in detail
    db.refresh(session)
    assert session.status == "in_progress"


def test_finish_allowed_when_gap_is_zero(client, db):
    expense = _matched_expense(db)
    # closing 50 = opening 100 + app net -50
    session = _session(db, expense=expense, closing="50.00")

    body = client.get(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}"
    ).json()
    assert Decimal(body["gap_verified"]) == Decimal("0.00")
    assert body["can_complete"] is True

    completed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/complete"
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    db.refresh(session)
    assert session.status == "completed"


def test_finish_allowed_within_one_agora(client, db):
    expense = _matched_expense(db)
    session = _session(db, expense=expense, closing="50.01")

    body = client.get(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}"
    ).json()
    assert Decimal(body["gap_verified"]) == Decimal("0.01")
    assert body["can_complete"] is True
