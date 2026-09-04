"""Step 4: bank Excel match / verify session."""

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
from app.services.bank_reconcile_gap import parse_bank_statement_lines
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data
from app.services.transaction_ref import register_transaction_ref_listeners

SAMPLE_BANK = (
    Path(__file__).resolve().parents[2] / "data" / "ClientData" / "Bank Account example.xlsx"
)
if not SAMPLE_BANK.exists():
    SAMPLE_BANK = (
        Path(__file__).resolve().parents[2].parent
        / "data"
        / "ClientData"
        / "Bank Account example.xlsx"
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


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_parse_lines_earliest_is_min_date():
    parsed = parse_bank_statement_lines(SAMPLE_BANK.read_bytes())
    dates = [
        date.fromisoformat(line["transaction_date"])
        for line in parsed["lines"]
        if line.get("transaction_date")
    ]
    assert dates
    assert parsed["statement_start_date"] == min(dates)
    assert parsed["statement_end_date"] == max(dates)
    assert isinstance(parsed["statement_start_date"], date)


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_reconcile_propose_confirm_ignore_complete(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "174447.63",
            "opening_balance_as_of": "2026-06-01",
            "last_verification_date": "2026-06-01",
            "gap_tolerance_amount": "999999.00",
        },
    )

    parsed = parse_bank_statement_lines(SAMPLE_BANK.read_bytes())
    debit = next(line for line in parsed["lines"] if line["side"] == "debit")
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date.fromisoformat(debit["transaction_date"]),
        amount=Decimal(debit["amount"]),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description=debit.get("description") or "bank match test",
        reference=debit.get("asmachta"),
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    expense_id = str(expense.id)
    expense_ref = expense.transaction_ref

    with SAMPLE_BANK.open("rb") as handle:
        created = client.post(
            "/api/v1/bank-settings/reconcile/sessions",
            files={
                "file": (
                    "Bank Account example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert created.status_code == 200, created.text
    session = created.json()
    assert session["statement_start_date"] == "2026-06-02"
    assert session["status"] == "in_progress"

    proposed = [line for line in session["lines"] if line["status"] == "proposed_match"]
    assert any(line.get("proposed_tx_id") == expense_id for line in proposed)

    match_line = next(line for line in proposed if line.get("proposed_tx_id") == expense_id)
    other_bank = [
        line
        for line in session["lines"]
        if line["fingerprint"] != match_line["fingerprint"]
        and line["status"] in ("unmatched", "proposed_match", "proposed_settlement")
    ]
    app_rows = [row for row in session["unmatched_app"] if row["status"] == "unmatched"]

    actions = [
        {
            "action": "confirm_match",
            "fingerprint": match_line["fingerprint"],
            "kind": "expense",
            "tx_id": expense_id,
        }
    ]
    for line in other_bank:
        actions.append(
            {
                "action": "ignore_bank",
                "fingerprint": line["fingerprint"],
                "reason": "test ignore leftover bank",
            }
        )
    for row in app_rows:
        actions.append(
            {
                "action": "ignore_app",
                "kind": row["kind"],
                "tx_id": row["id"],
                "reason": "test ignore leftover app",
            }
        )

    applied = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert body["can_complete"] is True

    db.refresh(expense)
    assert expense.bank_verified_at is not None
    assert expense.transaction_ref == expense_ref
    assert expense.bank_asmachta == debit.get("asmachta")

    completed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/complete"
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"

    # Fresh upload cannot complete until non-settlement lines are cleared.
    # Card payment rows alone do not block Complete (they wait for Card linkage).
    with SAMPLE_BANK.open("rb") as handle:
        open_resp = client.post(
            "/api/v1/bank-settings/reconcile/sessions",
            files={
                "file": (
                    "Bank Account example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert open_resp.status_code == 200, open_resp.text
    open_session = open_resp.json()
    assert open_session["can_complete"] is False
    blocked = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{open_session['id']}/complete"
    )
    assert blocked.status_code == 400

    settings = client.get("/api/v1/bank-settings").json()
    assert settings["last_verification_date"] == "2026-07-08"
