from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk

EXPENSE_CATEGORIES = (
    "maintenance",
    "tax",
    "insurance",
    "utilities",
    "management_fee",
    "other",
)

EXPENSE_SOURCES = (
    "standing_order",
    "credit_card",
    "manual_owner",
    "manual_company",
)

PAYMENT_METHODS = (
    "bank_direct_debit",
    "credit_card",
    "bank_transfer",
    "owner_personal",
    "company_account",
)


class Expense(Base, TimestampMixin):
    __tablename__ = "expenses"
    __table_args__ = (CheckConstraint("amount > 0", name="ck_expenses_amount_positive"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("properties.id"), nullable=False
    )
    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="ILS")
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    payment_method: Mapped[str] = mapped_column(String(50), nullable=False)
    vendor_name: Mapped[str | None] = mapped_column(String(255))
    reference: Mapped[str | None] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)

    property: Mapped["Property"] = relationship(back_populates="expenses")
