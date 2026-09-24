"""Phase E: bank candidate filters, near-miss hints, and merge."""

from datetime import date
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
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services import bank_reconcile as bank_reconcile_service
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


def _open_session(db, *, lines, unmatched_app=None) -> BankReconcileSession:
    session = BankReconcileSession(
        id=uuid4(),
        status="in_progress",
        filename="merge-test.xlsx",
        statement_start_date=date(2026, 7, 1),
        statement_end_date=date(2026, 7, 31),
        lines_json=lines,
        unmatched_app_json=unmatched_app or [],
    )
    db.add(session)
    db.commit()
    return session


def _debit_line(fingerprint="debit-merge", amount="195.00", tx_date="2026-07-12"):
    return {
        "fingerprint": fingerprint,
        "row_number": 1,
        "transaction_date": tx_date,
        "side": "debit",
        "amount": amount,
        "asmachta": "M195",
        "description": "Supplier debit",
        "status": "unmatched",
    }


def test_he_she_rental_and_owner_personal_stay_out_of_bank_lists(db):
    he_she = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("50.00"),
        category="maintenance",
        source="manual",
        payment_method="cash",
        paid_by_resident=True,
        description="He/She paid grocery",
    )
    owner_personal = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 11),
        amount=Decimal("30.00"),
        category="maintenance",
        source="manual_owner",
        payment_method="owner_personal",
        paid_by_owner=False,
        description="Owner personal unflagged",
    )
    card = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 12),
        amount=Decimal("20.00"),
        category="maintenance",
        source="credit_card",
        payment_method="credit_card",
        description="Card merchant",
    )
    company = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 13),
        amount=Decimal("40.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="Company float expense",
    )
    rental = Deposit(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("100.00"),
        currency="ILS",
        source="rental_income",
        is_rental_income=True,
        description="July rent",
    )
    company_dep = Deposit(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 14),
        amount=Decimal("60.00"),
        currency="ILS",
        source="manual",
        is_rental_income=False,
        description="Owner transfer in",
    )
    db.add_all([he_she, owner_personal, card, company, rental, company_dep])
    db.commit()

    rows = bank_reconcile_service._unmatched_app_rows(
        db,
        date_from=date(2026, 7, 1),
        date_to=date(2026, 7, 31),
        matched_ids=set(),
    )
    ids = {row["id"] for row in rows}
    assert str(he_she.id) not in ids
    assert str(owner_personal.id) not in ids
    assert str(card.id) not in ids
    assert str(rental.id) not in ids
    assert str(company.id) in ids
    assert str(company_dep.id) in ids


def test_near_miss_hint_on_unmatched_app(client, db):
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 14),
        amount=Decimal("197.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="Supplier debit",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    session = _open_session(
        db,
        lines=[_debit_line()],
        unmatched_app=[
            {
                "kind": "expense",
                "id": str(expense.id),
                "transaction_date": "2026-07-14",
                "amount": "197.00",
                "description": "Supplier debit",
                "status": "unmatched",
            }
        ],
    )
    body = client.get(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}"
    ).json()
    app_row = next(row for row in body["unmatched_app"] if row["id"] == str(expense.id))
    assert app_row["near_misses"]
    reasons = " ".join(app_row["near_misses"][0]["reasons"])
    assert "amount 197.00 vs bank 195.00" in reasons
    assert "date 2026-07-14 vs bank 2026-07-12" in reasons
    assert "similar description" in reasons
    bank_line = next(row for row in body["lines"] if row["fingerprint"] == "debit-merge")
    assert bank_line["merge_candidates"]
    assert bank_line["merge_candidates"][0]["id"] == str(expense.id)


def test_merge_overwrites_app_with_bank_values(client, db):
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("200.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="Typed 200 by mistake",
        reference="OLD",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    session = _open_session(
        db,
        lines=[_debit_line()],
        unmatched_app=[
            {
                "kind": "expense",
                "id": str(expense.id),
                "transaction_date": "2026-07-10",
                "amount": "200.00",
                "description": "Typed 200 by mistake",
                "status": "unmatched",
            }
        ],
    )
    applied = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "merge",
                    "fingerprint": "debit-merge",
                    "kind": "expense",
                    "tx_id": str(expense.id),
                }
            ]
        },
    )
    assert applied.status_code == 200, applied.text
    line = next(
        row for row in applied.json()["lines"] if row["fingerprint"] == "debit-merge"
    )
    assert line["status"] == "matched"
    assert line["proposed_tx_id"] == str(expense.id)
    leftover = [
        row
        for row in applied.json()["unmatched_app"]
        if row["id"] == str(expense.id) and row.get("status") == "unmatched"
    ]
    assert leftover == []
    db.expire_all()
    updated = db.get(Expense, expense.id)
    assert updated is not None
    assert updated.amount == Decimal("195.00")
    assert updated.transaction_date == date(2026, 7, 12)
    assert updated.bank_asmachta == "M195"
    assert updated.reference == "M195"
    assert updated.bank_verified_at is not None


def test_link_to_app_alias_merges(client, db):
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("88.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="Almost the bank debit",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    session = _open_session(
        db,
        lines=[_debit_line(amount="88.00", tx_date="2026-07-10")],
        unmatched_app=[
            {
                "kind": "expense",
                "id": str(expense.id),
                "transaction_date": "2026-07-10",
                "amount": "88.00",
                "description": "Almost the bank debit",
                "status": "unmatched",
            }
        ],
    )
    applied = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "link_to_app",
                    "fingerprint": "debit-merge",
                    "kind": "expense",
                    "tx_id": str(expense.id),
                }
            ]
        },
    )
    assert applied.status_code == 200, applied.text
    db.expire_all()
    updated = db.get(Expense, expense.id)
    assert updated is not None
    assert updated.bank_verified_at is not None
    assert updated.bank_asmachta == "M195"


def test_merge_rejects_rental_and_he_she(client, db):
    rental = Deposit(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("100.00"),
        currency="ILS",
        source="rental_income",
        is_rental_income=True,
        description="July rent",
    )
    he_she = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 10),
        amount=Decimal("50.00"),
        category="maintenance",
        source="manual",
        payment_method="cash",
        paid_by_resident=True,
        description="He/She paid",
    )
    db.add_all([rental, he_she])
    db.commit()
    db.refresh(rental)
    db.refresh(he_she)
    session = _open_session(
        db,
        lines=[
            {
                "fingerprint": "credit-1",
                "row_number": 1,
                "transaction_date": "2026-07-10",
                "side": "credit",
                "amount": "100.00",
                "asmachta": "R1",
                "description": "Rent in",
                "status": "unmatched",
            },
            {
                "fingerprint": "debit-1",
                "row_number": 2,
                "transaction_date": "2026-07-10",
                "side": "debit",
                "amount": "50.00",
                "asmachta": "H1",
                "description": "He she",
                "status": "unmatched",
            },
        ],
    )
    rental_fail = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "merge",
                    "fingerprint": "credit-1",
                    "kind": "deposit",
                    "tx_id": str(rental.id),
                }
            ]
        },
    )
    assert rental_fail.status_code == 400
    assert "rental" in rental_fail.json()["detail"].lower()

    he_she_fail = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session.id}/actions",
        json={
            "actions": [
                {
                    "action": "merge",
                    "fingerprint": "debit-1",
                    "kind": "expense",
                    "tx_id": str(he_she.id),
                }
            ]
        },
    )
    assert he_she_fail.status_code == 400
    assert "he/she" in he_she_fail.json()["detail"].lower()
