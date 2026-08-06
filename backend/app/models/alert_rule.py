from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin, uuid_pk


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AlertRule(Base, TimestampMixin):
    """Configurable alert rules (admin). v1: low_balance global + per-property."""

    __tablename__ = "alert_rules"
    __table_args__ = (
        UniqueConstraint(
            "rule_type",
            "scope_type",
            "property_id",
            name="uq_alert_rules_type_scope_property",
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    rule_type: Mapped[str] = mapped_column(String(50), nullable=False, default="low_balance")
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="warning")
    scope_type: Mapped[str] = mapped_column(String(20), nullable=False)  # global | property
    property_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("properties.id"),
        nullable=True,
    )
    threshold_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="ILS")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utc_now,
        onupdate=_utc_now,
        server_default=func.now(),
        nullable=False,
    )

    property: Mapped["Property | None"] = relationship("Property")
