from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import ImportResultRead
from app.services.bank_import import BankImportService

router = APIRouter(prefix="/imports", tags=["imports"])


@router.post("/deposits", response_model=ImportResultRead)
async def import_deposits(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> ImportResultRead:
    content = await file.read()
    service = BankImportService(db)
    result = service.import_deposits(content, filename=file.filename or "upload.xlsx")
    return ImportResultRead(
        filename=result.filename,
        row_count=result.row_count,
        imported_count=result.imported_count,
        skipped_count=result.skipped_count,
        error_count=result.error_count,
        errors=[e.to_dict() for e in result.errors],
        import_batch_id=str(result.import_batch_id) if result.import_batch_id else None,
    )
