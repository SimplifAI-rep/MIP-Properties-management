"""Awaiting return property: park money-left rows without locking Finish."""

from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.bank_reconcile_session import BankReconcileSession
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property
from app.services.holding import (
    AWAITING_RETURN_PROP_ID,
    BUFFER_PROP_ID,
    ensure_company_holdings,
    session_unassigned_count,
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
        filename="awaiting-return.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        lines_json=lines,
        unmatched_app_json=[],
    )
    db.add(session)
    db.commit()
    return session


def test_ensure_company_holdings_seeds_awaiting_return(db):
    buffer, awaiting = ensure_company_holdings(db)
    db.commit()
    assert buffer.client_prop_id == BUFFER_PROP_ID
    assert awaiting.client_prop_id == AWAITING_RETURN_PROP_ID
    assert awaiting.status == "active"
    assert awaiting.name == "Awaiting return"
    again_buffer, again_awaiting = ensure_company_holdings(db)
    assert again_buffer.id == buffer.id
    assert again_awaiting.id == awaiting.id
    ids = {row.client_prop_id for row in db.scalars(select(Property))}
    assert BUFFER_PROP_ID in ids
    assert AWAITING_RETURN_PROP_ID in ids


def test_add_from_bank_onto_awaiting_does_not_lock_finish(client, db):
    _buffer, awaiting = ensure_company_holdings(db)
    db.commit()
    session = _open_session(db, [("debit-1", "debit", "40.00")])
    response = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "add_from_bank",
                    "fingerprint": "debit-1",
                    "property_id": str(awaiting.id),
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["counts"]["unassigned"] == 0
    line = next(row for row in body["lines"] if row["fingerprint"] == "debit-1")
    assert line["status"] == "added"
    expense = db.get(Expense, UUID(line["proposed_tx_id"]))
    assert expense is not None
    assert expense.property_id == awaiting.id
    assert session_unassigned_count(db, body["lines"]) == 0


def test_write_off_awaiting_moves_to_buffer(client, db):
    buffer, awaiting = ensure_company_holdings(db)
    expense = Expense(
        property_id=awaiting.id,
        transaction_date=date(2026, 7, 20),
        amount=Decimal("80.00"),
        category="maintenance",
        source="manual_company",
        payment_method="bank_transfer",
        description="Service not delivered",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)

    rejected = client.post(
        f"/api/v1/expenses/{expense.id}/write-off-to-buffer",
    )
    # still awaiting — should succeed
    assert rejected.status_code == 200, rejected.text
    body = rejected.json()
    assert body["client_prop_id"] == BUFFER_PROP_ID
    db.refresh(expense)
    assert expense.property_id == buffer.id

    again = client.post(f"/api/v1/expenses/{expense.id}/write-off-to-buffer")
    assert again.status_code == 400
    assert "awaiting return" in again.json()["detail"].lower()


def test_write_off_rejects_non_awaiting(client, db):
    ensure_company_holdings(db)
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 20),
        amount=Decimal("15.00"),
        category="maintenance",
        source="manual_company",
        payment_method="bank_transfer",
        description="Normal expense",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    response = client.post(f"/api/v1/expenses/{expense.id}/write-off-to-buffer")
    assert response.status_code == 400


def test_record_return_creates_buffer_payback(client, db):
    buffer, awaiting = ensure_company_holdings(db)
    expense = Expense(
        property_id=awaiting.id,
        transaction_date=date(2026, 7, 20),
        amount=Decimal("125.50"),
        category="maintenance",
        source="manual_company",
        payment_method="bank_transfer",
        vendor_name="Plumber",
        description="Service not delivered",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)

    response = client.post(f"/api/v1/expenses/{expense.id}/record-return")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["expense"]["client_prop_id"] == BUFFER_PROP_ID
    deposit_body = body["return_deposit"]
    assert deposit_body["client_prop_id"] == BUFFER_PROP_ID
    assert deposit_body["is_payback"] is True
    assert deposit_body["payback_of_expense_id"] == str(expense.id)
    assert Decimal(deposit_body["amount"]) == Decimal("125.50")
    db.refresh(expense)
    assert expense.property_id == buffer.id
    deposit = db.get(Deposit, UUID(deposit_body["id"]))
    assert deposit is not None
    assert deposit.is_payback is True
    assert deposit.payback_of_expense_id == expense.id
