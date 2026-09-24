from decimal import Decimal
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.deposit import Deposit
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


def _create_expense(client, amount="200.00"):
    response = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-10",
            "amount": amount,
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
            "description": "Original charge",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_create_and_edit_payback_deposit(client, db):
    expense = _create_expense(client)
    created = client.post(
        "/api/v1/deposits",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-20",
            "amount": "5.00",
            "description": "Bank returned 5",
            "is_payback": True,
            "payback_of_expense_id": expense["id"],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["is_payback"] is True
    assert body["payback_of_expense_id"] == expense["id"]
    assert body["is_rental_income"] is False

    deposit = db.get(Deposit, UUID(body["id"]))
    assert deposit is not None
    assert deposit.is_payback is True
    assert str(deposit.payback_of_expense_id) == expense["id"]

    patched = client.patch(
        f"/api/v1/deposits/{body['id']}",
        json={"is_payback": False},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["is_payback"] is False
    assert patched.json()["payback_of_expense_id"] is None


def test_payback_rejects_missing_expense(client):
    response = client.post(
        "/api/v1/deposits",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-20",
            "amount": "5.00",
            "is_payback": True,
            "payback_of_expense_id": "00000000-0000-0000-0000-000000000001",
        },
    )
    assert response.status_code == 400
    assert "Original expense" in response.json()["detail"]


def test_payback_cannot_also_be_rental(client):
    response = client.post(
        "/api/v1/deposits",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-20",
            "amount": "5.00",
            "is_payback": True,
            "is_rental_income": True,
        },
    )
    assert response.status_code == 400


def test_add_from_bank_payback_on_credit_and_rejects_debit(client, db):
    from datetime import date
    from uuid import uuid4

    from app.models.bank_reconcile_session import BankReconcileSession
    from app.services import bank_reconcile as bank_reconcile_service

    expense = _create_expense(client, amount="80.00")
    credit_fp = "credit-payback-1"
    debit_fp = "debit-not-payback-1"
    session = BankReconcileSession(
        id=uuid4(),
        status="in_progress",
        filename="payback-test.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        lines_json=[
            {
                "fingerprint": credit_fp,
                "row_number": 1,
                "transaction_date": "2026-07-20",
                "side": "credit",
                "amount": "5.00",
                "asmachta": "PB1",
                "description": "Refund 5",
                "status": "unmatched",
            },
            {
                "fingerprint": debit_fp,
                "row_number": 2,
                "transaction_date": "2026-07-21",
                "side": "debit",
                "amount": "12.00",
                "asmachta": "DB1",
                "description": "Charge",
                "status": "unmatched",
            },
        ],
        unmatched_app_json=[],
    )
    db.add(session)
    db.commit()

    debit_fail = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "add_from_bank",
                    "fingerprint": debit_fp,
                    "is_payback": True,
                }
            ]
        },
    )
    assert debit_fail.status_code == 400
    assert "credit" in debit_fail.json()["detail"].lower()

    added = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "add_from_bank",
                    "fingerprint": credit_fp,
                    "is_payback": True,
                    "payback_of_expense_id": expense["id"],
                }
            ]
        },
    )
    assert added.status_code == 200, added.text
    line = next(row for row in added.json()["lines"] if row["fingerprint"] == credit_fp)
    assert line["status"] == "added"
    assert line["proposed_kind"] == "deposit"
    db.expire_all()
    deposit = db.get(Deposit, UUID(line["proposed_tx_id"]))
    assert deposit is not None
    assert deposit.is_payback is True
    assert str(deposit.payback_of_expense_id) == expense["id"]
    assert deposit.amount == Decimal("5.00")

    summary = bank_reconcile_service.session_summary(db, db.get(BankReconcileSession, session.id))
    able = summary.get("able_txs") or []
    payback_row = next(row for row in able if row["id"] == str(deposit.id))
    assert payback_row["is_payback"] is True
