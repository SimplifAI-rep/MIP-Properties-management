from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import TimestampMixin, uuid_pk
from app.core.database import Base


class Property(Base, TimestampMixin):
    __tablename__ = "properties"

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("owners.id"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")

    owner: Mapped["Owner"] = relationship(back_populates="properties")
    bank_accounts: Mapped[list["BankAccount"]] = relationship(
        back_populates="property"
    )
    expected_deposits: Mapped[list["ExpectedDeposit"]] = relationship(
        back_populates="property"
    )
    deposits: Mapped[list["Deposit"]] = relationship(back_populates="property")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="property")
