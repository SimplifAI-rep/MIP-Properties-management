from __future__ import annotations

import uuid

from sqlalchemy import String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk

ALERT_ACTIONS = ("dismissed", "resolved")


class AlertAction(Base, TimestampMixin):
    __tablename__ = "alert_actions"
    __table_args__ = (UniqueConstraint("alert_key", name="uq_alert_actions_key"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    alert_key: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    metadata_json: Mapped[dict | None] = mapped_column(JSON)
