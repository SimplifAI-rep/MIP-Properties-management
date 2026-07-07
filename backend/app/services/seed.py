import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.bank_account import BankAccount
from app.models.expected_deposit import ExpectedDeposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property

# Fixed UUIDs for reproducible seed data
OWNER_DAVID_ID = uuid.UUID("a0000000-0000-4000-8000-000000000001")
OWNER_SARAH_ID = uuid.UUID("a0000000-0000-4000-8000-000000000002")

PROPERTY_ROTHSCHILD_ID = uuid.UUID("b0000000-0000-4000-8000-000000000001")
PROPERTY_DIZENGOFF_ID = uuid.UUID("b0000000-0000-4000-8000-000000000002")
PROPERTY_HERZL_ID = uuid.UUID("b0000000-0000-4000-8000-000000000003")

ACCOUNT_ROTHSCHILD = "12-345-678901"
ACCOUNT_DIZENGOFF = "12-345-678902"
ACCOUNT_HERZL = "99-888-777001"


def seed_reference_data(db: Session) -> dict[str, int]:
    """Populate owners, properties, bank accounts, and expected deposits."""
    counts = {"owners": 0, "properties": 0, "bank_accounts": 0, "expected_deposits": 0}

    if db.query(Owner).count() == 0:
        db.add_all(
            [
                Owner(
                    id=OWNER_DAVID_ID,
                    name="David Cohen",
                    contact_email="david.cohen@example.com",
                    contact_phone="+972-50-123-4567",
                ),
                Owner(
                    id=OWNER_SARAH_ID,
                    name="Sarah Levi",
                    contact_email="sarah.levi@example.com",
                    contact_phone="+972-52-987-6543",
                ),
            ]
        )
        counts["owners"] = 2

    if db.query(Property).count() == 0:
        db.add_all(
            [
                Property(
                    id=PROPERTY_ROTHSCHILD_ID,
                    owner_id=OWNER_DAVID_ID,
                    name="Rothschild 12",
                    address="12 Rothschild Blvd, Tel Aviv",
                    status="active",
                ),
                Property(
                    id=PROPERTY_DIZENGOFF_ID,
                    owner_id=OWNER_DAVID_ID,
                    name="Dizengoff 45",
                    address="45 Dizengoff St, Tel Aviv",
                    status="active",
                ),
                Property(
                    id=PROPERTY_HERZL_ID,
                    owner_id=OWNER_SARAH_ID,
                    name="Herzl 8",
                    address="8 Herzl St, Haifa",
                    status="active",
                ),
            ]
        )
        counts["properties"] = 3

    if db.query(BankAccount).count() == 0:
        db.add_all(
            [
                BankAccount(
                    property_id=PROPERTY_ROTHSCHILD_ID,
                    bank_name="Bank Leumi",
                    account_number=ACCOUNT_ROTHSCHILD,
                    currency="ILS",
                ),
                BankAccount(
                    property_id=PROPERTY_DIZENGOFF_ID,
                    bank_name="Bank Leumi",
                    account_number=ACCOUNT_DIZENGOFF,
                    currency="ILS",
                ),
                BankAccount(
                    property_id=PROPERTY_HERZL_ID,
                    bank_name="Bank Hapoalim",
                    account_number=ACCOUNT_HERZL,
                    currency="ILS",
                ),
            ]
        )
        counts["bank_accounts"] = 3

    if db.query(ExpectedDeposit).count() == 0:
        db.add_all(
            [
                ExpectedDeposit(
                    property_id=PROPERTY_ROTHSCHILD_ID,
                    amount=Decimal("8500.00"),
                    frequency="monthly",
                    due_day=5,
                ),
                ExpectedDeposit(
                    property_id=PROPERTY_DIZENGOFF_ID,
                    amount=Decimal("6200.00"),
                    frequency="monthly",
                    due_day=5,
                ),
                ExpectedDeposit(
                    property_id=PROPERTY_HERZL_ID,
                    amount=Decimal("4800.00"),
                    frequency="monthly",
                    due_day=10,
                ),
            ]
        )
        counts["expected_deposits"] = 3

    db.commit()
    return counts


def seed_sample_expenses(db: Session) -> int:
    """Populate sample expenses across properties if none exist."""
    if db.query(Expense).count() > 0:
        return 0

    samples = [
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 1, 15),
            amount=Decimal("420.50"),
            category="utilities",
            source="standing_order",
            payment_method="bank_direct_debit",
            vendor_name="Israel Electric Corp",
            reference="SO-EL-202601",
            description="Monthly electricity standing order",
        ),
        Expense(
            property_id=PROPERTY_ROTHSCHILD_ID,
            transaction_date=date(2026, 2, 8),
            amount=Decimal("1250.00"),
            category="maintenance",
            source="manual_company",
            payment_method="company_account",
            vendor_name="TLV Plumbing Ltd",
            description="Pipe repair — paid by management company",
        ),
        Expense(
            property_id=PROPERTY_DIZENGOFF_ID,
            transaction_date=date(2026, 1, 20),
            amount=Decimal("890.00"),
            category="insurance",
            source="credit_card",
            payment_method="credit_card",
            vendor_name="Harel Insurance",
            reference="CC-44821",
            description="Building insurance annual installment",
        ),
        Expense(
            property_id=PROPERTY_DIZENGOFF_ID,
            transaction_date=date(2026, 3, 5),
            amount=Decimal("310.00"),
            category="utilities",
            source="standing_order",
            payment_method="bank_direct_debit",
            vendor_name="Municipal Water",
            reference="SO-WATER-03",
            description="Water utility standing order",
        ),
        Expense(
            property_id=PROPERTY_HERZL_ID,
            transaction_date=date(2026, 1, 28),
            amount=Decimal("2100.00"),
            category="tax",
            source="manual_owner",
            payment_method="owner_personal",
            vendor_name="Haifa Municipality",
            description="Arnona property tax — owner paid personally",
        ),
        Expense(
            property_id=PROPERTY_HERZL_ID,
            transaction_date=date(2026, 2, 14),
            amount=Decimal("650.00"),
            category="management_fee",
            source="manual_company",
            payment_method="bank_transfer",
            vendor_name="SimplifAI Management",
            description="Monthly management fee",
        ),
    ]
    db.add_all(samples)
    db.commit()
    return len(samples)
