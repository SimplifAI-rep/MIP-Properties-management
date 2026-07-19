from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.services.running_balance import compute_running_balances


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


def test_running_balance_matches_company_float_net(db):
    owner = Owner(id=uuid4(), name="Owner A")
    prop = Property(
        id=uuid4(),
        owner_id=owner.id,
        client_prop_id="P1",
        name="Prop 1",
        status="active",
    )
    db.add_all([owner, prop])
    db.flush()

    d1 = Deposit(
        property_id=prop.id,
        transaction_date=date(2026, 1, 1),
        amount=Decimal("1000.00"),
        currency="ILS",
        source="management_ledger",
        is_rental_income=False,
    )
    e1 = Expense(
        property_id=prop.id,
        transaction_date=date(2026, 1, 2),
        amount=Decimal("200.00"),
        currency="ILS",
        category="maintenance",
        source="management_ledger",
        payment_method="company_account",
        paid_by_resident=False,
        paid_by_owner=False,
    )
    # Resident-paid should not change company float balance
    e2 = Expense(
        property_id=prop.id,
        transaction_date=date(2026, 1, 3),
        amount=Decimal("50.00"),
        currency="ILS",
        category="utilities",
        source="manual_owner",
        payment_method="owner_personal",
        paid_by_resident=True,
    )
    # Rental income should not change company float balance
    d2 = Deposit(
        property_id=prop.id,
        transaction_date=date(2026, 1, 4),
        amount=Decimal("3000.00"),
        currency="ILS",
        source="rental_income",
        is_rental_income=True,
    )
    e3 = Expense(
        property_id=prop.id,
        transaction_date=date(2026, 1, 5),
        amount=Decimal("100.00"),
        currency="ILS",
        category="tax",
        source="manual_company",
        payment_method="company_account",
        paid_by_company=True,
    )
    db.add_all([d1, e1, e2, d2, e3])
    db.commit()

    balances = compute_running_balances(db, [prop.id])
    assert balances[("deposit", str(d1.id))] == Decimal("1000.00")
    assert balances[("expense", str(e1.id))] == Decimal("800.00")
    assert balances[("expense", str(e2.id))] == Decimal("800.00")  # unchanged
    assert balances[("deposit", str(d2.id))] == Decimal("800.00")  # unchanged
    assert balances[("expense", str(e3.id))] == Decimal("700.00")  # MIP counts
