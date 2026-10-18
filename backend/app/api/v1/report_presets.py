from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.models.report_preset import ReportPreset
from app.schemas import (
    ReportFilterSet,
    ReportPresetCreate,
    ReportPresetRead,
    ReportPresetUpdate,
)

router = APIRouter(prefix="/report-presets", tags=["report-presets"])


def _to_read(row: ReportPreset) -> ReportPresetRead:
    return ReportPresetRead(
        id=row.id,
        name=row.name,
        filters=ReportFilterSet.model_validate(row.filters_json or {}),
        created_at=row.created_at,
        updated_at=getattr(row, "updated_at", None),
    )


def _clean_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Report name is required.")
    if len(cleaned) > 255:
        raise HTTPException(status_code=400, detail="Report name is too long.")
    return cleaned


def _clean_filters(filters: ReportFilterSet) -> dict:
    try:
        return filters.validated().model_dump()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _name_taken(db: Session, name: str, exclude_id: UUID | None = None) -> bool:
    stmt = select(ReportPreset.id).where(func.lower(ReportPreset.name) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(ReportPreset.id != exclude_id)
    return db.scalar(stmt) is not None


@router.get("", response_model=list[ReportPresetRead])
def list_report_presets(db: Session = Depends(get_db)) -> list[ReportPresetRead]:
    rows = db.scalars(select(ReportPreset).order_by(ReportPreset.name.asc())).all()
    return [_to_read(row) for row in rows]


@router.post("", response_model=ReportPresetRead, status_code=201)
def create_report_preset(
    payload: ReportPresetCreate,
    db: Session = Depends(get_db),
) -> ReportPresetRead:
    name = _clean_name(payload.name)
    if _name_taken(db, name):
        raise HTTPException(
            status_code=409,
            detail="A report with this name already exists.",
        )
    row = ReportPreset(name=name, filters_json=_clean_filters(payload.filters))
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_read(row)


@router.patch("/{preset_id}", response_model=ReportPresetRead)
def update_report_preset(
    preset_id: UUID,
    payload: ReportPresetUpdate,
    db: Session = Depends(get_db),
) -> ReportPresetRead:
    row = db.get(ReportPreset, preset_id)
    if not row:
        raise HTTPException(status_code=404, detail="Report not found.")
    if payload.name is not None:
        name = _clean_name(payload.name)
        if _name_taken(db, name, exclude_id=preset_id):
            raise HTTPException(
                status_code=409,
                detail="A report with this name already exists.",
            )
        row.name = name
    if payload.filters is not None:
        row.filters_json = _clean_filters(payload.filters)
    db.commit()
    db.refresh(row)
    return _to_read(row)


@router.delete("/{preset_id}", status_code=204)
def delete_report_preset(
    preset_id: UUID,
    db: Session = Depends(get_db),
) -> None:
    row = db.get(ReportPreset, preset_id)
    if not row:
        raise HTTPException(status_code=404, detail="Report not found.")
    db.delete(row)
    db.commit()
