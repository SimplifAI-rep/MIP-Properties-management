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
