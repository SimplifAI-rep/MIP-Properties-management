"""Seed database with sample data on first run (local dev and production)."""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import PROJECT_ROOT
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.services.bank_import import BankImportService
from app.services.seed import seed_reference_data, seed_sample_expenses

logger = logging.getLogger(__name__)

SEED_EXCEL = PROJECT_ROOT / "data" / "seed" / "bank_deposits.xlsx"


def bootstrap_database(db: Session) -> None:
    """Populate reference data, deposits, and expenses when tables are empty."""
    owner_count = db.scalar(select(func.count()).select_from(Owner)) or 0
    deposit_count = db.scalar(select(func.count()).select_from(Deposit)) or 0
    expense_count = db.scalar(select(func.count()).select_from(Expense)) or 0

    if owner_count == 0:
        logger.info("Bootstrapping owners, properties, and bank accounts...")
        seed_reference_data(db)
    else:
        logger.info("Database already has %s owner(s) — skipping reference seed", owner_count)

    if deposit_count == 0:
        if not SEED_EXCEL.exists():
            logger.warning("Seed Excel not found at %s — skipping deposit import", SEED_EXCEL)
        else:
            logger.info("Importing sample bank deposits from %s", SEED_EXCEL.name)
            result = BankImportService(db).import_deposits(SEED_EXCEL)
            logger.info(
                "Imported %s deposit(s) (%s skipped, %s errors)",
                result.imported_count,
                result.skipped_count,
                result.error_count,
            )
    else:
        logger.info("Database already has %s deposit(s) — skipping deposit import", deposit_count)

    if expense_count == 0:
        added = seed_sample_expenses(db)
        if added:
            logger.info("Seeded %s sample expense(s)", added)
    else:
        logger.info("Database already has %s expense(s) — skipping expense seed", expense_count)
