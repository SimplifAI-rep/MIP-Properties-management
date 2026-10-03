from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.expense import Expense
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data, seed_sample_expenses
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
    seed_sample_expenses(session)
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


def test_get_bank_settings_defaults(client):
    response = client.get("/api/v1/bank-settings")
    assert response.status_code == 200
    body = response.json()
    assert body["opening_balance"] is None
    assert body["last_verification_date"] is None
    assert Decimal(body["gap_tolerance_amount"]) == Decimal("0.01")
    assert body["unverified_count"] >= 0


def test_patch_bank_settings(client):
    response = client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "114834.88",
            "opening_balance_as_of": "2026-07-09",
            "last_verification_date": "2026-07-09",
            "gap_tolerance_amount": "1.00",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert Decimal(body["opening_balance"]) == Decimal("114834.88")
    assert body["opening_balance_as_of"] == "2026-07-09"
    assert body["last_verification_date"] == "2026-07-09"
    assert Decimal(body["gap_tolerance_amount"]) == Decimal("1.00")


def test_go_live_cutover_marks_verified(client, db):
    # Seed expenses are dated in 2026-01 / 2026-02 range typically — use late cutover
    cutover = "2026-12-31"
    response = client.post(
        "/api/v1/bank-settings/cutover",
        json={
            "opening_balance": "100000.00",
            "as_of_date": cutover,
            "gap_tolerance_amount": "0.01",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["expenses_marked"] >= 6
    assert body["settings"]["last_verification_date"] == cutover
    assert Decimal(body["settings"]["opening_balance"]) == Decimal("100000.00")

    db.expire_all()
    expenses = db.scalars(select(Expense)).all()
    assert all(e.bank_verified_at is not None for e in expenses)
    assert all(e.bank_asmachta is None for e in expenses)
    card_rows = [e for e in expenses if e.payment_method == "credit_card"]
    assert card_rows
    assert all(e.cc_verified_at is not None for e in card_rows)
    assert all(e.cc_bank_confirmed_at is not None for e in card_rows)
    assert all(e.cc_deferred_until is None for e in card_rows)
    non_card = [e for e in expenses if e.payment_method != "credit_card"]
    assert non_card
    assert all(e.cc_verified_at is None for e in non_card)

    # New expense after cutover stays unverified
    create = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2027-01-15",
            "amount": "50.00",
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
        },
    )
    assert create.status_code == 201
    assert create.json().get("bank_verified_at") is None

    settings = client.get("/api/v1/bank-settings").json()
    assert settings["unverified_count"] >= 1
    assert settings["last_verification_date"] == cutover


def test_unverified_stale_alert_after_go_live(client, db):
    from app.services.bank_settings import month_ago, resolve_account_settings

    today = date.today()
    last = month_ago(month_ago(today))
    stale_date = month_ago(today) - timedelta(days=2)
    fresh_date = today - timedelta(days=3)

    account, company = resolve_account_settings(db)
    if account is not None:
        account.last_verification_date = last
        db.add(account)
    company.last_verification_date = last
    db.add(company)
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=stale_date,
            amount=Decimal("40.00"),
            category="maintenance",
            source="manual_company",
            payment_method="bank_transfer",
            description="stale unverified",
        )
    )
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=fresh_date,
            amount=Decimal("15.00"),
            category="maintenance",
            source="manual_company",
            payment_method="bank_transfer",
            description="recent unverified",
        )
    )
    db.commit()

    alerts = client.get("/api/v1/alerts").json()["items"]
    stale = next(item for item in alerts if item["alert_type"] == "unverified_stale")
    assert stale["title"] == "Unverified for more than a month"
    assert stale["link_path"] == "/verification"
    assert "still unverified" in stale["message"]


def test_unverified_stale_alert_skips_before_go_live(client, db):
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date.today() - timedelta(days=80),
            amount=Decimal("40.00"),
            category="maintenance",
            source="manual_company",
            payment_method="bank_transfer",
            description="old but never went live",
        )
    )
    db.commit()
    alerts = client.get("/api/v1/alerts").json()["items"]
    assert all(item["alert_type"] != "unverified_stale" for item in alerts)


def test_unverified_stale_alert_skips_when_only_last_check_is_old(client, db):
    """Go-live from an older Excel must not nag until leftover unverified txs age out."""
    from app.services.bank_settings import month_ago, resolve_account_settings

    last = month_ago(month_ago())
    account, company = resolve_account_settings(db)
    if account is not None:
        account.last_verification_date = last
        db.add(account)
    company.last_verification_date = last
    db.add(company)
    db.commit()

    alerts = client.get("/api/v1/alerts").json()["items"]
    assert all(item["alert_type"] != "unverified_stale" for item in alerts)


def test_workspace_headline_closed_offset_is_zero(client):
    workspace = client.get("/api/v1/bank-settings/verification-workspace")
    assert workspace.status_code == 200
    headline = workspace.json()["headline"]
    assert headline["period_open"] is False
    assert Decimal(str(headline["verification_offset"])) == Decimal("0")
    assert headline["open_session_id"] is None
