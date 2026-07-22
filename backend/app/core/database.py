from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    settings = get_settings()
    connect_args = {}
    if settings.database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    return create_engine(settings.database_url, connect_args=connect_args)


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_sqlite_upload_nullable_columns()
    _ensure_sqlite_deposit_receipt_ref()
    _ensure_sqlite_source_file_columns()
    _ensure_sqlite_incomplete_transaction_support()


def _ensure_sqlite_deposit_receipt_ref() -> None:
    """Add deposits.receipt_ref for linking file uploads (SQLite only)."""
    settings = get_settings()
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as conn:
        rows = conn.exec_driver_sql("PRAGMA table_info(deposits)").fetchall()
        if not rows:
            return
        cols = {row[1] for row in rows}
        if "receipt_ref" in cols:
            return
        conn.exec_driver_sql("ALTER TABLE deposits ADD COLUMN receipt_ref VARCHAR(100)")


def _ensure_sqlite_source_file_columns() -> None:
    """Add source_file to deposits/expenses for original upload filenames."""
    settings = get_settings()
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as conn:
        for table in ("deposits", "expenses"):
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            if not rows:
                continue
            cols = {row[1] for row in rows}
            if "source_file" not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE {table} ADD COLUMN source_file VARCHAR(255)"
                )


def _ensure_sqlite_incomplete_transaction_support() -> None:
    """Support incomplete Excel imports: nullable dates, needs_review, amount >= 0."""
    settings = get_settings()
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as conn:
        for table in ("deposits", "expenses"):
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            if not rows:
                continue
            cols = {row[1]: row for row in rows}
            if "needs_review" not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE {table} ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT 0"
                )
            if "review_reasons" not in cols:
                conn.exec_driver_sql(
                    f"ALTER TABLE {table} ADD COLUMN review_reasons VARCHAR(255)"
                )

        # Rebuild expenses if date is NOT NULL or old amount > 0 check remains
        _rebuild_expenses_for_incomplete(conn)
        _rebuild_deposits_for_incomplete(conn)


def _rebuild_expenses_for_incomplete(conn) -> None:
    rows = conn.exec_driver_sql("PRAGMA table_info(expenses)").fetchall()
    if not rows:
        return
    cols = {row[1]: row for row in rows}
    date_notnull = bool(cols.get("transaction_date") and cols["transaction_date"][3])
    # Always rebuild once if we still have the old positive-only check name in sqlite_master
    checks = conn.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='expenses'"
    ).fetchone()
    sql = (checks[0] or "") if checks else ""
    needs_rebuild = date_notnull or "amount > 0" in sql or "ck_expenses_amount_positive" in sql
    if not needs_rebuild:
        return

    conn.exec_driver_sql(
        """
        CREATE TABLE IF NOT EXISTS expenses_new (
            id CHAR(36) NOT NULL PRIMARY KEY,
            property_id CHAR(36) NOT NULL,
            transaction_date DATE,
            amount NUMERIC(12, 2) NOT NULL,
            currency VARCHAR(3) NOT NULL,
            category VARCHAR(255) NOT NULL,
            source VARCHAR(50) NOT NULL,
            payment_method VARCHAR(50) NOT NULL,
            vendor_name VARCHAR(255),
            reference VARCHAR(100),
            description TEXT,
            notes TEXT,
            receipt_ref VARCHAR(100),
            reconciled BOOLEAN NOT NULL DEFAULT 0,
            paid_by_resident BOOLEAN NOT NULL DEFAULT 0,
            paid_by_company BOOLEAN NOT NULL DEFAULT 0,
            paid_by_owner BOOLEAN NOT NULL DEFAULT 0,
            ledger_column VARCHAR(50),
            import_key VARCHAR(255),
            source_file VARCHAR(255),
            needs_review BOOLEAN NOT NULL DEFAULT 0,
            review_reasons VARCHAR(255),
            created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            CONSTRAINT ck_expenses_amount_non_negative CHECK (amount >= 0),
            CONSTRAINT uq_expenses_import_key UNIQUE (import_key),
            FOREIGN KEY(property_id) REFERENCES properties (id)
        )
        """
    )
    # Copy whatever columns exist
    existing = {row[1] for row in rows}
    optional = [
        "vendor_name",
        "reference",
        "description",
        "notes",
        "receipt_ref",
        "ledger_column",
        "import_key",
        "source_file",
        "needs_review",
        "review_reasons",
        "paid_by_resident",
        "paid_by_company",
        "paid_by_owner",
        "reconciled",
        "created_at",
        "updated_at",
    ]
    select_cols = [
        "id",
        "property_id",
        "transaction_date",
        "amount",
        "currency",
        "category",
        "source",
        "payment_method",
    ]
    for col in optional:
        if col in existing:
            select_cols.append(col)

    insert_cols = list(select_cols)
    # Ensure defaults for new cols if missing from old table
    for col, default in (
        ("needs_review", "0"),
        ("review_reasons", "NULL"),
        ("paid_by_resident", "0"),
        ("paid_by_company", "0"),
        ("paid_by_owner", "0"),
        ("reconciled", "0"),
    ):
        if col not in existing:
            select_cols.append(default)
            insert_cols.append(col)

    conn.exec_driver_sql(
        f"""
        INSERT INTO expenses_new ({", ".join(insert_cols)})
        SELECT {", ".join(select_cols)} FROM expenses
        """
    )
    conn.exec_driver_sql("DROP TABLE expenses")
    conn.exec_driver_sql("ALTER TABLE expenses_new RENAME TO expenses")


def _rebuild_deposits_for_incomplete(conn) -> None:
    rows = conn.exec_driver_sql("PRAGMA table_info(deposits)").fetchall()
    if not rows:
        return
    cols = {row[1]: row for row in rows}
    date_notnull = bool(cols.get("transaction_date") and cols["transaction_date"][3])
    if not date_notnull and "needs_review" in cols:
        return

    existing = {row[1] for row in rows}
    conn.exec_driver_sql(
        """
        CREATE TABLE IF NOT EXISTS deposits_new (
            id CHAR(36) NOT NULL PRIMARY KEY,
            bank_account_id CHAR(36),
            property_id CHAR(36) NOT NULL,
            transaction_date DATE,
            amount NUMERIC(12, 2) NOT NULL,
            currency VARCHAR(3) NOT NULL,
            reference VARCHAR(100),
            description TEXT,
            source VARCHAR(50) NOT NULL,
            import_batch_id CHAR(36),
            is_rental_income BOOLEAN NOT NULL DEFAULT 0,
            import_key VARCHAR(255),
            receipt_ref VARCHAR(100),
            source_file VARCHAR(255),
            needs_review BOOLEAN NOT NULL DEFAULT 0,
            review_reasons VARCHAR(255),
            created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            updated_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            CONSTRAINT uq_deposits_import_key UNIQUE (import_key),
            FOREIGN KEY(bank_account_id) REFERENCES bank_accounts (id),
            FOREIGN KEY(property_id) REFERENCES properties (id),
            FOREIGN KEY(import_batch_id) REFERENCES import_batches (id)
        )
        """
    )
    base = [
        "id",
        "bank_account_id",
        "property_id",
        "transaction_date",
        "amount",
        "currency",
        "reference",
        "description",
        "source",
        "import_batch_id",
        "is_rental_income",
        "import_key",
        "receipt_ref",
        "source_file",
        "created_at",
        "updated_at",
    ]
    select_parts = []
    insert_parts = []
    for col in base:
        if col in existing:
            select_parts.append(col)
            insert_parts.append(col)
    insert_parts.extend(["needs_review", "review_reasons"])
    select_parts.extend(
        [
            "needs_review" if "needs_review" in existing else "0",
            "review_reasons" if "review_reasons" in existing else "NULL",
        ]
    )
    conn.exec_driver_sql(
        f"""
        INSERT INTO deposits_new ({", ".join(insert_parts)})
        SELECT {", ".join(select_parts)} FROM deposits
        """
    )
    conn.exec_driver_sql("DROP TABLE deposits")
    conn.exec_driver_sql("ALTER TABLE deposits_new RENAME TO deposits")


def _ensure_sqlite_upload_nullable_columns() -> None:
    """Allow pending image/PDF uploads before a property is matched (SQLite only)."""
    settings = get_settings()
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as conn:
        rows = conn.exec_driver_sql("PRAGMA table_info(uploaded_documents)").fetchall()
        if not rows:
            return
        # Rebuild table if property_id / owner_id are still NOT NULL
        cols = {row[1]: row for row in rows}
        property_notnull = bool(cols.get("property_id") and cols["property_id"][3])
        owner_notnull = bool(cols.get("owner_id") and cols["owner_id"][3])
        if not property_notnull and not owner_notnull:
            return

        conn.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS uploaded_documents_new (
                id CHAR(36) NOT NULL PRIMARY KEY,
                property_id CHAR(36),
                owner_id CHAR(36),
                filename VARCHAR(255) NOT NULL,
                stored_path VARCHAR(500) NOT NULL,
                mime_type VARCHAR(100) NOT NULL,
                transaction_type VARCHAR(20) NOT NULL,
                status VARCHAR(30) NOT NULL,
                parser VARCHAR(50),
                extraction_json JSON,
                confirmed_json JSON,
                created_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
                FOREIGN KEY(property_id) REFERENCES properties (id),
                FOREIGN KEY(owner_id) REFERENCES owners (id)
            )
            """
        )
        conn.exec_driver_sql(
            """
            INSERT INTO uploaded_documents_new (
                id, property_id, owner_id, filename, stored_path, mime_type,
                transaction_type, status, parser, extraction_json, confirmed_json,
                created_at
            )
            SELECT
                id, property_id, owner_id, filename, stored_path, mime_type,
                transaction_type, status, parser, extraction_json, confirmed_json,
                created_at
            FROM uploaded_documents
            """
        )
        conn.exec_driver_sql("DROP TABLE uploaded_documents")
        conn.exec_driver_sql(
            "ALTER TABLE uploaded_documents_new RENAME TO uploaded_documents"
        )
