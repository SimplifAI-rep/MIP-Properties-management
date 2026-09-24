from __future__ import annotations

from collections import defaultdict
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.transaction_attachment import TransactionAttachment
from app.models.uploaded_document import UploadedDocument
from app.schemas import AttachmentRead
from app.services.document_storage import save_upload_file, validate_upload
from app.services.source_file import load_upload_filenames


def _is_upload_id(value: str | None) -> bool:
    if not value:
        return False
    try:
        UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _get_row(db: Session, kind: str, tx_id: UUID) -> Deposit | Expense:
    if kind == "expense":
        row = db.get(Expense, tx_id)
    elif kind == "deposit":
        row = db.get(Deposit, tx_id)
    else:
        raise HTTPException(status_code=400, detail="kind must be deposit or expense")
    if row is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return row


def _to_read(
    attachment: TransactionAttachment,
    filename: str,
    *,
    is_legacy: bool = False,
) -> AttachmentRead:
    return AttachmentRead(
        id=str(attachment.id),
        upload_id=attachment.upload_id,
        filename=filename,
        sort=attachment.sort,
        is_legacy=is_legacy,
    )


def _legacy_read(receipt_ref: str, filename: str) -> AttachmentRead:
    return AttachmentRead(
        id=f"receipt:{receipt_ref}",
        upload_id=UUID(receipt_ref),
        filename=filename,
        sort=0,
        is_legacy=True,
    )


def _table_rows(db: Session, kind: str, tx_ids: list[UUID]) -> list[TransactionAttachment]:
    if not tx_ids:
        return []
    return list(
        db.scalars(
            select(TransactionAttachment)
            .where(
                TransactionAttachment.kind == kind,
                TransactionAttachment.transaction_id.in_(tx_ids),
            )
            .order_by(TransactionAttachment.sort, TransactionAttachment.created_at)
        ).all()
    )


def _ensure_legacy_row(db: Session, kind: str, row: Deposit | Expense) -> None:
    """Promote receipt_ref into the attachments table so new files sort after it."""
    existing = _table_rows(db, kind, [row.id])
    if existing:
        return
    receipt_ref = getattr(row, "receipt_ref", None)
    if not _is_upload_id(receipt_ref):
        return
    upload_id = UUID(str(receipt_ref))
    if db.get(UploadedDocument, upload_id) is None:
        return
    db.add(
        TransactionAttachment(
            kind=kind,
            transaction_id=row.id,
            upload_id=upload_id,
            sort=0,
        )
    )
    db.flush()


def _sync_receipt_ref(db: Session, kind: str, row: Deposit | Expense) -> None:
    first = _table_rows(db, kind, [row.id])
    row.receipt_ref = str(first[0].upload_id) if first else None


def load_attachments_map(
    db: Session,
    kind: str,
    rows: list[Deposit] | list[Expense],
) -> dict[UUID, list[AttachmentRead]]:
    ids = [row.id for row in rows]
    table = _table_rows(db, kind, ids)
    grouped: dict[UUID, list[TransactionAttachment]] = defaultdict(list)
    upload_ids: list[str | None] = []
    for item in table:
        grouped[item.transaction_id].append(item)
        upload_ids.append(str(item.upload_id))
    for row in rows:
        if row.id not in grouped and _is_upload_id(getattr(row, "receipt_ref", None)):
            upload_ids.append(row.receipt_ref)
    names = load_upload_filenames(db, upload_ids)

    result: dict[UUID, list[AttachmentRead]] = {}
    for row in rows:
        stored = grouped.get(row.id)
        if stored:
            result[row.id] = [
                _to_read(item, names.get(str(item.upload_id), "File")) for item in stored
            ]
            continue
        receipt_ref = getattr(row, "receipt_ref", None)
        if _is_upload_id(receipt_ref):
            result[row.id] = [
                _legacy_read(str(receipt_ref), names.get(str(receipt_ref), "File"))
            ]
        else:
            result[row.id] = []
    return result


def apply_attachments(
    db: Session,
    kind: str,
    reads: list,
    rows: list[Deposit] | list[Expense],
) -> None:
    mapped = load_attachments_map(db, kind, rows)
    by_id = {row.id: row for row in rows}
    for read in reads:
        source = by_id.get(read.id)
        read.attachments = mapped.get(read.id, []) if source else []


def list_attachments(db: Session, kind: str, tx_id: UUID) -> list[AttachmentRead]:
    row = _get_row(db, kind, tx_id)
    return load_attachments_map(db, kind, [row]).get(row.id, [])


def add_attachment(
    db: Session,
    kind: str,
    tx_id: UUID,
    *,
    filename: str,
    content: bytes,
    content_type: str | None,
) -> list[AttachmentRead]:
    row = _get_row(db, kind, tx_id)
    try:
        mime_type = validate_upload(filename, content, content_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stored_path = save_upload_file(
        filename=filename,
        content=content,
        mime_type=mime_type,
        property_id=row.property_id,
    )
    document = UploadedDocument(
        property_id=row.property_id,
        owner_id=None,
        filename=filename,
        stored_path=stored_path,
        mime_type=mime_type,
        transaction_type=kind,
        status="attached",
    )
    db.add(document)
    db.flush()

    _ensure_legacy_row(db, kind, row)
    existing = _table_rows(db, kind, [row.id])
    next_sort = (existing[-1].sort + 1) if existing else 0
    db.add(
        TransactionAttachment(
            kind=kind,
            transaction_id=row.id,
            upload_id=document.id,
            sort=next_sort,
        )
    )
    db.flush()
    _sync_receipt_ref(db, kind, row)
    db.commit()
    db.refresh(row)
    return list_attachments(db, kind, tx_id)


def remove_attachment(
    db: Session,
    kind: str,
    tx_id: UUID,
    attachment_id: str,
) -> list[AttachmentRead]:
    row = _get_row(db, kind, tx_id)
    if attachment_id.startswith("receipt:"):
        receipt_ref = attachment_id.removeprefix("receipt:")
        if row.receipt_ref != receipt_ref:
            raise HTTPException(status_code=404, detail="Attachment not found")
        row.receipt_ref = None
        db.commit()
        return []

    try:
        uid = UUID(attachment_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Attachment not found") from exc
    attachment = db.get(TransactionAttachment, uid)
    if (
        attachment is None
        or attachment.kind != kind
        or attachment.transaction_id != tx_id
    ):
        raise HTTPException(status_code=404, detail="Attachment not found")
    db.delete(attachment)
    db.flush()
    _sync_receipt_ref(db, kind, row)
    db.commit()
    return list_attachments(db, kind, tx_id)
