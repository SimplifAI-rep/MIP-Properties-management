from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.core.admin_auth import (
    admin_password_configured,
    create_admin_token,
    require_admin,
    verify_admin_password,
    verify_admin_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class AdminLoginRequest(BaseModel):
    password: str = Field(min_length=1)


class AdminLoginResponse(BaseModel):
    token: str
    expires_at: int
    role: str = "admin"


class AdminSessionResponse(BaseModel):
    authenticated: bool
    role: str | None = None
    configured: bool = False


def _bearer_token(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


@router.post("/admin/login", response_model=AdminLoginResponse)
def admin_login(payload: AdminLoginRequest) -> AdminLoginResponse:
    """Exchange the admin password for a session token."""
    if not admin_password_configured():
        raise HTTPException(
            status_code=503,
            detail="Admin login is not configured.",
        )
    if not verify_admin_password(payload.password):
        raise HTTPException(status_code=401, detail="Incorrect password.")
    token, expires_at = create_admin_token()
    return AdminLoginResponse(token=token, expires_at=expires_at)


@router.get("/admin/session", response_model=AdminSessionResponse)
def admin_session(
    authorization: str | None = Header(default=None),
) -> AdminSessionResponse:
    """Soft check: returns authenticated true/false without raising."""
    token = _bearer_token(authorization)
    ok = verify_admin_token(token)
    return AdminSessionResponse(
        authenticated=ok,
        role="admin" if ok else None,
        configured=admin_password_configured(),
    )


@router.get("/admin/me", response_model=AdminSessionResponse)
def admin_me(_token: str = Depends(require_admin)) -> AdminSessionResponse:
    """Strict check: 401 if the admin token is missing or invalid."""
    return AdminSessionResponse(authenticated=True, role="admin", configured=True)
