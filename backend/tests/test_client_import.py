"""Unit tests for client property-id normalization and Excel import."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from openpyxl import Workbook
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import PROJECT_ROOT
from app.core.database import Base
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.services.bank_settings import mark_reset_import_verified, resolve_account_settings
from app.services.client_import import (
    BUFFER_PROP_ID,
    CLIENT_LIST_FILE,
    COMPANY_OWNER_NAME,
    MANAGEMENT_FILE,
    PAST_CLIENT_LIST_FILE,
    PAST_CLIENTS_OWNER_NAME,
    detect_client_list_header,
    detect_past_client_list_header,
    import_client_data,
    is_combined_prop_id,
    looks_like_shared_prop,
    normalize_prop_key,
    owner_shared_client_prop_id,
    parse_active_flag,
    pick_client_list_main_sheet,
    prop_key_aliases,
    sheet_uses_row_prop_ids,
    split_combined_prop_keys,
    unique_listed_prefix_match,
    unique_listed_stem_match,
)
from app.services.client_import_verify import verify_against_excel

CLIENT_DATA = PROJECT_ROOT / "data" / "ClientData"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("5 or 05 ex", "5"),
        ("05 ex", "5"),
        ("C4or c4 EX", "C4"),
        ("C6 or 06 ex", "C6"),
        ("N160", "N160"),
        ("p14", "P14"),
        ("273 or 273 EX", "273"),
        (5, "5"),
        ("  111  ", "111"),
        (618.0, "618"),
        ("618.0", "618"),
        ("Shared Silver", "SHAREDSILVER"),
    ],
)
def test_normalize_prop_key(raw, expected):
    assert normalize_prop_key(raw) == expected


def test_prop_key_aliases_include_both_sides():
    aliases = prop_key_aliases("C6 or 06 ex")
    assert "C6" in aliases
    assert "6" in aliases


def test_combined_prop_id_helpers():
    assert split_combined_prop_keys("618/619/801") == ["618", "619", "801"]
    assert split_combined_prop_keys("618+801") == ["618", "801"]
    assert is_combined_prop_id("618/619/801")
    assert is_combined_prop_id("618 + 801")
    assert not is_combined_prop_id("618")
    assert sheet_uses_row_prop_ids("Silver ex")
    assert sheet_uses_row_prop_ids("801-618-619")
    assert not sheet_uses_row_prop_ids("H111")
    assert owner_shared_client_prop_id("Stu Silver") == "SHARED-STUSILVER"
    assert looks_like_shared_prop("Shared Silver", "Shared")
    assert looks_like_shared_prop("shered")
    assert not looks_like_shared_prop("618", "Stu Silver")
    assert parse_active_flag("YES") is True
    assert parse_active_flag("NO") is False
    assert parse_active_flag(None) is None
    assert pick_client_list_main_sheet(["ALL  Clients", "past clients"]) == "ALL  Clients"
    header = detect_client_list_header(
        [
            "Property \nNumber",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    assert header is not None
    assert header["prop_number"] == 0
    assert header["final_id"] == 1
    assert header["last_name"] == 2
    assert header["address"] == 5
    assert header["city"] == 6
    assert header["active"] == 8
    assert unique_listed_prefix_match("1008BEL", {"1008BELL", "111"}) == "1008BELL"
    assert unique_listed_prefix_match("H111", {"111", "1008BELL"}) is None
    assert unique_listed_stem_match("707SETH", {"707", "111"}) == "707"
    assert unique_listed_stem_match("707MARC", {"707"}) == "707"
    assert unique_listed_stem_match("707EX", {"707"}) == "707"
    assert unique_listed_stem_match("H111", {"111", "707"}) is None
    assert unique_listed_stem_match("7071", {"707"}) is None
    past_header = detect_past_client_list_header(
        ["Hidden Sheet", "Property #", "Owner(s)", "Source of Owner Name"]
    )
    assert past_header is not None
    assert past_header["sheet_id"] == 0
    assert past_header["prop_number"] == 1
    assert past_header["owner_name"] == 2
    assert detect_past_client_list_header(["Hidden Tabs – Property Numbers & Owners"]) is None
    assert detect_past_client_list_header(
        ["Client Property Info.xlsx — 20 hidden sheets of 70 total"]
    ) is None


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.mark.skipif(not CLIENT_DATA.exists(), reason="ClientData folder missing")
def test_client_excel_import_matches_verify(db):
    stats = import_client_data(db, data_dir=CLIENT_DATA)
    assert stats.expenses_created > 0
    assert stats.deposits_created > 0
    assert not stats.errors

    report = verify_against_excel(db, CLIENT_DATA)
    assert report["ok"] is True, report["mismatches"]
    # Totals include incomplete/needs_review mgmt rows beyond unique dated Excel keys
    assert report["database"]["expenses"] >= report["excel"]["expected_expenses_total"]
    assert report["database"]["deposits"] >= report["excel"]["expected_deposits_total"]
    # Incomplete (needs_review) rows explain surplus over dated Excel money keys
    expense_surplus = (
        report["database"]["expenses"] - report["excel"]["expected_expenses_total"]
    )
    deposit_surplus = (
        report["database"]["deposits"] - report["excel"]["expected_deposits_total"]
    )
    assert expense_surplus + deposit_surplus <= stats.needs_review_created + 15
    assert expense_surplus >= 0 and deposit_surplus >= 0
    assert stats.skip_reason_counts.get("imported_needs_review", 0) == 0

    # Idempotent second pass
    stats2 = import_client_data(db, data_dir=CLIENT_DATA)
    assert stats2.expenses_created == 0
    assert stats2.deposits_created == 0

    prop_count = db.scalar(select(func.count()).select_from(Property)) or 0
    assert prop_count >= 29  # current clients + BUFFER (+ ledger-only)


@pytest.mark.skipif(not CLIENT_DATA.exists(), reason="ClientData folder missing")
def test_sample_property_5_has_ledger_rows(db):
    import_client_data(db, data_dir=CLIENT_DATA)
    prop = db.scalars(select(Property).where(Property.client_prop_id == "5")).first()
    assert prop is not None
    expenses = db.scalar(
        select(func.count()).select_from(Expense).where(Expense.property_id == prop.id)
    )
    deposits = db.scalar(
        select(func.count()).select_from(Deposit).where(Deposit.property_id == prop.id)
    )
    assert expenses and expenses > 0
    assert deposits and deposits > 0


def _write_mini_client_data(data_dir: Path) -> None:
    clients = Workbook()
    ws = clients.active
    ws.title = "current clients"
    ws.append(["Property number", "Last", "First", "Hebrew", "Address", "City"])
    ws.append(["H111", "Test", "Owner", None, "1 Test St", "Tel Aviv"])
    clients.save(data_dir / CLIENT_LIST_FILE)

    mgmt = Workbook()
    sheet = mgmt.active
    sheet.title = "H111"
    sheet.append(["Date", "Amount", "Inflow", "Section", "Notes"])
    sheet.append([date(2026, 1, 15), 100, None, "Electric", "first"])
    sheet.append([date(2026, 1, 15), 100, None, "Electric", "second"])
    sheet.append([date(2026, 1, 16), None, 250, "Inflow", "deposit one"])
    sheet.append([date(2026, 1, 16), None, 250, "Inflow", "deposit two"])
    sheet.append([None, 80, None, "Missing date", "incomplete with amount"])
    mgmt.save(data_dir / MANAGEMENT_FILE)


def test_duplicate_ledger_rows_with_amount_all_import(db, tmp_path):
    _write_mini_client_data(tmp_path)
    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors
    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    assert len(expenses) == 3
    assert len(deposits) == 2
    assert stats.expenses_skipped == 0
    assert stats.deposits_skipped == 0
    assert stats.skip_reason_counts.get("duplicate_expense", 0) == 0
    assert stats.skip_reason_counts.get("duplicate_deposit", 0) == 0
    assert stats.skip_reason_counts.get("imported_needs_review", 0) == 0
    assert stats.needs_review_created == 1
    incomplete = [row for row in expenses if row.needs_review]
    assert len(incomplete) == 1
    assert incomplete[0].amount == Decimal("80.00")
    assert incomplete[0].transaction_date is None

    stats2 = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert stats2.expenses_created == 0
    assert stats2.deposits_created == 0
    assert stats2.expenses_skipped >= 2
    assert stats2.deposits_skipped >= 2


def test_reset_import_marks_dated_transactions_verified(db, tmp_path):
    _write_mini_client_data(tmp_path)
    import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    dep_n, exp_n, as_of = mark_reset_import_verified(db)
    db.expire_all()
    assert dep_n == 2
    assert exp_n == 2
    assert as_of == date(2026, 1, 16)

    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    dated = [row for row in expenses if row.transaction_date is not None]
    undated = [row for row in expenses if row.transaction_date is None]
    assert dated and all(row.bank_verified_at is not None for row in dated)
    assert undated and all(row.bank_verified_at is None for row in undated)
    assert all(row.bank_verified_at is not None for row in deposits)

    account, company = resolve_account_settings(db)
    last = (
        account.last_verification_date
        if account is not None and account.last_verification_date is not None
        else company.last_verification_date
    )
    assert last == date(2026, 1, 16)
    opening = account.opening_balance if account is not None else company.opening_balance
    assert opening is None


def test_silver_shared_property_from_combined_prop_ids(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "current clients"
    ws.append(["Property number", "Last", "First", "Hebrew", "Address", "City"])
    ws.append(["618", "Silver", "Stu", None, "Shirat Hayam 618", "Zichron"])
    ws.append(["619", "Silver", "Stu", None, "Shirat Hayam 619", "Zichron"])
    ws.append(["801", "Silver", "Stu", None, "Havat Habaron 801", "Zichron"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    mgmt = Workbook()
    silver = mgmt.active
    silver.title = "Silver ex"
    silver.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    silver.append(["618", date(2026, 1, 10), "Electric", 10, None, "one property"])
    silver.append(["619", date(2026, 1, 11), "Water", 20, None, "one property"])
    silver.append(["618/619/801", date(2026, 1, 12), "Arnona", 30, None, "shared three"])
    silver.append(["618/801", date(2026, 1, 13), "Prepaid", None, 40, "shared two"])
    buffer = mgmt.create_sheet("Buffer")
    buffer.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    buffer.append(["BUFFER/UNKNOWN", date(2026, 1, 14), "Misc", 5, None, "mip combined"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    assert "618" in by_id
    assert "619" in by_id
    assert "801" in by_id
    assert "SILVER" not in by_id
    shared_id = owner_shared_client_prop_id("Stu Silver")
    assert shared_id in by_id
    silver_owner = db.scalars(select(Owner).where(Owner.name == "Stu Silver")).first()
    assert silver_owner is not None
    assert by_id[shared_id].owner_id == silver_owner.id
    assert by_id[shared_id].status == "active"
    company = db.scalars(select(Owner).where(Owner.name == COMPANY_OWNER_NAME)).first()
    assert company is not None
    assert by_id[shared_id].owner_id != company.id

    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    amounts = {(row.property_id, row.amount) for row in expenses}
    assert (by_id["618"].id, Decimal("10.00")) in amounts
    assert (by_id["619"].id, Decimal("20.00")) in amounts
    assert (by_id[shared_id].id, Decimal("30.00")) in amounts
    assert (by_id[BUFFER_PROP_ID].id, Decimal("5.00")) in amounts
    assert len(deposits) == 1
    assert deposits[0].property_id == by_id[shared_id].id
    assert deposits[0].amount == Decimal("40.00")


def test_listed_shared_silver_replaces_auto_shared_property(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "ALL  Clients"
    ws.append(
        [
            "Property Number",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    ws.append(["618 or Siver ex", 618.0, "Silver", "Stu", None, "Shirat Hayam 618", "Zichron", None, "YES"])
    ws.append(["619 or Siver ex", 619.0, "Silver", "Stu", None, "Shirat Hayam 619", "Zichron", None, "YES"])
    ws.append(["801 or Siver ex", 801.0, "Silver", "Stu", None, "Havat Habaron 801", "Zichron", None, "YES"])
    ws.append(["Shared", "Shared Silver", "Silver", "Stu", None, None, None, None, "YES"])
    ws.append([1008.0, "1008BELL", "Devora", "Bell", None, "Bell St", "Zichron", None, "YES"])
    ws.append([3.0, 3.0, "Lissak", "Lissa", None, "Gazit 3", "Zichron", None, "NO"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    mgmt = Workbook()
    silver = mgmt.active
    silver.title = "Silver ex"
    silver.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    silver.append(["618", date(2026, 1, 10), "Electric", 10, None, "one property"])
    silver.append(["618/619/801", date(2026, 1, 12), "Arnona", 30, None, "shared three"])
    silver.append(["618/801", date(2026, 1, 13), "Prepaid", None, 40, "shared two"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    assert "618" in by_id
    assert "619" in by_id
    assert "801" in by_id
    assert "1008BELL" in by_id
    assert "1008" not in by_id
    assert "SHAREDSILVER" in by_id
    assert owner_shared_client_prop_id("Stu Silver") not in by_id
    assert by_id["SHAREDSILVER"].name == "Shared Silver"
    assert by_id["SHAREDSILVER"].status == "active"
    assert by_id["618"].status == "active"
    assert by_id["3"].status == "inactive"
    silver_owner = db.scalars(select(Owner).where(Owner.name == "Stu Silver")).first()
    assert silver_owner is not None
    assert by_id["SHAREDSILVER"].owner_id == silver_owner.id

    expenses = db.scalars(select(Expense)).all()
    deposits = db.scalars(select(Deposit)).all()
    amounts = {(row.property_id, row.amount) for row in expenses}
    assert (by_id["618"].id, Decimal("10.00")) in amounts
    assert (by_id["SHAREDSILVER"].id, Decimal("30.00")) in amounts
    assert len(deposits) == 1
    assert deposits[0].property_id == by_id["SHAREDSILVER"].id
    assert deposits[0].amount == Decimal("40.00")


def test_shapira_does_not_get_shared_property_without_combined_rows(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "ALL  Clients"
    ws.append(
        [
            "Property Number",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    ws.append(["C19", "C19", "Shapira", "Rafael", "רפאל שפירא", "Addr 19", "Zichron", None, "YES"])
    ws.append(["C31", "C31", "Shapira", "Rafael", "רפאל שפירא", "Addr 31", "Zichron", None, "YES"])
    ws.append(["Shared Shapira", "Shared Shapira", "Shapira", "Rafael", None, None, None, None, "YES"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    mgmt = Workbook()
    sheet = mgmt.active
    sheet.title = "C19"
    sheet.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet.append(["C19", date(2026, 1, 10), "Electric", 10, None, "one property"])
    other = mgmt.create_sheet("C31")
    other.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    other.append(["C31", date(2026, 1, 11), "Water", 20, None, "one property"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    assert "C19" in by_id
    assert "C31" in by_id
    assert "SHAREDSHAPIRA" not in by_id
    shapira = db.scalars(select(Owner).where(Owner.name.startswith("Rafael Shapira"))).first()
    assert shapira is not None
    shapira_props = [p for p in by_id.values() if p.owner_id == shapira.id]
    assert {p.client_prop_id for p in shapira_props} == {"C19", "C31"}
    assert owner_shared_client_prop_id(shapira.name) not in by_id


def test_unmatched_ledger_sheet_goes_to_past_clients_and_1008bel_maps(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "ALL  Clients"
    ws.append(
        [
            "Property Number",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    ws.append([1008.0, "1008BELL", "Devora", "Bell", None, "Bell St", "Zichron", None, "YES"])
    ws.append([111.0, 111.0, "Levi", "Meryl", None, "HaMeginim 111", "Zichron", None, "YES"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    mgmt = Workbook()
    bell = mgmt.active
    bell.title = "1008BEL"
    bell.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    bell.append(["1008BEL", date(2026, 1, 10), "Electric", 15, None, "mapped to bell"])
    h111 = mgmt.create_sheet("H111")
    h111.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    h111.append(["H111", date(2026, 1, 11), "Water", 25, None, "past client"])
    current = mgmt.create_sheet("111")
    current.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    current.append([111, date(2026, 1, 12), "Gas", 5, None, "meryl"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    assert "1008BELL" in by_id
    assert "1008BEL" not in by_id
    assert "H111" in by_id
    assert by_id["H111"].status == "inactive"
    past = db.scalars(select(Owner).where(Owner.name == PAST_CLIENTS_OWNER_NAME)).first()
    assert past is not None
    assert by_id["H111"].owner_id == past.id
    company = db.scalars(select(Owner).where(Owner.name == COMPANY_OWNER_NAME)).first()
    assert company is not None
    assert by_id["H111"].owner_id != company.id
    assert by_id[BUFFER_PROP_ID].owner_id == company.id

    expenses = db.scalars(select(Expense)).all()
    amounts = {(row.property_id, row.amount) for row in expenses}
    assert (by_id["1008BELL"].id, Decimal("15.00")) in amounts
    assert (by_id["H111"].id, Decimal("25.00")) in amounts
    assert (by_id["111"].id, Decimal("5.00")) in amounts


def test_707_ledger_tabs_map_onto_listed_707(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "ALL  Clients"
    ws.append(
        [
            "Property Number",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    ws.append(["70/7", "707", "Cohen", "Olivier", None, "HaMeyasdim 70/7", "Zichron", None, "YES"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    mgmt = Workbook()
    listed = mgmt.active
    listed.title = "707"
    listed.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    listed.append([707, date(2026, 1, 10), "Electric", 10, None, "listed tab"])
    seth = mgmt.create_sheet("707 Seth")
    seth.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    seth.append([707, date(2026, 1, 11), "Water", 20, None, "seth row"])
    seth.append([None, date(2026, 1, 12), "Gas", 4, None, "seth default"])
    marc = mgmt.create_sheet("707 marc")
    marc.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    marc.append([707, date(2026, 1, 13), "Arnona", 30, None, "marc row"])
    marc.append([None, date(2026, 1, 14), "Hot", 5, None, "marc default"])
    ex = mgmt.create_sheet("707 EX")
    ex.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    ex.append([707, date(2026, 1, 15), "Repair", 40, None, "ex row"])
    leftover = mgmt.create_sheet("210")
    leftover.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    leftover.append([210, date(2026, 1, 16), "Electric", 9, None, "unmatched"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    assert "707" in by_id
    assert "707SETH" not in by_id
    assert "707MARC" not in by_id
    assert "707EX" not in by_id
    past = db.scalars(select(Owner).where(Owner.name == PAST_CLIENTS_OWNER_NAME)).first()
    assert by_id["707"].owner_id != (past.id if past else None)
    assert "Cohen" in (db.get(Owner, by_id["707"].owner_id).name or "")
    assert "210" in by_id
    assert past is not None
    assert by_id["210"].owner_id == past.id

    expenses = {(row.property_id, row.amount) for row in db.scalars(select(Expense)).all()}
    listed_id = by_id["707"].id
    assert (listed_id, Decimal("10.00")) in expenses
    assert (listed_id, Decimal("20.00")) in expenses
    assert (listed_id, Decimal("4.00")) in expenses
    assert (listed_id, Decimal("30.00")) in expenses
    assert (listed_id, Decimal("5.00")) in expenses
    assert (listed_id, Decimal("40.00")) in expenses
    assert (by_id["210"].id, Decimal("9.00")) in expenses


def test_past_client_list_maps_hidden_tabs_without_stealing_current_ids(db, tmp_path):
    clients = Workbook()
    ws = clients.active
    ws.title = "ALL  Clients"
    ws.append(
        [
            "Property Number",
            "Final #",
            "Last Name",
            "First name",
            "שם",
            "Address",
            "City",
            "Dear for reports",
            "Active",
        ]
    )
    ws.append([111.0, 111.0, "Levi", "Meryl", None, "HaMeginim 111", "Zichron", None, "YES"])
    ws.append(["C6 or 06 ex", "C6", "Wurtman", "Elie", None, "Mandarina 6", "Caesarea", None, "YES"])
    clients.save(tmp_path / CLIENT_LIST_FILE)

    past = Workbook()
    past_ws = past.active
    past_ws.append(["Hidden Tabs – Property Numbers & Owners"])
    past_ws.append(["Client Property Info.xlsx — 20 hidden sheets of 70 total"])
    past_ws.append([None, None, None, None])
    past_ws.append(["Hidden Sheet", "Property #", "Owner(s)", "Source of Owner Name"])
    past_ws.append(["H111", "111", "Richard Kahn & Rhonda Jacobs Kahn", "Sheet"])
    past_ws.append(["022", "22", "Nealy & Seth Fischer", "Sheet"])
    past_ws.append(["06", 6, "Wurtman", "Prop ID tab (surname only)"])
    past_ws.append([225, 225, "Kaplan", "Prop ID tab (surname only)"])
    past_ws.append(["TS 225", 225, "Kaplan", "Transactions tab"])
    past_ws.append([23, 23, "Not found", "No owner row on sheet"])
    past.save(tmp_path / PAST_CLIENT_LIST_FILE)

    mgmt = Workbook()
    h111 = mgmt.active
    h111.title = "H111"
    h111.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    h111.append(["H111", date(2026, 1, 11), "Water", 25, None, "kahn"])
    sheet22 = mgmt.create_sheet("22")
    sheet22.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet22.append([22, date(2026, 1, 12), "Electric", 8, None, "fischer"])
    sheet225 = mgmt.create_sheet("225")
    sheet225.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet225.append([225, date(2026, 1, 13), "Gas", 12, None, "kaplan"])
    sheet_ts = mgmt.create_sheet("TS225")
    sheet_ts.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet_ts.append(["TS225", date(2026, 1, 14), "Water", 3, None, "kaplan ts"])
    sheet210 = mgmt.create_sheet("210")
    sheet210.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet210.append([210, date(2026, 1, 15), "Electric", 9, None, "unmatched"])
    sheet23 = mgmt.create_sheet("23")
    sheet23.append(["Prop ID", "Date", "Section", "Amount", "Inflow", "Notes"])
    sheet23.append([23, date(2026, 1, 16), "Water", 4, None, "not found"])
    mgmt.save(tmp_path / MANAGEMENT_FILE)

    stats = import_client_data(
        db,
        data_dir=tmp_path,
        include_bank=False,
        include_credit_cards=False,
    )
    assert not stats.errors

    by_id = {prop.client_prop_id: prop for prop in db.scalars(select(Property)).all()}
    kahn = db.get(Owner, by_id["H111"].owner_id)
    fischer = db.get(Owner, by_id["22"].owner_id)
    kaplan = db.get(Owner, by_id["225"].owner_id)
    past_bucket = db.scalars(select(Owner).where(Owner.name == PAST_CLIENTS_OWNER_NAME)).first()
    assert kahn is not None and "Kahn" in (kahn.name or "")
    assert fischer is not None and "Fischer" in (fischer.name or "")
    assert kaplan is not None and kaplan.name == "Kaplan"
    assert by_id["TS225"].owner_id == kaplan.id
    assert by_id["H111"].status == "inactive"
    assert by_id["22"].status == "inactive"
    assert by_id["225"].status == "inactive"
    assert by_id["TS225"].status == "inactive"
    assert "Meryl" in (db.get(Owner, by_id["111"].owner_id).name or "")
    assert by_id["111"].owner_id != kahn.id
    assert by_id["C6"].status == "active"
    assert "Wurtman" in (db.get(Owner, by_id["C6"].owner_id).name or "")
    assert past_bucket is not None
    assert by_id["210"].owner_id == past_bucket.id
    assert by_id["23"].owner_id == past_bucket.id
    assert by_id["H111"].owner_id != past_bucket.id
    assert by_id["22"].owner_id != past_bucket.id

    expenses = {(row.property_id, row.amount) for row in db.scalars(select(Expense)).all()}
    assert (by_id["H111"].id, Decimal("25.00")) in expenses
    assert (by_id["22"].id, Decimal("8.00")) in expenses
    assert (by_id["225"].id, Decimal("12.00")) in expenses
    assert (by_id["TS225"].id, Decimal("3.00")) in expenses
    assert (by_id["210"].id, Decimal("9.00")) in expenses
    assert (by_id["23"].id, Decimal("4.00")) in expenses
