from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import CreditCardCreate, CreditCardRead, CreditCardUpdate
from app.services import credit_cards as credit_cards_service

router = APIRouter(prefix="/credit-cards", tags=["credit-cards"])


def _to_read(db, account) -> CreditCardRead:
    return CreditCardRead(**credit_cards_service.card_to_read(db, account))


@router.get("", response_model=list[CreditCardRead])
def list_credit_cards(db: Session = Depends(get_db)) -> list[CreditCardRead]:
    return [CreditCardRead(**row) for row in credit_cards_service.list_cards(db)]


@router.post("", response_model=CreditCardRead)
def create_credit_card(
    payload: CreditCardCreate, db: Session = Depends(get_db)
) -> CreditCardRead:
    try:
        account = credit_cards_service.create_card(
            db,
            card_last4=payload.card_last4,
            label=payload.label,
            bank_name=payload.bank_name,
            is_active=payload.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_read(db, account)


@router.patch("/{card_id}", response_model=CreditCardRead)
def update_credit_card(
    card_id: UUID, payload: CreditCardUpdate, db: Session = Depends(get_db)
) -> CreditCardRead:
    try:
        account = credit_cards_service.update_card(
            db,
            card_id,
            label=payload.label,
            bank_name=payload.bank_name,
            is_active=payload.is_active,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_read(db, account)
