"""Card charges not in this bank payment can be pushed to the next cycle."""

from datetime import date, datetime, timedelta, timezone
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
from app.services.bank_reconcile import cc_deferral_blocks
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
def test_leftover_card_charges_group_defer_and_stay_out_of_totals(client, db):
    now = datetime.now(timezone.utc)
    merchants = [
        ("Zoom A", Decimal("1000.00"), date(2026, 7, 15)),
        ("Zoom B", Decimal("1166.50"), date(2026, 7, 20)),
        ("Zoom C", Decimal("1000.00"), date(2026, 7, 28)),
    ]
    for name, amount, tx_date in merchants:
        db.add(
            Expense(
                property_id=PROPERTY_ROTHSCHILD_ID,
                transaction_date=tx_date,
                amount=amount,
                category="utilities",
                source="credit_card",
                payment_method="credit_card",
                vendor_name=name,
                description=name,
                cc_verified_at=now,
            )
        )
    leftover = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 7, 25),
        amount=Decimal("80.00"),
        category="utilities",
        source="credit_card",
        payment_method="credit_card",
        vendor_name="Next cycle charge",
        description="Next cycle charge",
        cc_verified_at=now,
    )
    db.add(leftover)
    db.commit()
    leftover_id = str(leftover.id)

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

    member_ids = {
        str(mid)
        for line in session["lines"]
        for mid in (line.get("proposed_member_ids") or [])
    }
    assert leftover_id not in member_ids
    leftover_ids = {str(row["id"]) for row in session.get("leftover_cc_txs") or []}
    assert leftover_id in leftover_ids
    before_app_out = Decimal(session["app_out"])
    before_bank_out = Decimal(session["bank_out"])

    pushed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={"actions": [{"action": "defer_cc_to_next", "tx_id": leftover_id}]},
    )
    assert pushed.status_code == 200, pushed.text
    body = pushed.json()
    leftover_after = {str(row["id"]) for row in body.get("leftover_cc_txs") or []}
    assert leftover_id not in leftover_after
    assert Decimal(body["app_out"]) == before_app_out
    assert Decimal(body["bank_out"]) == before_bank_out

    db.refresh(leftover)
    until = leftover.cc_deferred_until
    assert until is not None
    assert until == date.fromisoformat(session["statement_end_date"])
    period_start = date.fromisoformat(session["statement_start_date"])
    assert cc_deferral_blocks(leftover, period_start) is True
    assert cc_deferral_blocks(leftover, until + timedelta(days=1)) is False
