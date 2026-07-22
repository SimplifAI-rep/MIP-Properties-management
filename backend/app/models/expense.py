from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk

# Preferred vocabulary — free-text client categories/methods are also allowed.
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
    "management_ledger",
    "bank_statement",
)

PAYMENT_METHODS = (
    "bank_direct_debit",
    "credit_card",
    "bank_transfer",
    "owner_personal",
    "company_account",
    "cash",
)


class Expense(Base, TimestampMixin):
    __tablename__ = "expenses"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_expenses_amount_non_negative"),
        UniqueConstraint("import_key", name="uq_expenses_import_key"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    property_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("properties.id"), nullable=False
    )
    # Nullable when imported incomplete (missing Excel date) — needs_review=True
    transaction_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # 0 allowed for incomplete rows missing Amount
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="ILS")
    # Free-text allowed (client Section values); preferred enums above for UI filters
    category: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[str] = mapped_column(String(50), nullable=False)
    payment_method: Mapped[str] = mapped_column(String(50), nullable=False)
    vendor_name: Mapped[str | None] = mapped_column(String(255))
    reference: Mapped[str | None] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    receipt_ref: Mapped[str | None] = mapped_column(String(100))
    reconciled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # True when Excel "He/She paid" — resident paid directly (not company float)
    paid_by_resident: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # True when Excel "MIP" — paid by the company (shown with badge; counts in company totals)
    paid_by_company: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # True when Excel owner-paid column (e.g. "אהרון שילם") — owner paid personally
    paid_by_owner: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Special ledger money column for UI badge: nearly_cc | cash | other (null = Amount/etc.)
    ledger_column: Mapped[str | None] = mapped_column(String(50))
    import_key: Mapped[str | None] = mapped_column(String(255))
    # Original upload/import filename (Excel workbook, PDF receipt, etc.)
    source_file: Mapped[str | None] = mapped_column(String(255))
    # Incomplete Excel import (missing date and/or money) awaiting user fix
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    review_reasons: Mapped[str | None] = mapped_column(String(255))

    property: Mapped["Property"] = relationship(back_populates="expenses")
