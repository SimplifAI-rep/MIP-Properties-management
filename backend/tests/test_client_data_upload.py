from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.owner import Owner
from app.services import import_jobs
from app.services.client_import import CLIENT_DATA_DIR, CLIENT_LIST_FILE, MANAGEMENT_FILE

CLIENT_LIST_PATH = CLIENT_DATA_DIR / CLIENT_LIST_FILE
MANAGEMENT_PATH = CLIENT_DATA_DIR / MANAGEMENT_FILE
HAS_CLIENT_DATA = CLIENT_LIST_PATH.exists() and MANAGEMENT_PATH.exists()


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
    # Allow a fresh job after previous tests
    import_jobs._ACTIVE_JOB_ID = None

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    import_jobs.set_session_factory(previous_factory)
    import_jobs._ACTIVE_JOB_ID = None
    app.dependency_overrides.clear()


def _wait_for_job(client, job_id: str, timeout_s: float = 120.0) -> dict:
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        response = client.get(f"/api/v1/imports/client-data/jobs/{job_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last["status"] in {"succeeded", "failed"}:
            return last
        time.sleep(0.2)
    raise AssertionError(f"Import job {job_id} did not finish: {last}")


def test_client_data_status(client):
    response = client.get("/api/v1/imports/client-data/status")
    assert response.status_code == 200
    body = response.json()
    assert body["database_counts"]["owners"] == 0
    assert any("client_list" in item for item in body["expected_files"])


def test_client_data_import_requires_confirm_reset(client):
    if not HAS_CLIENT_DATA:
        pytest.skip("ClientData Excel files not present")

    response = client.post(
        "/api/v1/imports/client-data",
        data={"reset": "true", "confirm_reset": "false"},
        files={
            "client_list": (
                CLIENT_LIST_FILE,
                CLIENT_LIST_PATH.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            "management": (
                MANAGEMENT_FILE,
                MANAGEMENT_PATH.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
        },
    )
    assert response.status_code == 400
    assert "confirm_reset" in response.text


def test_client_data_import_requires_files(client):
    response = client.post(
        "/api/v1/imports/client-data",
        data={"reset": "false", "confirm_reset": "false"},
        files={},
    )
    assert response.status_code == 422


@pytest.mark.skipif(not HAS_CLIENT_DATA, reason="ClientData Excel files not present")
def test_client_data_import_loads_owners(client, db):
    response = client.post(
        "/api/v1/imports/client-data",
        data={"reset": "false", "confirm_reset": "false"},
        files={
            "client_list": (
                CLIENT_LIST_FILE,
                CLIENT_LIST_PATH.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            "management": (
                MANAGEMENT_FILE,
                MANAGEMENT_PATH.read_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
        },
    )
    assert response.status_code == 202, response.text
    accepted = response.json()
    assert accepted["job_id"]
    assert accepted["status"] in {"queued", "running"}

    job = _wait_for_job(client, accepted["job_id"])
    assert job["status"] == "succeeded", job
    body = job["result"]
    assert body is not None
    assert body["owners_created"] > 0
    assert body["properties_created"] > 0
    assert body["database_counts"]["owners"] > 0
    assert body["skip_report_id"]
    assert body["skipped_row_count"] >= 0
    assert (db.scalar(select(func.count()).select_from(Owner)) or 0) > 0

    report = client.get(f"/api/v1/imports/client-data/reports/{body['skip_report_id']}")
    assert report.status_code == 200
    assert "spreadsheetml" in report.headers.get("content-type", "")
    assert len(report.content) > 1000
