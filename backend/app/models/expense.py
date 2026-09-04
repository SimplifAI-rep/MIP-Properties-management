from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
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
        UniqueConstraint("transaction_ref", name="uq_expenses_transaction_ref"),
        Index("ix_expenses_property_date", "property_id", "transaction_date"),
        Index("ix_expenses_date", "transaction_date"),
        Index("ix_expenses_category", "category"),
        Index("ix_expenses_source", "source"),
        Index("ix_expenses_source_file", "source_file"),
        Index("ix_expenses_needs_review_created", "needs_review", "created_at"),
        Index(
            "ix_expenses_property_flags_date",
            "property_id",
            "paid_by_resident",
            "paid_by_owner",
            "transaction_date",
        ),
        Index("ix_expenses_ledger_column", "ledger_column"),
        Index("ix_expenses_transaction_ref", "transaction_ref"),
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
    # SimplifAI unique readable id (date-based), e.g. 20260708-0042
    transaction_ref: Mapped[str | None] = mapped_column(String(40))
    # Bank reconcile (do not overload ledger `reconciled`)
    bank_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    bank_asmachta: Mapped[str | None] = mapped_column(String(100))
    bank_reconcile_exclude: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    # Credit-card reconcile (Stage A — merchant verify against CC Excel)
    cc_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Which company card this expense belongs to (from statement last4)
    card_last4: Mapped[str | None] = mapped_column(String(8))
    # Stage C — bank settlement confirmed this merchant as part of a group
    cc_bank_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cc_settlement_group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("cc_settlement_groups.id"), nullable=True
    )

    property: Mapped["Property"] = relationship(back_populates="expenses")
