"""Background ClientData import jobs (avoids Render HTTP timeouts)."""

from __future__ import annotations

import copy
import json
import logging
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from app.core.database import SessionLocal
from app.services.client_data_upload import (
    run_client_data_import,
)
from app.services.document_storage import get_storage_root

logger = logging.getLogger(__name__)

_JOB_LOCK = threading.Lock()
_ACTIVE_JOB_ID: str | None = None
# In-memory job status (source of truth while the process lives).
_JOBS: dict[str, dict[str, Any]] = {}
# Tests may replace this with a sessionmaker bound to the test engine.
_session_factory: Callable[[], Any] = SessionLocal


def set_session_factory(factory: Callable[[], Any]) -> None:
    """Override DB session factory (used by tests)."""
    global _session_factory
    _session_factory = factory


def _jobs_root() -> Path:
    root = get_storage_root() / "import_jobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _job_dir(job_id: str) -> Path:
    return _jobs_root() / job_id


def _meta_path(job_id: str) -> Path:
    return _job_dir(job_id) / "meta.json"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist_meta(job_id: str, payload: dict[str, Any]) -> None:
    """Best-effort disk snapshot (polling uses in-memory state)."""
    try:
        path = _meta_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)
    except OSError:
        logger.debug("Could not persist import job meta for %s", job_id, exc_info=True)


def _load_meta_from_disk(job_id: str) -> dict[str, Any] | None:
    path = _meta_path(job_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def get_import_job(job_id: str) -> dict[str, Any] | None:
    safe = Path(job_id).name
    if safe != job_id or not job_id.isalnum():
        return None
    with _JOB_LOCK:
        cached = _JOBS.get(job_id)
        if cached is not None:
            return copy.deepcopy(cached)
    disk = _load_meta_from_disk(job_id)
    if disk is not None:
        with _JOB_LOCK:
            _JOBS[job_id] = disk
        return copy.deepcopy(disk)
    return None


def create_staged_job_dir() -> tuple[str, Path]:
    """Create a new job folder and return (job_id, files_dir)."""
    job_id = uuid.uuid4().hex
    files_dir = _job_dir(job_id) / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    return job_id, files_dir


def enqueue_client_data_import(
    *,
    job_id: str,
    files_used: list[str],
    reset: bool,
) -> dict[str, Any]:
    """Mark job queued and start a background worker thread."""
    global _ACTIVE_JOB_ID

    with _JOB_LOCK:
        if _ACTIVE_JOB_ID is not None:
            active = _JOBS.get(_ACTIVE_JOB_ID)
            if active is None:
                active = _load_meta_from_disk(_ACTIVE_JOB_ID)
            if active and active.get("status") in {"queued", "running"}:
                raise RuntimeError(
                    "Another ClientData import is already running. Wait for it to finish."
                )
        _ACTIVE_JOB_ID = job_id

        meta = {
            "job_id": job_id,
            "status": "queued",
            "message": "Queued — waiting to start",
            "error": None,
            "reset": reset,
            "files_used": files_used,
            "result": None,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
        }
        _JOBS[job_id] = meta

    _persist_meta(job_id, meta)

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, reset, files_used),
        name=f"client-data-import-{job_id[:8]}",
        daemon=True,
    )
    thread.start()
    return copy.deepcopy(meta)


def _update_job(job_id: str, **fields: Any) -> None:
    with _JOB_LOCK:
        meta = _JOBS.get(job_id) or {"job_id": job_id}
        meta = {**meta, **fields, "updated_at": _utc_now()}
        _JOBS[job_id] = meta
        snapshot = copy.deepcopy(meta)
    _persist_meta(job_id, snapshot)


def _run_job(job_id: str, reset: bool, files_used: list[str]) -> None:
    global _ACTIVE_JOB_ID
    data_dir = _job_dir(job_id) / "files"

    def progress(message: str) -> None:
        _update_job(job_id, status="running", message=message)

    try:
        _update_job(job_id, status="running", message="Starting import…")
        db = _session_factory()
        try:
            result = run_client_data_import(
                data_dir=data_dir,
                files_used=files_used,
                reset=reset,
                db=db,
                progress=progress,
            )
        finally:
            db.close()

        result_payload = (
            result.model_dump(mode="json")
            if hasattr(result, "model_dump")
            else result.dict()
        )
        _update_job(
            job_id,
            status="succeeded",
            message="Import finished",
            error=None,
            result=result_payload,
        )
    except Exception as exc:  # noqa: BLE001 — persist failure for UI
        logger.exception("ClientData import job %s failed", job_id)
        _update_job(
            job_id,
            status="failed",
            message="Import failed",
            error=str(exc),
            result=None,
        )
    finally:
        # Free disk: staged Excel files are large
        try:
            shutil.rmtree(data_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        with _JOB_LOCK:
            if _ACTIVE_JOB_ID == job_id:
                _ACTIVE_JOB_ID = None
