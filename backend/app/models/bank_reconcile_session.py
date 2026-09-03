from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class BankReconcileSession(Base, TimestampMixin):
    __tablename__ = "bank_reconcile_sessions"

    id: Mapped[uuid.UUID] = uuid_pk()
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="in_progress")
    filename: Mapped[str | None] = mapped_column(String(255))
    bank_account_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("bank_accounts.id"), nullable=True
    )
    bank_balance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    statement_start_date: Mapped[date | None] = mapped_column(Date)
    statement_end_date: Mapped[date | None] = mapped_column(Date)
    opening_balance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    after_date: Mapped[date | None] = mapped_column(Date)
    gap_tolerance_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    # Bank lines with match/ignore state
    lines_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # Unmatched app rows in scope with optional ignore
    unmatched_app_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
