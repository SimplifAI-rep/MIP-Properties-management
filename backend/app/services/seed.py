import uuid
from decimal import Decimal

from sqlalchemy.orm import Session

from app.models.bank_account import BankAccount
from app.models.expected_deposit import ExpectedDeposit
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
