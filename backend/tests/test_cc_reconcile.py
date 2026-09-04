"""Step 6: paid-by-card + credit-card Excel match / verify."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.expense import Expense
from app.services.bank_reconcile_gap import sum_bank_scoped_nets
from app.services.cc_reconcile import parse_cc_statement_lines
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data
from app.services.transaction_ref import register_transaction_ref_listeners

SAMPLE_CC = (
    Path(__file__).resolve().parents[2] / "data" / "ClientData" / "credit card 1 example.xlsx"
)
if not SAMPLE_CC.exists():
    SAMPLE_CC = (
        Path(__file__).resolve().parents[2].parent
        / "data"
        / "ClientData"
        / "credit card 1 example.xlsx"
    )


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
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.mark.skipif(not SAMPLE_CC.exists(), reason="sample CC Excel not present")
def test_parse_cc_sample():
    parsed = parse_cc_statement_lines(SAMPLE_CC.read_bytes())
    assert parsed["movement_row_count"] > 0
    assert parsed["statement_start_date"] <= parsed["statement_end_date"]
    assert all(Decimal(line["amount"]) > 0 for line in parsed["lines"])


def test_paid_by_card_excluded_from_bank_gap(db):
    before, _, _, before_exp = sum_bank_scoped_nets(db, after_date=None)
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 6, 10),
            amount=Decimal("321.00"),
            category="maintenance",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="Card Merchant",
            description="Paid by card — not bank Gap",
        )
    )
    db.commit()
    after, _, _, after_exp = sum_bank_scoped_nets(db, after_date=None)
    assert after == before
    assert after_exp == before_exp


@pytest.mark.skipif(not SAMPLE_CC.exists(), reason="sample CC Excel not present")
def test_cc_reconcile_match_confirm_no_duplicate(client, db):
    parsed = parse_cc_statement_lines(SAMPLE_CC.read_bytes())
    line = parsed["lines"][0]
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date.fromisoformat(line["transaction_date"]),
        amount=Decimal(line["amount"]),
        category="maintenance",
        source="credit_card",
        payment_method="credit_card",
        vendor_name=line.get("merchant"),
        description=line.get("merchant"),
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    expense_id = str(expense.id)
    expense_ref = expense.transaction_ref
    before_count = db.query(Expense).count()

    with SAMPLE_CC.open("rb") as handle:
        created = client.post(
            "/api/v1/bank-settings/cc-reconcile/sessions",
            files={
                "file": (
                    "credit card 1 example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert created.status_code == 200, created.text
    session = created.json()
    proposed = [row for row in session["lines"] if row["status"] == "proposed_match"]
    assert any(row.get("proposed_tx_id") == expense_id for row in proposed)

    match = next(row for row in proposed if row.get("proposed_tx_id") == expense_id)
    other_cc = [
        row
        for row in session["lines"]
        if row["fingerprint"] != match["fingerprint"]
        and row["status"] in ("unmatched", "proposed_match")
    ]
    apps = [row for row in session["unmatched_app"] if row["status"] == "unmatched"]

    actions = [
        {
            "action": "confirm_match",
            "fingerprint": match["fingerprint"],
            "tx_id": expense_id,
        }
    ]
    actions += [
        {"action": "ignore_cc", "fingerprint": row["fingerprint"], "reason": "test"}
        for row in other_cc
    ]
    actions += [
        {"action": "ignore_app", "tx_id": row["id"], "reason": "test"} for row in apps
    ]

    applied = client.post(
        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["can_complete"] is True

    db.refresh(expense)
    assert expense.cc_verified_at is not None
    assert expense.transaction_ref == expense_ref
    assert db.query(Expense).count() == before_count

    # Re-upload: already CC-verified expense should not be proposed again as a new create
    with SAMPLE_CC.open("rb") as handle:
        again = client.post(
            "/api/v1/bank-settings/cc-reconcile/sessions",
            files={
                "file": (
                    "credit card 1 example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        ).json()
    assert not any(
        row.get("proposed_tx_id") == expense_id and row["status"] == "proposed_match"
        for row in again["lines"]
    )
    assert db.query(Expense).count() == before_count

    completed = client.post(
        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/complete"
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
