"""Send client feedback messages via SMTP."""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from app.core.config import Settings

logger = logging.getLogger(__name__)


class FeedbackEmailError(Exception):
    """Raised when feedback email cannot be sent."""


def feedback_email_configured(settings: Settings) -> bool:
    return bool(
        settings.feedback_to_email
        and settings.smtp_host
        and settings.smtp_username
        and settings.smtp_password
    )


def send_feedback_email(
    *,
    settings: Settings,
    message: str,
    name: str | None = None,
    reply_email: str | None = None,
    page_url: str | None = None,
) -> None:
    if not feedback_email_configured(settings):
        raise FeedbackEmailError(
            "Feedback email is not configured. Set FEEDBACK_TO_EMAIL and SMTP_* env vars."
        )

    subject_bits = ["SimplifAI feedback"]
    if name:
        subject_bits.append(f"from {name}")
    subject = " ".join(subject_bits)

    body_lines = [
        "New feedback from SimplifAI:",
        "",
        message.strip(),
        "",
        "---",
    ]
    if name:
        body_lines.append(f"Name: {name}")
    if reply_email:
        body_lines.append(f"Reply-to: {reply_email}")
    if page_url:
        body_lines.append(f"Page: {page_url}")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from_email or settings.smtp_username
    msg["To"] = settings.feedback_to_email
    if reply_email:
        msg["Reply-To"] = reply_email
    msg.set_content("\n".join(body_lines))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
            if settings.smtp_use_tls:
                smtp.starttls()
            smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 — surface as API error
        logger.exception("Failed to send feedback email")
        raise FeedbackEmailError("Could not send feedback email. Try again later.") from exc
