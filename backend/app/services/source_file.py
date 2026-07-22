"""Resolve original source filenames for transactions."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.import_batch import ImportBatch
from app.models.uploaded_document import UploadedDocument


def _as_uuid(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def load_upload_filenames(db: Session, receipt_refs: list[str | None]) -> dict[str, str]:
    """Map receipt_ref (upload id) -> original filename."""
    ids: list[UUID] = []
    for ref in receipt_refs:
        uid = _as_uuid(ref)
        if uid is not None:
            ids.append(uid)
    if not ids:
        return {}
    rows = db.execute(
        select(UploadedDocument.id, UploadedDocument.filename).where(
            UploadedDocument.id.in_(ids)
        )
    ).all()
    return {str(doc_id): filename for doc_id, filename in rows}


def load_upload_locations(
    db: Session, receipt_refs: list[str | None]
) -> dict[str, tuple[str, str | None]]:
    """Map receipt_ref -> (file_url, storage_uri)."""
    from app.services.document_storage import storage_uri_for, upload_file_url

    ids: list[UUID] = []
    for ref in receipt_refs:
        uid = _as_uuid(ref)
        if uid is not None:
            ids.append(uid)
    if not ids:
        return {}
    rows = db.execute(
        select(UploadedDocument.id, UploadedDocument.stored_path).where(
            UploadedDocument.id.in_(ids)
        )
    ).all()
    result: dict[str, tuple[str, str | None]] = {}
    for doc_id, stored_path in rows:
        uri: str | None = None
        try:
            uri = storage_uri_for(stored_path)
        except (OSError, ValueError):
            uri = None
        result[str(doc_id)] = (upload_file_url(doc_id), uri)
    return result


def load_batch_filenames(db: Session, batch_ids: list[UUID | None]) -> dict[str, str]:
    ids = [batch_id for batch_id in batch_ids if batch_id is not None]
    if not ids:
        return {}
    rows = db.execute(
        select(ImportBatch.id, ImportBatch.filename).where(ImportBatch.id.in_(ids))
    ).all()
    return {str(batch_id): filename for batch_id, filename in rows}


def resolve_source_file(
    *,
    source_file: str | None,
    receipt_ref: str | None = None,
    import_batch_id: UUID | None = None,
    source: str | None = None,
    upload_names: dict[str, str] | None = None,
    batch_names: dict[str, str] | None = None,
) -> str | None:
    """Prefer stored source_file, then upload/batch lookup, then source label."""
    if source_file:
        return source_file
    if receipt_ref and upload_names:
        name = upload_names.get(str(receipt_ref))
        if name:
            return name
    if import_batch_id and batch_names:
        name = batch_names.get(str(import_batch_id))
        if name:
            return name
    if source in {
        "management_ledger",
        "rental_income",
        "bank_statement",
        "credit_card",
        "excel_import",
        "file_upload",
    }:
        # Fallback label when filename was not stored (older rows)
        labels = {
            "management_ledger": "Management expenses sheet.xlsx",
            "rental_income": "Management expenses sheet.xlsx",
            "bank_statement": "Bank Account example.xlsx",
            "credit_card": "credit card statement.xlsx",
            "excel_import": "Excel import",
            "file_upload": "Uploaded file",
        }
        return labels.get(source)
    return None
