from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.services.feedback_email import FeedbackEmailError


@pytest.fixture(autouse=True)
def clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_submit_feedback_sends_email(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_TO_EMAIL", "owner@example.com")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "secret")
    get_settings.cache_clear()

    with patch("app.api.v1.feedback.send_feedback_email") as send_mock:
        response = client.post(
            "/api/v1/feedback",
            json={
                "message": "Please add CSV export for owners",
                "name": "Alex",
                "email": "alex@client.com",
                "page_url": "https://app.example.com/owners",
            },
        )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    send_mock.assert_called_once()
    kwargs = send_mock.call_args.kwargs
    assert kwargs["message"] == "Please add CSV export for owners"
    assert kwargs["name"] == "Alex"
    assert kwargs["reply_email"] == "alex@client.com"


def test_submit_feedback_requires_message(client):
    response = client.post("/api/v1/feedback", json={"message": "hi"})
    assert response.status_code == 422


def test_submit_feedback_smtp_failure(client, monkeypatch):
    monkeypatch.setenv("FEEDBACK_TO_EMAIL", "owner@example.com")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "secret")
    get_settings.cache_clear()

    with patch(
        "app.api.v1.feedback.send_feedback_email",
        side_effect=FeedbackEmailError("Could not send feedback email. Try again later."),
    ):
        response = client.post(
            "/api/v1/feedback",
            json={"message": "Something broke on deposits"},
        )

    assert response.status_code == 503


def test_send_feedback_email_builds_message(monkeypatch):
    from app.services.feedback_email import send_feedback_email

    monkeypatch.setenv("FEEDBACK_TO_EMAIL", "owner@example.com")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "secret")
    monkeypatch.setenv("SMTP_FROM_EMAIL", "noreply@example.com")
    get_settings.cache_clear()
    settings = get_settings()

    smtp_instance = MagicMock()
    smtp_cm = MagicMock()
    smtp_cm.__enter__.return_value = smtp_instance
    smtp_cm.__exit__.return_value = False

    with patch("app.services.feedback_email.smtplib.SMTP", return_value=smtp_cm) as smtp_cls:
        send_feedback_email(
            settings=settings,
            message="Bug on properties table",
            name="Sam",
            reply_email="sam@example.com",
            page_url="/properties",
        )

    smtp_cls.assert_called_once_with("smtp.example.com", 587, timeout=30)
    smtp_instance.starttls.assert_called_once()
    smtp_instance.login.assert_called_once_with("sender@example.com", "secret")
    smtp_instance.send_message.assert_called_once()
    sent = smtp_instance.send_message.call_args.args[0]
    assert sent["To"] == "owner@example.com"
    assert sent["Reply-To"] == "sam@example.com"
    assert "Bug on properties table" in sent.get_content()
