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


def load_batch_filenames(db: Session, batch_ids: list[UUID | None]) -> dict[str, str]:
    ids = [batch_id for batch_id in batch_ids if batch_id is not None]
    if not ids:
        return {}
    rows = db.execute(
        select(ImportBatch.id, ImportBatch.filename).where(ImportBatch.id.in_(ids))
    ).all()
    return {str(batch_id): filename for batch_id, filename in rows}


_ORIGIN_LABELS = {
    "management_ledger": "Management expenses sheet.xlsx",
    "rental_income": "Management expenses sheet.xlsx",
    "bank_statement": "Bank Account example.xlsx",
    "credit_card": "credit card statement.xlsx",
    "excel_import": "Excel import",
    "file_upload": "Uploaded file",
}


def resolve_source_file(
    *,
    source_file: str | None,
    receipt_ref: str | None = None,
    import_batch_id: UUID | None = None,
    source: str | None = None,
    upload_names: dict[str, str] | None = None,
    batch_names: dict[str, str] | None = None,
) -> str | None:
    """Return the import/verification filename that created the row.

    Receipts and later attachments are supporting files, not the origin.
    A receipt filename is used only for older file-upload rows that never
    stored source_file.
    """
    if source_file:
        return source_file
    if import_batch_id and batch_names:
        name = batch_names.get(str(import_batch_id))
        if name:
            return name
    if source == "file_upload" and receipt_ref and upload_names:
        name = upload_names.get(str(receipt_ref))
        if name:
            return name
    if source in _ORIGIN_LABELS:
        return _ORIGIN_LABELS.get(source)
    return None
