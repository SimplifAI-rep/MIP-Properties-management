from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, Integer, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class CompanyBankSettings(Base, TimestampMixin):
    """Singleton-style company operating-account reconcile settings (one row expected)."""

    __tablename__ = "company_bank_settings"

    id: Mapped[uuid.UUID] = uuid_pk()
    opening_balance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    opening_balance_as_of: Mapped[date | None] = mapped_column(Date)
    last_verification_date: Mapped[date | None] = mapped_column(Date)
    # Admin-editable Gap ≈ 0 threshold (ILS); default 0.01
    gap_tolerance_amount: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0.01")
    )
    # Ensures at most one logical settings row for v1 (app enforces single row)
    singleton_key: Mapped[int] = mapped_column(
        Integer, nullable=False, unique=True, default=1
    )
