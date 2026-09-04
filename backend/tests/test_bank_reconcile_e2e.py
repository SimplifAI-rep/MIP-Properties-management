"""Comprehensive automated coverage for design Steps 1–7."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services.bank_reconcile_gap import (
    parse_bank_statement_balance,
    parse_bank_statement_lines,
    sum_bank_scoped_nets,
)
from app.services.cc_reconcile import parse_cc_statement_lines
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data
from app.services.transaction_ref import register_transaction_ref_listeners

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_BANK = ROOT / "data" / "ClientData" / "Bank Account example.xlsx"
SAMPLE_CC = ROOT / "data" / "ClientData" / "credit card 1 example.xlsx"
if not SAMPLE_BANK.exists():
    SAMPLE_BANK = ROOT.parent / "data" / "ClientData" / "Bank Account example.xlsx"
if not SAMPLE_CC.exists():
    SAMPLE_CC = ROOT.parent / "data" / "ClientData" / "credit card 1 example.xlsx"

pytestmark = [
    pytest.mark.skipif(not SAMPLE_BANK.exists(), reason="sample bank Excel missing"),
    pytest.mark.skipif(not SAMPLE_CC.exists(), reason="sample CC Excel missing"),
]


@pytest.fixture
def db():
    register_transaction_ref_listeners()
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    tables = set(inspect(engine).get_table_names())
    assert "company_bank_settings" in tables
    assert "bank_reconcile_sessions" in tables
    assert "cc_reconcile_sessions" in tables
    assert "cc_settlement_groups" in tables
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


def _upload(client, path: Path, url: str):
    with path.open("rb") as handle:
        return client.post(
            url,
            files={
                "file": (
                    path.name,
                    handle,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )
            },
        )


def test_step1_schema_and_refs(client, db):
    expense = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-06-15",
            "amount": "12.50",
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
            "description": "ref check",
        },
    )
    assert expense.status_code in (200, 201), expense.text
    body = expense.json()
    assert body["transaction_ref"]
    assert body["transaction_ref"].startswith("20260615-")
    assert body.get("bank_verified_at") in (None, "")
    assert "cc_verified_at" in body

    deposit = client.post(
        "/api/v1/deposits",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-06-16",
            "amount": "100.00",
            "currency": "ILS",
            "description": "deposit ref",
        },
    )
    assert deposit.status_code in (200, 201), deposit.text
    assert deposit.json()["transaction_ref"].startswith("20260616-")


def test_step2_opening_cutover_and_settings(client, db):
    patched = client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "1000.00",
            "opening_balance_as_of": "2026-05-31",
            "last_verification_date": "2026-05-31",
            "gap_tolerance_amount": "1.00",
        },
    )
    assert patched.status_code == 200
    settings = client.get("/api/v1/bank-settings").json()
    assert Decimal(settings["opening_balance"]) == Decimal("1000.00")
    assert settings["opening_balance_as_of"] == "2026-05-31"
    assert settings["gap_tolerance_amount"] == "1.00"

    old = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 5, 1),
        amount=Decimal("40.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="pre-cutover",
    )
    new = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 6, 5),
        amount=Decimal("55.00"),
        category="maintenance",
        source="manual",
        payment_method="bank_transfer",
        description="post-cutover",
    )
    db.add_all([old, new])
    db.commit()
    db.refresh(old)
    db.refresh(new)

    cutover = client.post(
        "/api/v1/bank-settings/cutover",
        json={
            "opening_balance": "1000.00",
            "as_of_date": "2026-05-31",
        },
    )
    assert cutover.status_code == 200, cutover.text
    db.refresh(old)
    db.refresh(new)
    assert old.bank_verified_at is not None
    assert old.bank_asmachta is None
    assert new.bank_verified_at is None


def test_step3_gap_parse_earliest_and_owner_paid(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "174447.63",
            "opening_balance_as_of": "2026-06-01",
            "gap_tolerance_amount": "0.01",
        },
    )
    parsed = parse_bank_statement_balance(SAMPLE_BANK.read_bytes())
    assert isinstance(parsed["statement_start_date"], date)
    assert parsed["statement_start_date"] == date(2026, 6, 2)
    assert parsed["statement_end_date"] == date(2026, 7, 8)

    upload = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/parse-bank-balance")
    assert upload.status_code == 200
    body = upload.json()
    assert body["statement_start_date"] == "2026-06-02"
    assert "T" not in body["statement_start_date"]

    before = client.get(
        "/api/v1/bank-settings/gap",
        params={"bank_balance": body["bank_balance"]},
    ).json()
    db.add(
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 6, 20),
            amount=Decimal("999.00"),
            category="maintenance",
            source="manual_owner",
            payment_method="owner_personal",
            paid_by_owner=True,
            description="owner paid — out of Gap N",
        )
    )
    db.commit()
    after = client.get(
        "/api/v1/bank-settings/gap",
        params={"bank_balance": body["bank_balance"]},
    ).json()
    assert after["all_scoped_net"] == before["all_scoped_net"]
    assert after["all_scoped_expenses"] == before["all_scoped_expenses"]


def test_step4_match_confirm_cannot_complete_then_ignore(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "174447.63",
            "opening_balance_as_of": "2026-06-01",
            "last_verification_date": "2026-06-01",
            "gap_tolerance_amount": "999999.00",
        },
    )
    bank_lines = parse_bank_statement_lines(SAMPLE_BANK.read_bytes())["lines"]
    debit = next(
        line
        for line in bank_lines
        if line["side"] == "debit" and "מאסטר" not in (line.get("description") or "")
    )
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
    ref_before = expense.transaction_ref

    created = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/reconcile/sessions")
    assert created.status_code == 200
    session = created.json()
    assert session["can_complete"] is False

    blocked = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/complete"
    )
    assert blocked.status_code == 400

    match = next(
        line
        for line in session["lines"]
        if line.get("proposed_tx_id") == str(expense.id)
    )
    leftovers = [
        line
        for line in session["lines"]
        if line["fingerprint"] != match["fingerprint"]
        and line["status"] in ("unmatched", "proposed_match", "proposed_settlement")
    ]
    actions = [
        {
            "action": "confirm_match",
            "fingerprint": match["fingerprint"],
            "kind": "expense",
            "tx_id": str(expense.id),
        }
    ]
    actions += [
        {"action": "ignore_bank", "fingerprint": line["fingerprint"], "reason": "test"}
        for line in leftovers
    ]
    for row in session["unmatched_app"]:
        if row["status"] == "unmatched":
            actions.append(
                {
                    "action": "ignore_app",
                    "kind": row["kind"],
                    "tx_id": row["id"],
                    "reason": "test",
                }
            )

    applied = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    assert applied.status_code == 200
    assert applied.json()["can_complete"] is True

    db.refresh(expense)
    assert expense.bank_verified_at is not None
    assert expense.transaction_ref == ref_before
    assert expense.bank_asmachta == debit.get("asmachta")

    completed = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/complete"
    )
    assert completed.status_code == 200
    settings = client.get("/api/v1/bank-settings").json()
    assert settings["last_verification_date"] == "2026-07-08"

    # Re-upload does not recreate the verified expense
    count_before = db.query(Expense).count()
    again = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/reconcile/sessions")
    assert again.status_code == 200
    assert db.query(Expense).count() == count_before
    assert not any(
        line.get("proposed_tx_id") == str(expense.id)
        for line in again.json()["lines"]
        if line["status"] == "proposed_match"
    )


def test_step4_add_from_bank_creates_verified(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "0",
            "opening_balance_as_of": "2026-06-01",
            "gap_tolerance_amount": "999999",
        },
    )
    created = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/reconcile/sessions")
    session = created.json()
    unmatched = next(
        line
        for line in session["lines"]
        if line["status"] == "unmatched" and line["side"] == "debit"
    )
    before = db.query(Expense).count()
    added = client.post(
        f"/api/v1/bank-settings/reconcile/sessions/{session['id']}/actions",
        json={
            "actions": [
                {
                    "action": "add_from_bank",
                    "fingerprint": unmatched["fingerprint"],
                    "property_id": str(PROPERTY_ROTHSCHILD_ID),
                }
            ]
        },
    )
    assert added.status_code == 200, added.text
    assert db.query(Expense).count() == before + 1
    line = next(
        row
        for row in added.json()["lines"]
        if row["fingerprint"] == unmatched["fingerprint"]
    )
    assert line["status"] == "added"
    from uuid import UUID

    expense = db.get(Expense, UUID(line["proposed_tx_id"]))
    assert expense is not None
    assert expense.bank_verified_at is not None
    assert expense.bank_asmachta == unmatched.get("asmachta")
    assert expense.transaction_ref


def test_step5_bank_alerts_require_reason_and_clear(client, db):
    client.patch(
        "/api/v1/bank-settings",
        json={
            "opening_balance": "1.00",
            "opening_balance_as_of": "2026-06-01",
            "gap_tolerance_amount": "0.01",
        },
    )
    session = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/reconcile/sessions").json()
    alerts = client.get("/api/v1/alerts?property_status=all").json()
    types = {item["alert_type"] for item in alerts["items"]}
    assert "bank_unmatched" in types
    assert "bank_gap" in types
    bank_alert = next(item for item in alerts["items"] if item["alert_type"] == "bank_unmatched")
    assert bank_alert["link_path"] == f"/verification?session={session['id']}"
    assert client.post(f"/api/v1/alerts/{bank_alert['id']}/dismiss", json={}).status_code == 400
    assert (
        client.post(
            f"/api/v1/alerts/{bank_alert['id']}/dismiss",
            json={"reason": "exception reviewed"},
        ).status_code
        == 200
    )


def test_step6_cc_path_and_alerts(client, db):
    cc_lines = parse_cc_statement_lines(SAMPLE_CC.read_bytes())["lines"]
    line = cc_lines[0]
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

    # Paid-by-card excluded from bank Gap N
    _, _, _, only_cc = sum_bank_scoped_nets(db, after_date=date(2020, 1, 1))
    assert only_cc == Decimal("0")

    created = _upload(client, SAMPLE_CC, "/api/v1/bank-settings/cc-reconcile/sessions")
    assert created.status_code == 200
    session = created.json()
    alerts = client.get("/api/v1/alerts?property_status=all").json()
    assert any(item["alert_type"] == "cc_unmatched" for item in alerts["items"])
    cc_alert = next(item for item in alerts["items"] if item["alert_type"] == "cc_unmatched")
    assert cc_alert["link_path"] == f"/verification?cc_session={session['id']}"

    proposed = next(
        row
        for row in session["lines"]
        if row.get("proposed_tx_id") == str(expense.id)
    )
    leftovers = [
        row
        for row in session["lines"]
        if row["fingerprint"] != proposed["fingerprint"]
        and row["status"] in ("unmatched", "proposed_match")
    ]
    actions = [
        {
            "action": "confirm_match",
            "fingerprint": proposed["fingerprint"],
            "tx_id": str(expense.id),
        }
    ]
    actions += [
        {"action": "ignore_cc", "fingerprint": row["fingerprint"], "reason": "ok"}
        for row in leftovers
    ]
    for row in session["unmatched_app"]:
        if row["status"] == "unmatched":
            actions.append(
                {"action": "ignore_app", "tx_id": row["id"], "reason": "ok"}
            )

    applied = client.post(
        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/actions",
        json={"actions": actions},
    )
    assert applied.status_code == 200
    db.refresh(expense)
    assert expense.cc_verified_at is not None

    completed = client.post(
        f"/api/v1/bank-settings/cc-reconcile/sessions/{session['id']}/complete"
    )
    assert completed.status_code == 200
    after_alerts = client.get("/api/v1/alerts?property_status=all").json()
    assert not any(
        item["alert_type"] in {"cc_unmatched", "cc_app_unmatched"}
        for item in after_alerts["items"]
    )


def test_step7_settlement_group_no_double_count_in_n(client, db):
    now = datetime.now(timezone.utc)
    members = [
        ("A", Decimal("1000.00"), date(2026, 6, 15)),
        ("B", Decimal("1166.50"), date(2026, 6, 20)),
        ("C", Decimal("1000.00"), date(2026, 6, 28)),
    ]
    for name, amount, tx_date in members:
        db.add(
            Expense(
                property_id=PROPERTY_ROTHSCHILD_ID,
                transaction_date=tx_date,
                amount=amount,
                category="utilities",
                source="credit_card",
                payment_method="credit_card",
                vendor_name=name,
                cc_verified_at=now,
            )
        )
    db.commit()
    _, _, _, exp_before = sum_bank_scoped_nets(db, after_date=date(2026, 6, 1))
    assert exp_before == Decimal("0")

    session = _upload(client, SAMPLE_BANK, "/api/v1/bank-settings/reconcile/sessions").json()
    july = next(
        line
        for line in session["lines"]
        if line["status"] == "proposed_settlement"
        and line.get("transaction_date") == "2026-07-02"
    )
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
    assert confirmed.status_code == 200
    settled = next(
        line
        for line in confirmed.json()["lines"]
        if line["fingerprint"] == july["fingerprint"]
    )
    assert settled["status"] == "settled"
    assert settled.get("settlement_group_id")
    for expense in db.query(Expense).filter(Expense.vendor_name.in_(["A", "B", "C"])):
        assert expense.cc_bank_confirmed_at is not None
        assert expense.cc_settlement_group_id is not None

    _, _, _, exp_after = sum_bank_scoped_nets(db, after_date=date(2026, 6, 1))
    assert exp_after == Decimal("0")


def test_frontend_verification_surface_exists():
    """Static presence checks for Verification IA claimed in the design doc."""
    frontend = ROOT / "frontend" / "src"
    if not frontend.exists():
        frontend = ROOT.parent / "frontend" / "src"
    app_tsx = (frontend / "App.tsx").read_text(encoding="utf-8")
    assert "VerificationPage" in app_tsx
    assert 'path="verification"' in app_tsx or "path='verification'" in app_tsx
    shell = (frontend / "components" / "layout" / "AppShell.tsx").read_text(encoding="utf-8")
    assert "Verification" in shell
    page = (frontend / "pages" / "VerificationPage.tsx").read_text(encoding="utf-8")
    assert "VerificationWorkspace" in page
    assert "BankVerificationPanel" in page
    workspace = (frontend / "components" / "VerificationWorkspace.tsx").read_text(
        encoding="utf-8"
    )
    assert "BankReconcilePanel" in workspace
    assert "CcReconcilePanel" in workspace
    assert "HistorySessionGroups" in workspace
    assert "Bank history" in workspace
    bank_panel = (frontend / "components" / "BankReconcilePanel.tsx").read_text(
        encoding="utf-8"
    )
    assert "Able to verify" in bank_panel
    assert "Not in Excel" in bank_panel
    assert "Not in bank" in bank_panel
    assert "Create transaction" in bank_panel
    assert "Confirm CC settlements" in bank_panel or "Confirm CC settlement" in bank_panel
    page_text = (frontend / "pages" / "VerificationPage.tsx").read_text(encoding="utf-8")
    assert "Opening O" in page_text
    assert "Bank balance B" in page_text
    assert "Verified Gap" in page_text
    cc_panel = (frontend / "components" / "CcReconcilePanel.tsx").read_text(
        encoding="utf-8"
    )
    assert "Able to verify" in cc_panel
    assert "Not in Excel" in cc_panel
    assert "Not in bank" in cc_panel
    dash = (frontend / "pages" / "DashboardPage.tsx").read_text(encoding="utf-8")
    assert "BankVerificationSummaryCard" in dash
    assert "BankVerificationPanel" not in dash
    tx_page = (frontend / "pages" / "TransactionsPage.tsx").read_text(encoding="utf-8")
    assert "Paid by card" in tx_page
    table = (frontend / "components" / "TransactionTable.tsx").read_text(encoding="utf-8")
    assert "CC-pending" in table
    assert "CC-verified" in table
    assert "CC bank-confirmed" in table
    alerts = (frontend / "pages" / "AlertsPage.tsx").read_text(encoding="utf-8")
    assert "cc_unmatched" in alerts
    assert "Open Verification" in alerts
