from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import TimestampMixin, uuid_pk
from app.core.database import Base


class Deposit(Base, TimestampMixin):
    __tablename__ = "deposits"
    __table_args__ = (
        UniqueConstraint(
            "bank_account_id",
            "transaction_date",
            "amount",
            "reference",
            name="uq_deposits_idempotency",
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    bank_account_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bank_accounts.id"), nullable=False
    )
    property_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("properties.id"), nullable=False
    )
    transaction_date: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="ILS")
    reference: Mapped[str | None] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="excel_import")
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("import_batches.id")
    )

    bank_account: Mapped["BankAccount"] = relationship(back_populates="deposits")
    property: Mapped["Property"] = relationship(back_populates="deposits")
    import_batch: Mapped["ImportBatch | None"] = relationship(back_populates="deposits")
