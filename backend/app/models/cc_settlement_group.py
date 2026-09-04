from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class CcSettlementGroup(Base, TimestampMixin):
    """Bank CC settlement debit linked to a date-window of CC-verified merchants."""

    __tablename__ = "cc_settlement_groups"

    id: Mapped[uuid.UUID] = uuid_pk()
    settlement_date: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    bank_asmachta: Mapped[str | None] = mapped_column(String(100))
    bank_fingerprint: Mapped[str | None] = mapped_column(String(255))
    bank_description: Mapped[str | None] = mapped_column(Text)
    window_start: Mapped[date | None] = mapped_column(Date)
    window_end: Mapped[date | None] = mapped_column(Date)
    member_total: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    # Snapshot of member expense ids at confirm time
    member_expense_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="confirmed")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
