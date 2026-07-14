"""Seed database from client Excel files on first run."""

from __future__ import annotations

import logging

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.services.client_import import CLIENT_DATA_DIR, import_client_data

logger = logging.getLogger(__name__)


def bootstrap_database(db: Session) -> None:
    """Load client Excel data when the database has no owners yet."""
    owner_count = db.scalar(select(func.count()).select_from(Owner)) or 0
    deposit_count = db.scalar(select(func.count()).select_from(Deposit)) or 0
    expense_count = db.scalar(select(func.count()).select_from(Expense)) or 0

    if owner_count > 0:
        logger.info(
            "Database already has %s owner(s), %s deposit(s), %s expense(s) — skipping client bootstrap",
            owner_count,
            deposit_count,
            expense_count,
        )
        return

    if not CLIENT_DATA_DIR.exists():
        logger.warning("Client data directory missing at %s — skipping bootstrap", CLIENT_DATA_DIR)
        return

    logger.info("Bootstrapping database from client Excel files in %s", CLIENT_DATA_DIR)
    stats = import_client_data(db)
    logger.info(
        "Client import complete: owners=%s properties=%s expenses=%s deposits=%s warnings=%s errors=%s",
        stats.owners_created,
        stats.properties_created,
        stats.expenses_created,
        stats.deposits_created,
        len(stats.warnings),
        len(stats.errors),
    )
    for err in stats.errors:
        logger.error("Client import error: %s", err)
    for warn in stats.warnings[:20]:
        logger.warning("Client import warning: %s", warn)
