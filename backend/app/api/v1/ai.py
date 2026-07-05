from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas import AIQueryRequest, AIQueryResponse
from app.services.ai_query import AIQueryService

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/query", response_model=AIQueryResponse)
def ai_query(
    payload: AIQueryRequest,
    db: Session = Depends(get_db),
) -> AIQueryResponse:
    service = AIQueryService(db)
    return service.query(payload.question.strip())
