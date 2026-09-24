from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.core.database import Base
from app.main import app
from app.models.expense import Expense
from app.models.uploaded_document import UploadedDocument
from app.services.seed import PROPERTY_ROTHSCHILD_ID, seed_reference_data
from app.services.transaction_ref import register_transaction_ref_listeners

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00"
    b"\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
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
    app.dependency_overrides[require_admin] = lambda: "test-admin"
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _create_expense(client):
    response = client.post(
        "/api/v1/expenses",
        json={
            "property_id": str(PROPERTY_ROTHSCHILD_ID),
            "transaction_date": "2026-07-10",
            "amount": "25.00",
            "category": "maintenance",
            "source": "manual_company",
            "payment_method": "company_account",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_attach_list_and_remove_files(client, db):
    expense = _create_expense(client)
    first = client.post(
        f"/api/v1/expenses/{expense['id']}/attachments",
        files={"file": ("receipt.png", PNG, "image/png")},
    )
    assert first.status_code == 200, first.text
    assert len(first.json()) == 1
    first_upload = first.json()[0]["upload_id"]

    second = client.post(
        f"/api/v1/expenses/{expense['id']}/attachments",
        files={"file": ("invoice.png", PNG, "image/png")},
    )
    assert second.status_code == 200, second.text
    files = second.json()
    assert len(files) == 2
    assert [row["filename"] for row in files] == ["receipt.png", "invoice.png"]

    listed = client.get(f"/api/v1/expenses/{expense['id']}/attachments").json()
    assert len(listed) == 2

    row = db.get(Expense, UUID(expense["id"]))
    assert row is not None
    assert row.receipt_ref == first_upload

    preview = client.get(f"/api/v1/uploads/{first_upload}/file")
    assert preview.status_code == 200
    assert preview.content[:8] == b"\x89PNG\r\n\x1a\n"

    remaining = client.delete(
        f"/api/v1/expenses/{expense['id']}/attachments/{listed[0]['id']}"
    )
    assert remaining.status_code == 200
    assert len(remaining.json()) == 1
    db.expire_all()
    row = db.get(Expense, UUID(expense["id"]))
    assert row.receipt_ref == remaining.json()[0]["upload_id"]


def test_legacy_receipt_ref_is_first_file(client, db):
    expense = _create_expense(client)
    document = UploadedDocument(
        property_id=PROPERTY_ROTHSCHILD_ID,
        filename="old-receipt.png",
        stored_path="pending/old-receipt.png",
        mime_type="image/png",
        transaction_type="expense",
        status="attached",
    )
    db.add(document)
    db.flush()
    row = db.get(Expense, UUID(expense["id"]))
    row.receipt_ref = str(document.id)
    db.commit()

    listed = client.get(f"/api/v1/expenses/{expense['id']}/attachments").json()
    assert len(listed) == 1
    assert listed[0]["is_legacy"] is True
    assert listed[0]["upload_id"] == str(document.id)

    added = client.post(
        f"/api/v1/expenses/{expense['id']}/attachments",
        files={"file": ("new.png", PNG, "image/png")},
    )
    assert added.status_code == 200, added.text
    files = added.json()
    assert len(files) == 2
    assert files[0]["upload_id"] == str(document.id)
    assert files[0]["is_legacy"] is False
    assert files[1]["filename"] == "new.png"


def test_frontend_files_surface_exists():
    from pathlib import Path

    frontend = Path(__file__).resolve().parents[2] / "frontend" / "src"
    tx_page = (frontend / "pages" / "TransactionsPage.tsx").read_text(encoding="utf-8")
    table = (frontend / "components" / "TransactionTable.tsx").read_text(encoding="utf-8")
    bank = (frontend / "components" / "BankReconcilePanel.tsx").read_text(encoding="utf-8")
    field = (frontend / "components" / "ui" / "TransactionAttachmentsField.tsx").read_text(
        encoding="utf-8"
    )
    assert "TransactionAttachmentsField" in tx_page
    assert "Add files" in field
    assert "Files" in table
    assert "TransactionAttachmentsField" in bank
