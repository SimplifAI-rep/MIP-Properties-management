from decimal import Decimal
from uuid import uuid4

from app.schemas import DepositRead, ExpenseRead
from app.services.transaction_view import (
    deposit_to_transaction_read,
    expense_to_transaction_read,
    normalize_transaction_row,
)
from app.services.seed import PROPERTY_ROTHSCHILD_ID


def test_deposit_to_transaction_read_rental():
    deposit = DepositRead(
        id=uuid4(),
        property_id=PROPERTY_ROTHSCHILD_ID,
        client_prop_id="TEST-R12",
        property_name="Rothschild 12",
        owner_name="David Cohen",
        transaction_date=None,
        amount=Decimal("1200.00"),
        currency="ILS",
        reference=None,
        description="Rent",
        source="manual",
        is_rental_income=True,
    )
    row = deposit_to_transaction_read(deposit)
    assert row.kind == "deposit"
    assert row.section == "Rental income"
    assert row.notes == "Rent"
    assert row.is_rental_income is True
    assert row.from_bank_statement is False


def test_expense_to_transaction_read_strips_section_prefix():
    expense = ExpenseRead(
        id=uuid4(),
        property_id=PROPERTY_ROTHSCHILD_ID,
        client_prop_id="TEST-R12",
        property_name="Rothschild 12",
        owner_name="David Cohen",
        transaction_date=None,
        amount=Decimal("90.00"),
        currency="ILS",
        category="utilities",
        source="manual",
        payment_method="bank_transfer",
        vendor_name="IEC",
        description="utilities | Monthly bill",
        notes=None,
        paid_by_resident=False,
        paid_by_owner=False,
        paid_by_company=True,
    )
    row = expense_to_transaction_read(expense)
    assert row.kind == "expense"
    assert row.section == "utilities"
    assert row.notes == "Monthly bill"
    assert row.company == "IEC"
    assert row.paid_by_company is True


def test_normalize_transaction_row_dict_parity():
    payload = {
        "id": str(uuid4()),
        "property_id": str(PROPERTY_ROTHSCHILD_ID),
        "client_prop_id": "TEST-R12",
        "property_name": "Rothschild 12",
        "owner_name": "David Cohen",
        "transaction_date": "2026-02-01",
        "amount": "500.00",
        "currency": "ILS",
        "source": "bank_statement",
        "description": "Inflow",
        "is_rental_income": False,
        "needs_review": False,
    }
    row = normalize_transaction_row("deposit", payload)
    assert row["kind"] == "deposit"
    assert row["from_bank_statement"] is True
    assert row["section"] == "bank statement"
