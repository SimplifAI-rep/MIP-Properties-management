import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.admin_auth import create_admin_token, verify_admin_token
from app.core.config import get_settings
from app.core.database import Base
from app.main import app
from app.services import import_jobs


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSession()
    yield session
    session.close()


@pytest.fixture
def client(db):
    engine = db.get_bind()
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def override_get_db():
        yield db

    previous_factory = import_jobs._session_factory
    import_jobs.set_session_factory(TestingSession)
    import_jobs._ACTIVE_JOB_ID = None

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    import_jobs.set_session_factory(previous_factory)
    import_jobs._ACTIVE_JOB_ID = None
    app.dependency_overrides.clear()


def test_admin_login_and_session(client, monkeypatch):
    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-secret")
    get_settings.cache_clear()

    bad = client.post("/api/v1/auth/admin/login", json={"password": "wrong"})
    assert bad.status_code == 401

    ok = client.post("/api/v1/auth/admin/login", json={"password": "test-admin-secret"})
    assert ok.status_code == 200, ok.text
    token = ok.json()["token"]
    assert verify_admin_token(token)

    session = client.get(
        "/api/v1/auth/admin/session",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert session.status_code == 200
    assert session.json()["authenticated"] is True

    me = client.get("/api/v1/auth/admin/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200

    get_settings.cache_clear()


def test_reset_requires_admin(client, monkeypatch):
    from app.services.client_import import CLIENT_DATA_DIR, CLIENT_LIST_FILE, MANAGEMENT_FILE

    client_list = CLIENT_DATA_DIR / CLIENT_LIST_FILE
    management = CLIENT_DATA_DIR / MANAGEMENT_FILE
    if not client_list.exists() or not management.exists():
        pytest.skip("ClientData Excel files not present")

    monkeypatch.setenv("ADMIN_PASSWORD", "test-admin-secret")
    get_settings.cache_clear()

    files = {
        "client_list": (
            CLIENT_LIST_FILE,
            client_list.read_bytes(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "management": (
            MANAGEMENT_FILE,
            management.read_bytes(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
    }

    denied = client.post(
        "/api/v1/imports/client-data",
        data={"reset": "true", "confirm_reset": "true"},
        files=files,
    )
    assert denied.status_code == 401

    token, _ = create_admin_token()
    missing_confirm = client.post(
        "/api/v1/imports/client-data",
        data={"reset": "true", "confirm_reset": "false"},
        files=files,
        headers={"Authorization": f"Bearer {token}"},
    )
    assert missing_confirm.status_code == 400
    assert "confirm_reset" in missing_confirm.text

    get_settings.cache_clear()
