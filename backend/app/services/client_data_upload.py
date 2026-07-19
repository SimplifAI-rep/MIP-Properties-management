"""Stage uploaded ClientData Excel files and run the full import pipeline."""

from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine, init_db
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import ClientDataImportCounts, ClientDataImportResponse
from app.services.client_import import (
    BANK_FILE,
    CLIENT_LIST_FILE,
    CREDIT_CARD_FILES,
    MANAGEMENT_FILE,
    build_skip_report_excel,
    import_client_data,
)
from app.services.document_storage import get_storage_root

# Canonical filenames expected by ClientDataImportService
FILE_ROLES: dict[str, str] = {
    "client_list": CLIENT_LIST_FILE,
    "management": MANAGEMENT_FILE,
    "bank": BANK_FILE,
    "credit_card_1": CREDIT_CARD_FILES[0],
    "credit_card_2": CREDIT_CARD_FILES[1],
}

REQUIRED_ROLES = ("client_list", "management")
MAX_CLIENT_DATA_BYTES = 50 * 1024 * 1024
ALLOWED_SUFFIXES = {".xlsx", ".xls"}


def expected_file_labels() -> list[str]:
    return [
        f"{role} → {filename}"
        for role, filename in FILE_ROLES.items()
    ]


def database_counts(db: Session) -> ClientDataImportCounts:
    return ClientDataImportCounts(
        owners=db.scalar(select(func.count()).select_from(Owner)) or 0,
        properties=db.scalar(select(func.count()).select_from(Property)) or 0,
        bank_accounts=db.scalar(select(func.count()).select_from(BankAccount)) or 0,
        expenses=db.scalar(select(func.count()).select_from(Expense)) or 0,
        deposits=db.scalar(select(func.count()).select_from(Deposit)) or 0,
    )


def reset_database() -> None:
    """Drop and recreate all tables (destructive)."""
    engine.dispose()
    Base.metadata.drop_all(bind=engine)
    init_db()


async def _read_excel_upload(upload: UploadFile | None, *, role: str) -> bytes | None:
    if upload is None or not upload.filename:
        return None
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"{role}: unsupported file type '{suffix}'. Use .xlsx or .xls",
        )
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"{role}: file is empty")
    if len(content) > MAX_CLIENT_DATA_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"{role}: file exceeds {MAX_CLIENT_DATA_BYTES // (1024 * 1024)} MB",
        )
    return content


async def stage_client_data_files(
    *,
    client_list: UploadFile | None,
    management: UploadFile | None,
    bank: UploadFile | None,
    credit_card_1: UploadFile | None,
    credit_card_2: UploadFile | None,
) -> tuple[Path, list[str]]:
    """Write uploads into a temp ClientData-shaped directory."""
    uploads = {
        "client_list": client_list,
        "management": management,
        "bank": bank,
        "credit_card_1": credit_card_1,
        "credit_card_2": credit_card_2,
    }

    staged: dict[str, bytes] = {}
    for role, upload in uploads.items():
        content = await _read_excel_upload(upload, role=role)
        if content is not None:
            staged[role] = content

    missing = [role for role in REQUIRED_ROLES if role not in staged]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                "Missing required files: "
                + ", ".join(f"{role} ({FILE_ROLES[role]})" for role in missing)
            ),
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="simplifai-client-data-"))
    files_used: list[str] = []
    try:
        for role, content in staged.items():
            filename = FILE_ROLES[role]
            (temp_dir / filename).write_bytes(content)
            files_used.append(filename)
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise

    return temp_dir, files_used


def run_client_data_import(
    *,
    data_dir: Path,
    files_used: list[str],
    reset: bool,
    db: Session,
) -> ClientDataImportResponse:
    work_db = db
    owns_session = False
    try:
        if reset:
            db.close()
            reset_database()
            work_db = SessionLocal()
            owns_session = True

        stats = import_client_data(work_db, data_dir=data_dir)
        counts = database_counts(work_db)

        report_id = None
        report_url = None
        if stats.skipped_rows or stats.rows_seen:
            report_id = uuid.uuid4().hex
            report_dir = get_storage_root() / "import_reports"
            report_dir.mkdir(parents=True, exist_ok=True)
            report_path = report_dir / f"{report_id}_skipped_rows.xlsx"
            report_path.write_bytes(build_skip_report_excel(stats))
            report_url = f"/api/v1/imports/client-data/reports/{report_id}"

        return ClientDataImportResponse(
            reset=reset,
            files_used=files_used,
            owners_created=stats.owners_created,
            properties_created=stats.properties_created,
            bank_accounts_created=stats.bank_accounts_created,
            expenses_created=stats.expenses_created,
            expenses_skipped=stats.expenses_skipped,
            deposits_created=stats.deposits_created,
            deposits_skipped=stats.deposits_skipped,
            rows_seen=stats.rows_seen,
            rows_skipped_empty=stats.rows_skipped_empty,
            skipped_row_count=len(stats.skipped_rows),
            skip_report_id=report_id,
            skip_report_url=report_url,
            warnings=stats.warnings[:100],
            errors=stats.errors[:100],
            database_counts=counts,
        )
    finally:
        if owns_session:
            work_db.close()


def get_skip_report_path(report_id: str) -> Path:
    safe_id = Path(report_id).name
    if safe_id != report_id or not report_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid report id")
    path = get_storage_root() / "import_reports" / f"{safe_id}_skipped_rows.xlsx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Skip report not found")
    return path
