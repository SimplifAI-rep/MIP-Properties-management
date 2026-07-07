from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.property import Property
from app.schemas import UploadAnalyzeResponse, UploadConfirmRequest, UploadConfirmResponse
from app.services.document_import import DocumentImportService
from app.services.document_storage import save_upload_file, validate_upload

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/analyze", response_model=UploadAnalyzeResponse)
async def analyze_upload(
    file: UploadFile = File(...),
    property_id: UUID = Form(...),
    transaction_type: str = Form(...),
    db: Session = Depends(get_db),
) -> UploadAnalyzeResponse:
    if transaction_type not in {"deposit", "expense"}:
        raise HTTPException(status_code=400, detail="transaction_type must be deposit or expense")

    content = await file.read()
    filename = file.filename or "upload"

    try:
        mime_type = validate_upload(filename, content, file.content_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    property_row = db.get(Property, property_id)
    if not property_row:
        raise HTTPException(status_code=404, detail="Property not found")

    stored_path = save_upload_file(
        property_id=property_id,
        owner_id=property_row.owner_id,
        filename=filename,
        content=content,
        mime_type=mime_type,
    )

    service = DocumentImportService(db)
    document = service.create_upload(
        property_id=property_id,
        transaction_type=transaction_type,  # type: ignore[arg-type]
        filename=filename,
        stored_path=stored_path,
        mime_type=mime_type,
    )
    return service.analyze(document, content)


@router.post("/{upload_id}/confirm", response_model=UploadConfirmResponse)
def confirm_upload(
    upload_id: UUID,
    payload: UploadConfirmRequest,
    db: Session = Depends(get_db),
) -> UploadConfirmResponse:
    service = DocumentImportService(db)
    return service.confirm(upload_id, payload)
