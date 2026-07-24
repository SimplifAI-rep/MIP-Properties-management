from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.property import Property
from app.models.uploaded_document import UploadedDocument
from app.schemas import UploadAnalyzeResponse, UploadConfirmRequest, UploadConfirmResponse
from app.services.document_import import DocumentImportService
from app.services.document_storage import get_storage_root, save_upload_file, validate_upload

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/analyze", response_model=UploadAnalyzeResponse)
async def analyze_upload(
    file: UploadFile = File(...),
    property_id: UUID | None = Form(None),
    transaction_type: str | None = Form(None),
    upload_kind: str | None = Form(None),
    db: Session = Depends(get_db),
) -> UploadAnalyzeResponse:
    """Analyze an uploaded spreadsheet, image, or PDF.

    ``upload_kind``: receipt (default), bank_statement, credit_card, or auto.
    Bank/credit-card Excel does not require property_id or transaction_type.
    For generic Excel/CSV, ``property_id`` and ``transaction_type`` are required.
    For images/PDFs they are optional — the system auto-detects type and
    matches the client/property from document contents when possible.
    """
    if transaction_type is not None and transaction_type not in {"deposit", "expense", "auto"}:
        raise HTTPException(
            status_code=400,
            detail="transaction_type must be deposit, expense, or auto",
        )
    if upload_kind is not None and upload_kind not in {
        "receipt",
        "bank_statement",
        "credit_card",
        "auto",
    }:
        raise HTTPException(
            status_code=400,
            detail="upload_kind must be receipt, bank_statement, credit_card, or auto",
        )

    content = await file.read()
    filename = file.filename or "upload"

    try:
        mime_type = validate_upload(filename, content, file.content_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    suffix = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    is_spreadsheet = suffix in {"xlsx", "xls", "csv"}
    resolved_kind = upload_kind or "receipt"

    if is_spreadsheet and resolved_kind == "auto":
        from app.services.statement_import import detect_statement_kind

        detected = detect_statement_kind(content)
        resolved_kind = detected or "receipt"

    is_statement = resolved_kind in {"bank_statement", "credit_card"}

    if is_spreadsheet and not is_statement:
        if property_id is None:
            raise HTTPException(
                status_code=400,
                detail="property_id is required for Excel/CSV uploads",
            )
        if transaction_type in (None, "auto"):
            raise HTTPException(
                status_code=400,
                detail="transaction_type (deposit or expense) is required for Excel/CSV uploads",
            )

    owner_id = None
    if property_id is not None:
        property_row = db.get(Property, property_id)
        if not property_row:
            raise HTTPException(status_code=404, detail="Property not found")
        owner_id = property_row.owner_id

    resolved_type = "expense" if transaction_type in (None, "auto") else transaction_type

    stored_path = save_upload_file(
        property_id=property_id,
        owner_id=owner_id,
        filename=filename,
        content=content,
        mime_type=mime_type,
    )

    service = DocumentImportService(db)
    document = service.create_upload(
        property_id=property_id,
        owner_id=owner_id,
        transaction_type=resolved_type,  # type: ignore[arg-type]
        filename=filename,
        stored_path=stored_path,
        mime_type=mime_type,
        auto_detect_type=transaction_type in (None, "auto"),
    )
    return service.analyze(
        document,
        content,
        auto_detect_type=transaction_type in (None, "auto"),
        upload_kind=resolved_kind if is_statement else None,
    )


@router.get("/{upload_id}/file")
def get_upload_file(
    upload_id: UUID,
    download: bool = False,
    db: Session = Depends(get_db),
) -> FileResponse:
    document = db.get(UploadedDocument, upload_id)
    if not document:
        raise HTTPException(status_code=404, detail="Upload not found")

    path = get_storage_root() / document.stored_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Stored file not found")

    return FileResponse(
        path,
        media_type=document.mime_type or "application/octet-stream",
        filename=document.filename,
        content_disposition_type="attachment" if download else "inline",
    )


@router.post("/{upload_id}/confirm", response_model=UploadConfirmResponse)
def confirm_upload(
    upload_id: UUID,
    payload: UploadConfirmRequest,
    db: Session = Depends(get_db),
) -> UploadConfirmResponse:
    service = DocumentImportService(db)
    return service.confirm(upload_id, payload)
