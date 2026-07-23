import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_db
from app.core.database import Base
from app.main import app
from app.services.ai_query import AIQueryService
from app.services.seed import seed_reference_data, seed_sample_expenses


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    seed_sample_expenses(session)
    yield session
    session.close()


@pytest.fixture
def client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _import_seed_deposits(db):
    from pathlib import Path

    from app.services.bank_import import BankImportService

    seed_path = Path(__file__).resolve().parents[2] / "data" / "seed" / "bank_deposits.xlsx"
    if seed_path.exists():
        BankImportService(db).import_deposits(seed_path)


def test_list_query_for_rothschild_q1(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Show all deposits for Rothschild 12 in Q1 2026"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "list"
    assert len(body["data"]) >= 1
    assert all("Rothschild 12" == row["property_name"] for row in body["data"])


def test_gap_analysis_march_2026(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Which properties had no deposit in March 2026?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "gap_analysis"


def test_sum_per_owner(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Total deposits per owner this year"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "sum"
    assert body["query_used"]["group_by"] == "owner"
    assert len(body["data"]) >= 1


def test_compare_periods(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Compare deposits January vs February for Rothschild 12"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "compare_periods"
    assert len(body["data"]) == 2


def test_count_query(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "How many deposits were made in 2026?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "count"
    assert body["data"][0]["deposit_count"] >= 1


def test_out_of_scope_refusal(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Can you parse WhatsApp receipt messages for me?"},
    )
    assert response.status_code == 400
    assert "outside current scope" in response.json()["detail"]


def test_list_utilities_expenses(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "What were the electricity expenses in January 2026?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["domain"] == "expenses"
    assert body["query_used"]["query_type"] == "list"
    assert body["query_used"]["search_text"] == "electric"
    assert body["query_used"]["category"] is None
    assert len(body["data"]) == 1
    assert "electric" in body["data"][0]["description"].lower()


def test_electricity_expenses_q1_excludes_water(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "all electricity expenses of Q1 2026"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["search_text"] == "electric"
    assert len(body["data"]) == 1
    assert body["data"][0]["vendor_name"] == "Israel Electric Corp"


def test_sum_expenses_per_property(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Total expenses per property this year"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["domain"] == "expenses"
    assert body["query_used"]["query_type"] == "sum"
    assert body["query_used"]["group_by"] == "property"
    assert len(body["data"]) >= 1


def test_count_expenses(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "How many expenses were recorded in 2026?"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["domain"] == "expenses"
    assert body["query_used"]["query_type"] == "count"
    assert body["data"][0]["expense_count"] >= 1


def test_sum_expenses_by_category(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Total expenses by category this year"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["domain"] == "expenses"
    assert body["query_used"]["group_by"] == "category"
    assert len(body["data"]) >= 1


def test_list_with_min_amount_filter(client, db):
    _import_seed_deposits(db)
    response = client.post(
        "/api/v1/ai/query",
        json={
            "question": "Show all deposits for Rothschild 12 in Q1 2026 above 5000 amount",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["query_type"] == "list"
    assert body["query_used"]["min_amount"] == "5000"
    assert len(body["data"]) == 3
    for row in body["data"]:
        assert float(row["amount"]) >= 5000
        assert row["property_name"] == "Rothschild 12"


def test_rule_parser_detects_list(db):
    service = AIQueryService(db)
    intent = service._parse_with_rules("Show all deposits for Rothschild 12 in Q1 2026")
    assert intent.domain == "deposits"
    assert intent.query_type == "list"
    assert intent.property_name == "Rothschild 12"


def test_rule_parser_detects_expense_domain(db):
    service = AIQueryService(db)
    intent = service._parse_with_rules("What were the electricity expenses in January 2026?")
    assert intent.domain == "expenses"
    assert intent.search_text == "electric"
    assert intent.category is None
    assert intent.query_type == "list"


def test_rule_parser_source_file_and_review_filters(db):
    service = AIQueryService(db)
    intent = service._parse_with_rules(
        "Show expenses from source file Bank Account example.xlsx"
    )
    assert intent.domain == "expenses"
    assert intent.source_file == "Bank Account example.xlsx"

    mixed = service._parse_with_rules(
        "Show transactions from source file Bank Account example.xlsx"
    )
    assert mixed.domain == "transactions"
    assert mixed.source_file == "Bank Account example.xlsx"

    review = service._parse_with_rules("List incomplete imports that need review")
    assert review.domain == "transactions"
    assert review.needs_review is True

    rental = service._parse_with_rules("Show rental income deposits this year")
    assert rental.domain == "deposits"
    assert rental.is_rental_income is True

    he_she = service._parse_with_rules("List He/She paid expenses in 2026")
    assert he_she.domain == "expenses"
    assert he_she.paid_by_resident is True

    prop_id = service._parse_with_rules("Expenses for Prop ID BUFFER")
    assert prop_id.domain == "expenses"
    assert prop_id.client_prop_id == "BUFFER"


def test_transactions_domain_list(client, db):
    response = client.post(
        "/api/v1/ai/query",
        json={"question": "Show transactions from source file Bank Account example.xlsx"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query_used"]["domain"] == "transactions"
    assert body["query_used"]["query_type"] == "list"
    assert "transaction" in body["answer"].lower()
    for row in body["data"]:
        assert row["kind"] in {"deposit", "expense"}
