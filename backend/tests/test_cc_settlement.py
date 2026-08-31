"""Step 7: bank CC settlement confirms CC-verified merchant date groups."""

from datetime import date, datetime, timezone
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
def test_settlement_proposes_group_and_confirm_no_double_count(client, db):
    now = datetime.now(timezone.utc)
    # Merchants in window after 2026-06-10 settlement → before/on 2026-07-02
    merchants = [
        ("Zoom A", Decimal("1000.00"), date(2026, 6, 15)),
        ("Zoom B", Decimal("1166.50"), date(2026, 6, 20)),
        ("Zoom C", Decimal("1000.00"), date(2026, 6, 28)),
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
    # Extra merchant in an earlier billing window (not the July settlement group)
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 6, 5),
            amount=Decimal("50.00"),
            category="utilities",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="Outside",
            cc_verified_at=now,
        )
    )
    db.commit()

    net_before, _, _, exp_before = sum_bank_scoped_nets(db, after_date=date(2026, 6, 1))
    assert exp_before == Decimal("0")  # CC merchants excluded from bank N

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
    settlements = [
        line for line in session["lines"] if line["status"] == "proposed_settlement"
    ]
    assert len(settlements) >= 1
    july = next(
        line
        for line in settlements
        if line.get("transaction_date") == "2026-07-02"
    )
    assert july["proposed_kind"] == "cc_settlement"
    assert Decimal(july["amount"]) == Decimal("3166.5")
    assert len(july["proposed_member_ids"]) == 3
    assert Decimal(july["proposed_group_total"]) == Decimal("3166.50")

    confirmed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={
            "actions": [
                {
                    "action": "confirm_settlement",
                    "fingerprint": july["fingerprint"],
                    "member_ids": july["proposed_member_ids"],
                }
            ]
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    settled = next(line for line in body["lines"] if line["fingerprint"] == july["fingerprint"])
    assert settled["status"] == "settled"
    assert settled.get("settlement_group_id")

    for expense in db.query(Expense).filter(Expense.vendor_name.in_(["Zoom A", "Zoom B", "Zoom C"])):
        assert expense.cc_bank_confirmed_at is not None
        assert expense.cc_settlement_group_id is not None

    net_after, _, _, exp_after = sum_bank_scoped_nets(db, after_date=date(2026, 6, 1))
    assert exp_after == exp_before == Decimal("0")
    assert net_after == net_before
    # No new expenses created for settlement
    assert db.query(Expense).filter(Expense.payment_method == "credit_card").count() == 4
