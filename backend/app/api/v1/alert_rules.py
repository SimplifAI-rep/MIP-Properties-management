from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.models.alert_rule import AlertRule
from app.models.property import Property
from app.schemas import AlertRuleCreate, AlertRuleRead, AlertRuleUpdate

router = APIRouter(prefix="/alert-rules", tags=["alert-rules"])


def _zero() -> Decimal:
    return Decimal("0.00")


def _rule_to_read(rule: AlertRule, prop: Property | None = None) -> AlertRuleRead:
    property_name = None
    client_prop_id = None
    if prop is not None:
        property_name = prop.name
        client_prop_id = prop.client_prop_id
    elif rule.property_id and getattr(rule, "property", None) is not None:
        property_name = rule.property.name
        client_prop_id = rule.property.client_prop_id

    return AlertRuleRead(
        id=rule.id,
        rule_type=rule.rule_type,  # type: ignore[arg-type]
        name=rule.name,
        enabled=rule.enabled,
        severity=rule.severity,  # type: ignore[arg-type]
        scope_type=rule.scope_type,  # type: ignore[arg-type]
        property_id=rule.property_id,
        property_name=property_name,
        client_prop_id=client_prop_id,
        threshold_amount=rule.threshold_amount,
        currency=rule.currency,
        created_at=rule.created_at,
        updated_at=getattr(rule, "updated_at", None),
    )


def _validate_create(db: Session, payload: AlertRuleCreate) -> None:
    if payload.scope_type == "global":
        if payload.property_id is not None:
            raise HTTPException(
                status_code=400,
                detail="Global rules must not include a property_id.",
            )
        existing = db.scalar(
            select(AlertRule).where(
                AlertRule.rule_type == payload.rule_type,
                AlertRule.scope_type == "global",
            )
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail="A global low-balance rule already exists. Edit it instead.",
            )
        return

    if payload.scope_type == "property":
        if payload.property_id is None:
            raise HTTPException(
                status_code=400,
                detail="Property rules require a property_id.",
            )
        prop = db.get(Property, payload.property_id)
        if not prop:
            raise HTTPException(status_code=404, detail="Property not found.")
        existing = db.scalar(
            select(AlertRule).where(
                AlertRule.rule_type == payload.rule_type,
                AlertRule.scope_type == "property",
                AlertRule.property_id == payload.property_id,
            )
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail="A low-balance override already exists for this property.",
            )


@router.get("", response_model=list[AlertRuleRead])
def list_alert_rules(
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> list[AlertRuleRead]:
    rows = db.scalars(
        select(AlertRule)
        .options(joinedload(AlertRule.property))
        .order_by(AlertRule.scope_type.asc(), AlertRule.name.asc())
    ).unique().all()
    return [_rule_to_read(rule) for rule in rows]


@router.post("", response_model=AlertRuleRead, status_code=201)
def create_alert_rule(
    payload: AlertRuleCreate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> AlertRuleRead:
    _validate_create(db, payload)
    prop = db.get(Property, payload.property_id) if payload.property_id else None
    rule = AlertRule(
        rule_type=payload.rule_type,
        name=payload.name.strip(),
        enabled=payload.enabled,
        severity=payload.severity,
        scope_type=payload.scope_type,
        property_id=payload.property_id,
        threshold_amount=payload.threshold_amount.quantize(_zero()),
        currency=(payload.currency or "ILS").strip() or "ILS",
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return _rule_to_read(rule, prop)


@router.patch("/{rule_id}", response_model=AlertRuleRead)
def update_alert_rule(
    rule_id: UUID,
    payload: AlertRuleUpdate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> AlertRuleRead:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found.")

    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        rule.name = data["name"].strip()
    if "enabled" in data and data["enabled"] is not None:
        rule.enabled = data["enabled"]
    if "severity" in data and data["severity"] is not None:
        rule.severity = data["severity"]
    if "threshold_amount" in data and data["threshold_amount"] is not None:
        rule.threshold_amount = data["threshold_amount"].quantize(_zero())
    if "currency" in data and data["currency"] is not None:
        rule.currency = data["currency"].strip() or "ILS"

    db.commit()
    db.refresh(rule)
    prop = db.get(Property, rule.property_id) if rule.property_id else None
    return _rule_to_read(rule, prop)


@router.delete("/{rule_id}", status_code=204)
def delete_alert_rule(
    rule_id: UUID,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> None:
    rule = db.get(AlertRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found.")
    db.delete(rule)
    db.commit()
