from __future__ import annotations

import mimetypes
import uuid
from pathlib import Path

from app.core.config import PROJECT_ROOT, get_settings

ALLOWED_EXTENSIONS = {
    ".xlsx",
    ".xls",
    ".csv",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
}

ALLOWED_MIME_TYPES = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
}


def get_storage_root() -> Path:
    settings = get_settings()
    root = Path(settings.storage_dir)
    if not root.is_absolute():
        root = PROJECT_ROOT / root
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_stored_path(stored_path: str) -> Path:
    """Resolve a relative stored_path to an absolute Path under the storage root."""
    relative = stored_path.replace("\\", "/").lstrip("/")
    path = (get_storage_root() / relative).resolve()
    root = get_storage_root().resolve()
    if root not in path.parents and path != root:
        raise ValueError("Stored path escapes storage root")
    return path


def storage_uri_for(stored_path: str) -> str:
    """Location URI for the stored file.

    Local disk today (absolute path). Swap to cloud URLs later without changing callers.
    """
    return str(resolve_stored_path(stored_path))


def upload_file_url(upload_id: uuid.UUID) -> str:
    """App-served URL to open/download the file in the browser."""
    return f"/api/v1/uploads/{upload_id}/file"


def validate_upload(filename: str, content: bytes, mime_type: str | None) -> str:
    settings = get_settings()
    if len(content) > settings.upload_max_bytes:
        raise ValueError(
            f"File exceeds maximum size of {settings.upload_max_bytes // (1024 * 1024)} MB"
        )

    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    resolved_mime = mime_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if resolved_mime not in ALLOWED_MIME_TYPES:
        raise ValueError(f"Unsupported MIME type: {resolved_mime}")

    return resolved_mime


def save_upload_file(
    *,
    filename: str,
    content: bytes,
    mime_type: str,
    property_id: uuid.UUID | None = None,
    owner_id: uuid.UUID | None = None,
) -> str:
    root = get_storage_root()
    if owner_id and property_id:
        folder = root / str(owner_id) / str(property_id)
    elif owner_id:
        folder = root / str(owner_id) / "pending"
    else:
        folder = root / "pending"
    folder.mkdir(parents=True, exist_ok=True)

    safe_name = Path(filename).name
    stored_name = f"{uuid.uuid4().hex}_{safe_name}"
    path = folder / stored_name
    path.write_bytes(content)
    return str(path.relative_to(root)).replace("\\", "/")
