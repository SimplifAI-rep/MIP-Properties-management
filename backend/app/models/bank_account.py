from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import TimestampMixin, uuid_pk
from app.core.database import Base


class BankAccount(Base, TimestampMixin):
    __tablename__ = "bank_accounts"
    __table_args__ = (UniqueConstraint("account_number", name="uq_bank_accounts_account_number"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    # Nullable for company-level operating accounts shared across properties
    property_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("properties.id"), nullable=True
    )
    bank_name: Mapped[str] = mapped_column(String(255), nullable=False)
    account_number: Mapped[str] = mapped_column(String(50), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="ILS")
    label: Mapped[str | None] = mapped_column(String(100))

    property: Mapped["Property | None"] = relationship(back_populates="bank_accounts")
    deposits: Mapped[list["Deposit"]] = relationship(back_populates="bank_account")
