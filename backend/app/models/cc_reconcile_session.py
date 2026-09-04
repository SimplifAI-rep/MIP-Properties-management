from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import Date, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class CcReconcileSession(Base, TimestampMixin):
    __tablename__ = "cc_reconcile_sessions"

    id: Mapped[uuid.UUID] = uuid_pk()
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="in_progress")
    filename: Mapped[str | None] = mapped_column(String(255))
    card_last4: Mapped[str | None] = mapped_column(String(8))
    statement_start_date: Mapped[date | None] = mapped_column(Date)
    statement_end_date: Mapped[date | None] = mapped_column(Date)
    lines_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    unmatched_app_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
