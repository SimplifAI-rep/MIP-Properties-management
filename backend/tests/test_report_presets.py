from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.models.report_preset import ReportPreset
from app.services.seed import seed_reference_data


def _client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    session.commit()

    def override_get_db():
        yield session

    app.dependency_overrides[get_db] = override_get_db
    test_client = TestClient(app)
    return test_client, session


def test_create_list_update_delete_report_preset():
    client, db = _client()
    try:
        created = client.post(
            "/api/v1/report-presets",
            json={
                "name": "  David Cohen  ",
                "filters": {
                    "kinds": ["deposit", "expense", "rental_income"],
                    "property_statuses": ["active"],
                    "owner_ids": ["a0000000-0000-4000-8000-000000000001"],
                    "date_from": "2026-01-01",
                    "date_to": "2026-12-31",
                },
            },
        )
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["name"] == "David Cohen"
        assert body["filters"]["owner_ids"] == [
            "a0000000-0000-4000-8000-000000000001"
        ]
        assert body["filters"]["date_from"] == "2026-01-01"
        preset_id = body["id"]

        listed = client.get("/api/v1/report-presets")
        assert listed.status_code == 200
        assert len(listed.json()) == 1
        assert listed.json()[0]["name"] == "David Cohen"

        updated = client.patch(
            f"/api/v1/report-presets/{preset_id}",
            json={
                "filters": {
                    "kinds": ["deposit", "expense", "rental_income", "he_she_paid"],
                    "owner_ids": ["a0000000-0000-4000-8000-000000000001"],
                    "property_statuses": ["active", "inactive"],
                }
            },
        )
        assert updated.status_code == 200, updated.text
        assert "he_she_paid" in updated.json()["filters"]["kinds"]
        assert updated.json()["filters"]["property_statuses"] == ["active", "inactive"]

        deleted = client.delete(f"/api/v1/report-presets/{preset_id}")
        assert deleted.status_code == 204
        assert db.scalar(select(ReportPreset)) is None
        assert client.get("/api/v1/report-presets").json() == []
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_duplicate_name_and_invalid_filters():
    client, db = _client()
    try:
        first = client.post(
            "/api/v1/report-presets",
            json={"name": "David Cohen", "filters": {"owner_ids": ["abc"]}},
        )
        assert first.status_code == 201, first.text

        dup = client.post(
            "/api/v1/report-presets",
            json={"name": "david cohen", "filters": {}},
        )
        assert dup.status_code == 409

        blank = client.post("/api/v1/report-presets", json={"name": "   "})
        assert blank.status_code == 400

        bad_kind = client.post(
            "/api/v1/report-presets",
            json={"name": "Other", "filters": {"kinds": ["not_a_type"]}},
        )
        assert bad_kind.status_code == 400
        assert "Unknown type filter" in bad_kind.json()["detail"]

        missing = client.delete(
            "/api/v1/report-presets/00000000-0000-4000-8000-000000000099"
        )
        assert missing.status_code == 404
    finally:
        app.dependency_overrides.clear()
        db.close()
