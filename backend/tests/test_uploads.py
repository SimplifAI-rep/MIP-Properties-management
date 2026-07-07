from io import BytesIO
from uuid import UUID

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.uploaded_document import UploadedDocument
from app.services.seed import (
    ACCOUNT_ROTHSCHILD,
    PROPERTY_ROTHSCHILD_ID,
    seed_reference_data,
)


@pytest.fixture
def db():
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


def _make_excel(rows: list[dict]) -> bytes:
    df = pd.DataFrame(rows)
    buffer = BytesIO()
    df.to_excel(buffer, index=False)
    buffer.seek(0)
    return buffer.read()


def test_analyze_deposit_excel_returns_drafts(client):
    payload = _make_excel(
        [
            {
                "account_number": ACCOUNT_ROTHSCHILD,
                "transaction_date": "2026-02-01",
                "amount": 5000,
                "currency": "ILS",
                "reference": "UPLOAD-001",
                "description": "Uploaded deposit",
            }
        ]
    )
    response = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "deposit",
        },
        files={"file": ("deposits.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["parser"] == "excel"
    assert body["ready_count"] == 1
    assert len(body["drafts"]) == 1
    assert body["drafts"][0]["amount"] == "5000.00"
    assert body["upload_id"]


def test_confirm_deposit_upload_inserts_record(client, db):
    payload = _make_excel(
        [
            {
                "account_number": ACCOUNT_ROTHSCHILD,
                "transaction_date": "2026-03-01",
                "amount": 4200,
                "currency": "ILS",
                "reference": "UPLOAD-CONFIRM-001",
                "description": "Confirmed upload",
            }
        ]
    )
    analyze = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "deposit",
        },
        files={"file": ("deposits.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    upload_id = analyze.json()["upload_id"]
    drafts = analyze.json()["drafts"]

    confirm = client.post(
        f"/api/v1/uploads/{upload_id}/confirm",
        json={"drafts": drafts},
    )
    assert confirm.status_code == 200
    body = confirm.json()
    assert body["imported_deposit_count"] == 1

    deposits = db.scalars(select(Deposit).where(Deposit.reference == "UPLOAD-CONFIRM-001")).all()
    assert len(deposits) == 1
    assert deposits[0].source == "file_upload"

    document = db.get(UploadedDocument, UUID(upload_id))
    assert document is not None
    assert document.status == "confirmed"
    assert document.property_id == PROPERTY_ROTHSCHILD_ID


def test_analyze_expense_excel_returns_drafts(client):
    payload = _make_excel(
        [
            {
                "transaction_date": "2026-02-15",
                "amount": 350.5,
                "category": "utilities",
                "source": "standing_order",
                "payment_method": "bank_direct_debit",
                "vendor_name": "Electric Co",
                "description": "February bill",
            }
        ]
    )
    response = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "expense",
        },
        files={"file": ("expenses.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ready_count"] == 1
    assert body["drafts"][0]["category"] == "utilities"


def test_confirm_expense_upload_inserts_record(client, db):
    payload = _make_excel(
        [
            {
                "transaction_date": "2026-04-10",
                "amount": 199.99,
                "category": "maintenance",
                "source": "manual_company",
                "payment_method": "company_account",
                "description": "Plumber visit",
            }
        ]
    )
    analyze = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "expense",
        },
        files={"file": ("expenses.xlsx", payload, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    upload_id = analyze.json()["upload_id"]
    drafts = analyze.json()["drafts"]

    confirm = client.post(f"/api/v1/uploads/{upload_id}/confirm", json={"drafts": drafts})
    assert confirm.status_code == 200
    assert confirm.json()["imported_expense_count"] == 1
    assert db.scalars(select(Expense)).all().__len__() == 1


def test_reject_unsupported_file_type(client):
    response = client.post(
        "/api/v1/uploads/analyze",
        data={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_type": "expense",
        },
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 400
