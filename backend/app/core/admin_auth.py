"""Simple admin session tokens (HMAC). No user accounts — password from env only."""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

from fastapi import Header, HTTPException

from app.core.config import get_settings

TOKEN_PREFIX = "sa1"


def _secret() -> str:
    settings = get_settings()
    # Derive a stable signing key from the admin password.
    return hashlib.sha256(
        f"simplifai-admin:{settings.admin_password}".encode("utf-8")
    ).hexdigest()


def admin_password_configured() -> bool:
    return bool(get_settings().admin_password.strip())


def create_admin_token() -> tuple[str, int]:
    """Return (token, expires_at_unix)."""
    settings = get_settings()
    if not settings.admin_password.strip():
        raise HTTPException(
            status_code=503,
            detail="Admin login is not configured (set ADMIN_PASSWORD).",
        )
    expires_at = int(time.time()) + int(settings.admin_token_hours * 3600)
    payload = f"{TOKEN_PREFIX}:{expires_at}"
    signature = hmac.new(
        _secret().encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload}:{signature}", expires_at


def verify_admin_token(token: str | None) -> bool:
    if not token or not admin_password_configured():
        return False
    parts = token.strip().split(":")
    if len(parts) != 3 or parts[0] != TOKEN_PREFIX:
        return False
    _, expires_raw, signature = parts
    try:
        expires_at = int(expires_raw)
    except ValueError:
        return False
    if expires_at < int(time.time()):
        return False
    payload = f"{TOKEN_PREFIX}:{expires_at}"
    expected = hmac.new(
        _secret().encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_admin_password(password: str) -> bool:
    settings = get_settings()
    configured = settings.admin_password
    if not configured.strip():
        return False
    return hmac.compare_digest(configured, password)


def require_admin(
    authorization: Optional[str] = Header(default=None),
) -> str:
    """FastAPI dependency: require a valid admin Bearer token."""
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not verify_admin_token(token):
        raise HTTPException(
            status_code=401,
            detail="Admin login required for this action.",
        )
    return token or ""
