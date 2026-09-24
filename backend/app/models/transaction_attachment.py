from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class TransactionAttachment(Base, TimestampMixin):
    __tablename__ = "transaction_attachments"
    __table_args__ = (
        UniqueConstraint(
            "kind", "transaction_id", "upload_id", name="uq_tx_attachment_upload"
        ),
        Index("ix_tx_attachments_tx", "kind", "transaction_id", "sort"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    transaction_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    upload_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("uploaded_documents.id"), nullable=False
    )
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
