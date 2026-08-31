from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.services.seed import (
    PROPERTY_ROTHSCHILD_ID,
    seed_reference_data,
    seed_sample_expenses,
)
from app.services.transaction_ref import (
    allocate_transaction_ref,
    backfill_missing_transaction_refs,
    register_transaction_ref_listeners,
)


def _session():
    register_transaction_ref_listeners()
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    seed_reference_data(session)
    return session


def test_allocate_transaction_ref_is_date_based_and_sequential():
    db = _session()
    r1 = allocate_transaction_ref(db, date(2026, 7, 8))
    r2 = allocate_transaction_ref(db, date(2026, 7, 8))
    assert r1 == "20260708-0001"
    assert r2 == "20260708-0002"
    db.close()


def test_before_insert_assigns_transaction_ref():
    db = _session()
    expense = Expense(
        property_id=PROPERTY_ROTHSCHILD_ID,
        transaction_date=date(2026, 3, 15),
        amount=10,
        currency="ILS",
        category="other",
        source="manual_company",
        payment_method="company_account",
    )
    db.add(expense)
    db.commit()
    db.refresh(expense)
    assert expense.transaction_ref is not None
    assert expense.transaction_ref.startswith("20260315-")
    db.close()


def test_backfill_assigns_refs_to_existing_rows():
    register_transaction_ref_listeners()
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    seed_reference_data(db)
    seed_sample_expenses(db)

    # Simulate legacy rows without refs (bypass listener by bulk update)
    db.query(Expense).update({Expense.transaction_ref: None})
    db.query(Deposit).update({Deposit.transaction_ref: None})
    db.commit()
    # Clear session seq cache so backfill re-reads DB max (0)
    db.info.clear()

    updated = backfill_missing_transaction_refs(db)
    assert updated >= 6
    expenses = db.query(Expense).all()
    assert all(e.transaction_ref for e in expenses)
    refs = [e.transaction_ref for e in expenses]
    assert len(refs) == len(set(refs))
    db.close()
