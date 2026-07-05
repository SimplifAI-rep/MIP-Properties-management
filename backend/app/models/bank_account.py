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
    property_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("properties.id"), nullable=False
    )
    bank_name: Mapped[str] = mapped_column(String(255), nullable=False)
    account_number: Mapped[str] = mapped_column(String(50), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="ILS")

    property: Mapped["Property"] = relationship(back_populates="bank_accounts")
    deposits: Mapped[list["Deposit"]] = relationship(back_populates="bank_account")
