from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.core.config import get_settings
from app.services.feedback_email import FeedbackEmailError, send_feedback_email

router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackCreate(BaseModel):
    message: str = Field(min_length=3, max_length=5000)
    name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=255)
    page_url: str | None = Field(default=None, max_length=500)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        if value is None or value.strip() == "":
            return None
        cleaned = value.strip()
        if "@" not in cleaned or "." not in cleaned.split("@")[-1]:
            raise ValueError("Invalid email address")
        return cleaned

    @field_validator("name", "page_url")
    @classmethod
    def empty_to_none(cls, value: str | None) -> str | None:
        if value is None or value.strip() == "":
            return None
        return value.strip()


class FeedbackResponse(BaseModel):
    ok: bool
    detail: str


@router.post("", response_model=FeedbackResponse)
def submit_feedback(payload: FeedbackCreate) -> FeedbackResponse:
    settings = get_settings()
    try:
        send_feedback_email(
            settings=settings,
            message=payload.message,
            name=payload.name,
            reply_email=payload.email,
            page_url=payload.page_url,
        )
    except FeedbackEmailError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return FeedbackResponse(ok=True, detail="Feedback sent. Thank you.")
