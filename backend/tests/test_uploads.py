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


def _make_text_pdf(text: str) -> bytes:
    """Minimal PDF with extractable text (no external writer dependency)."""
    # Escape parentheses for PDF literal strings
    safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 50 700 Td ({safe}) Tj ET"
    stream_bytes = stream.encode("latin-1", errors="replace")
    objects = [
        b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
        b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
        (
            b"3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n"
        ),
        (
            f"4 0 obj<< /Length {len(stream_bytes)} >>stream\n".encode("ascii")
            + stream_bytes
            + b"\nendstream\nendobj\n"
        ),
        b"5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        out.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    out.extend(
        f"trailer<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return bytes(out)


def test_analyze_pdf_auto_matches_property_without_property_id(client, monkeypatch):
    # Force the no-LLM text path so tests do not need an API key
    monkeypatch.setattr(
        "app.services.document_import.get_settings",
        lambda: type(
            "S",
            (),
            {
                "llm_api_key": "",
                "llm_model": "gpt-4o-mini",
                "llm_base_url": "https://api.openai.com/v1",
                "default_currency": "ILS",
            },
        )(),
    )

    pdf = _make_text_pdf(
        "Invoice for Rothschild 12 Total 350.00 Date 2026-05-01 Electric Co"
    )
    response = client.post(
        "/api/v1/uploads/analyze",
        data={"transaction_type": "auto"},
        files={"file": ("receipt.pdf", pdf, "application/pdf")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["parser"] in {"pdf_text", "manual"}
    assert body["property_id"] == str(PROPERTY_ROTHSCHILD_ID)
    assert body["drafts"][0]["property_id"] == str(PROPERTY_ROTHSCHILD_ID)
    assert body["drafts"][0]["property_name"] == "Rothschild 12"
    assert body["drafts"][0]["owner_name"] == "David Cohen"
    assert body["preview_url"]
    assert body["match_confidence"] in {"high", "medium", "low"}


def test_confirm_pdf_upload_creates_expense_linked_to_client(client, db, monkeypatch):
    monkeypatch.setattr(
        "app.services.document_import.get_settings",
        lambda: type(
            "S",
            (),
            {
                "llm_api_key": "",
                "llm_model": "gpt-4o-mini",
                "llm_base_url": "https://api.openai.com/v1",
                "default_currency": "ILS",
            },
        )(),
    )

    pdf = _make_text_pdf(
        "Receipt Rothschild 12 amount 199.50 Date 15/04/2026 Plumber visit"
    )
    analyze = client.post(
        "/api/v1/uploads/analyze",
        data={},
        files={"file": ("plumber.pdf", pdf, "application/pdf")},
    )
    assert analyze.status_code == 200
    upload_id = analyze.json()["upload_id"]
    drafts = analyze.json()["drafts"]
    # Ensure confirmable fields even if text amount/date parsing is imperfect
    drafts[0]["transaction_type"] = "expense"
    drafts[0]["property_id"] = str(PROPERTY_ROTHSCHILD_ID)
    drafts[0]["transaction_date"] = "2026-04-15"
    drafts[0]["amount"] = "199.50"
    drafts[0]["category"] = "maintenance"
    drafts[0]["source"] = "manual_company"
    drafts[0]["payment_method"] = "company_account"
    drafts[0]["description"] = "Plumber visit"

    confirm = client.post(f"/api/v1/uploads/{upload_id}/confirm", json={"drafts": drafts})
    assert confirm.status_code == 200
    assert confirm.json()["imported_expense_count"] == 1

    expenses = db.scalars(select(Expense)).all()
    assert len(expenses) == 1
    assert expenses[0].property_id == PROPERTY_ROTHSCHILD_ID
    assert expenses[0].receipt_ref == upload_id

    # Receipt is exposed on the expenses API for the Transactions UI
    listed = client.get("/api/v1/expenses", params={"page_size": 50})
    assert listed.status_code == 200
    match = next(item for item in listed.json()["items"] if item["id"] == str(expenses[0].id))
    assert match["receipt_ref"] == upload_id

    file_resp = client.get(f"/api/v1/uploads/{upload_id}/file")
    assert file_resp.status_code == 200
    assert file_resp.headers["content-type"].startswith("application/pdf")


def test_spreadsheet_still_requires_property_id(client):
    payload = _make_excel(
        [
            {
                "transaction_date": "2026-02-15",
                "amount": 10,
                "category": "other",
                "source": "manual_company",
                "payment_method": "company_account",
            }
        ]
    )
    response = client.post(
        "/api/v1/uploads/analyze",
        data={"transaction_type": "expense"},
        files={
            "file": (
                "expenses.xlsx",
                payload,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert response.status_code == 400
