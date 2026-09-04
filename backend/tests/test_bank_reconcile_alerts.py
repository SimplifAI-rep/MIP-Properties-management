"""Step 5: high-priority bank reconcile alerts."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.alert_action import AlertAction
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


def _open_session(client):
    with SAMPLE_BANK.open("rb") as handle:
        response = client.post(
            "/api/v1/bank-settings/reconcile/sessions",
            files={
                "file": (
                    "Bank Account example.xlsx",
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_open_reconcile_session_creates_error_alerts(client):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "1.00",
            "opening_balance_as_of": "2026-06-01",
            "last_verification_date": "2026-06-01",
            "gap_tolerance_amount": "0.01",
        },
    )
    session = _open_session(client)
    alerts = client.get("/api/v1/alerts?property_status=all").json()
    types = {item["alert_type"] for item in alerts["items"]}
    assert "bank_unmatched" in types
    assert "bank_gap" in types
    bank_alert = next(item for item in alerts["items"] if item["alert_type"] == "bank_unmatched")
    assert bank_alert["severity"] == "error"
    assert bank_alert["reconcile_session_id"] == session["id"]
    assert bank_alert["link_path"] == f"/verification?session={session['id']}"
    assert alerts["error_count"] >= 1


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_owner_paid_not_in_app_unmatched_alert(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "174447.63",
            "opening_balance_as_of": "2026-06-01",
            "last_verification_date": "2026-06-01",
            "gap_tolerance_amount": "999999.00",
        },
    )
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 6, 15),
            amount=Decimal("250.00"),
            category="maintenance",
            source="manual_owner",
            payment_method="owner_personal",
            paid_by_owner=True,
            description="Owner paid plumber — should not alert",
        )
    )
    db.commit()
    session = _open_session(client)
    assert session["counts"]["app_unmatched"] == 0
    alerts = client.get("/api/v1/alerts?property_status=all").json()
    assert not any(item["alert_type"] == "app_unmatched" for item in alerts["items"])


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_dismiss_reconcile_alert_requires_reason(client):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "174447.63",
            "opening_balance_as_of": "2026-06-01",
            "gap_tolerance_amount": "999999.00",
        },
    )
    _open_session(client)
    alerts = client.get("/api/v1/alerts?property_status=all").json()
    bank_alert = next(item for item in alerts["items"] if item["alert_type"] == "bank_unmatched")

    denied = client.post(f"/api/v1/alerts/{bank_alert['id']}/dismiss", json={})
    assert denied.status_code == 400

    ok = client.post(
        f"/api/v1/alerts/{bank_alert['id']}/dismiss",
        json={"reason": "Known timing difference — reviewed"},
    )
    assert ok.status_code == 200
    after = client.get("/api/v1/alerts?property_status=all").json()
    assert not any(item["id"] == bank_alert["id"] for item in after["items"])


@pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel not present")
def test_fixing_session_clears_reconcile_alerts(client, db):
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
        description=debit.get("description") or "match",
        reference=debit.get("asmachta"),
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)

    session = _open_session(client)
    before = client.get("/api/v1/alerts?property_status=all").json()
    assert any(item["alert_type"] == "bank_unmatched" for item in before["items"])

    proposed = next(
        line
        for line in session["lines"]
        if line["status"] == "proposed_match" and line.get("proposed_tx_id") == str(expense.id)
    )
    other = [
        line
        for line in session["lines"]
        if line["fingerprint"] != proposed["fingerprint"]
        and line["status"] in ("unmatched", "proposed_match", "proposed_settlement")
    ]
    actions = [
        {
            "action": "confirm_match",
            "fingerprint": proposed["fingerprint"],
            "kind": "expense",
            "tx_id": str(expense.id),
        }
    ]
    actions += [
        {"action": "ignore_bank", "fingerprint": line["fingerprint"], "reason": "ok"}
        for line in other
    ]
    for row in session["unmatched_app"]:
        if row["status"] == "unmatched":
            actions.append(
                {
                    "action": "ignore_app",
                    "kind": row["kind"],
                    "tx_id": row["id"],
                    "reason": "ok",
                }
            )

    applied = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    assert applied.status_code == 200
    assert applied.json()["can_complete"] is True

    completed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/complete"
    )
    assert completed.status_code == 200

    after = client.get("/api/v1/alerts?property_status=all").json()
    reconcile_types = {"bank_unmatched", "app_unmatched", "bank_gap"}
    assert not any(item["alert_type"] in reconcile_types for item in after["items"])
    leftover = db.scalars(
        select(AlertAction).where(AlertAction.alert_key.like("bank_unmatched:%"))
    ).all()
    assert leftover == []
