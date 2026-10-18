from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, String, UniqueConstraint, func
from sqlalchemy.dialects.sqlite import JSON as SQLiteJSON
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ReportPreset(Base, TimestampMixin):
    """Named filter snapshot used to generate an owner-facing transaction report."""

    __tablename__ = "report_presets"
    __table_args__ = (UniqueConstraint("name", name="uq_report_presets_name"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    filters_json: Mapped[dict] = mapped_column(
        JSON().with_variant(SQLiteJSON, "sqlite"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utc_now,
        onupdate=_utc_now,
        server_default=func.now(),
        nullable=False,
    )
