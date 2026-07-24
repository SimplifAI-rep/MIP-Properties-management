from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


class UploadedDocument(Base, TimestampMixin):
    __tablename__ = "uploaded_documents"

    id: Mapped[uuid.UUID] = uuid_pk()
    # Nullable until document analysis matches (or user confirms) a property/client.
    property_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("properties.id"), nullable=True
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("owners.id"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    transaction_type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending_review")
    parser: Mapped[str | None] = mapped_column(String(50))
    extraction_json: Mapped[dict | None] = mapped_column(JSON)
    confirmed_json: Mapped[dict | None] = mapped_column(JSON)

    property: Mapped["Property"] = relationship()
    owner: Mapped["Owner"] = relationship()
