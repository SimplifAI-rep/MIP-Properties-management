from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

import pandas as pd
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.import_batch import ImportBatch

REQUIRED_COLUMNS = {"account_number", "transaction_date", "amount"}
OPTIONAL_COLUMNS = {"currency", "reference", "description"}
ALL_COLUMNS = REQUIRED_COLUMNS | OPTIONAL_COLUMNS


@dataclass
class RowError:
    row_number: int
    message: str
    account_number: str | None = None

    def to_dict(self) -> dict:
        return {
            "row_number": self.row_number,
            "message": self.message,
            "account_number": self.account_number,
        }


@dataclass
class ImportResult:
    filename: str
    row_count: int
    imported_count: int
    skipped_count: int
    error_count: int
    errors: list[RowError] = field(default_factory=list)
    import_batch_id: uuid.UUID | None = None

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "row_count": self.row_count,
            "imported_count": self.imported_count,
            "skipped_count": self.skipped_count,
            "error_count": self.error_count,
            "errors": [e.to_dict() for e in self.errors],
            "import_batch_id": str(self.import_batch_id) if self.import_batch_id else None,
        }


class BankImportService:
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()

    def parse_excel(self, file: BinaryIO | bytes | Path | str) -> pd.DataFrame:
        if isinstance(file, (str, Path)):
            df = pd.read_excel(file, dtype={"account_number": str})
        elif isinstance(file, bytes):
            df = pd.read_excel(BytesIO(file), dtype={"account_number": str})
        else:
            df = pd.read_excel(file, dtype={"account_number": str})

        df.columns = [str(c).strip().lower() for c in df.columns]
        missing = REQUIRED_COLUMNS - set(df.columns)
        if missing:
            raise ValueError(f"Missing required columns: {', '.join(sorted(missing))}")

        return df

    def import_deposits(
        self,
        file: BinaryIO | bytes | Path | str,
        filename: str | None = None,
    ) -> ImportResult:
        path = Path(file) if isinstance(file, (str, Path)) else None
        resolved_name = filename or (path.name if path else "upload.xlsx")

        df = self.parse_excel(file)
        account_map = self._load_account_map()

        errors: list[RowError] = []
        imported_count = 0
        skipped_count = 0

        batch = ImportBatch(
            filename=resolved_name,
            row_count=len(df),
            imported_count=0,
            error_count=0,
            errors_json=[],
        )
        self.db.add(batch)
        self.db.flush()

        for idx, row in df.iterrows():
            row_number = int(idx) + 2  # Excel header is row 1
            parsed = self._parse_row(row, row_number, account_map, errors)
            if parsed is None:
                continue

            bank_account, transaction_date, amount, currency, reference, description = parsed

            existing = self._find_existing_deposit(
                bank_account.id,
                transaction_date,
                amount,
                reference,
                description,
            )
            if existing:
                skipped_count += 1
                continue

            deposit = Deposit(
                bank_account_id=bank_account.id,
                property_id=bank_account.property_id,
                transaction_date=transaction_date,
                amount=amount,
                currency=currency,
                reference=reference,
                description=description,
                source="excel_import",
                import_batch_id=batch.id,
            )
            self.db.add(deposit)
            imported_count += 1

        batch.imported_count = imported_count
        batch.error_count = len(errors)
        batch.errors_json = [e.to_dict() for e in errors]
        self.db.commit()

        return ImportResult(
            filename=resolved_name,
            row_count=len(df),
            imported_count=imported_count,
            skipped_count=skipped_count,
            error_count=len(errors),
            errors=errors,
            import_batch_id=batch.id,
        )

    def _load_account_map(self) -> dict[str, BankAccount]:
        accounts = self.db.scalars(select(BankAccount)).all()
        return {account.account_number: account for account in accounts}

    def _parse_row(
        self,
        row: pd.Series,
        row_number: int,
        account_map: dict[str, BankAccount],
        errors: list[RowError],
    ) -> tuple[BankAccount, date, Decimal, str, str | None, str | None] | None:
        account_number = self._normalize_account_number(row.get("account_number"))
        if not account_number:
            errors.append(RowError(row_number, "Missing account_number"))
            return None

        bank_account = account_map.get(account_number)
        if bank_account is None:
            errors.append(
                RowError(
                    row_number,
                    f"Unknown account_number: {account_number}",
                    account_number=account_number,
                )
            )
            return None

        transaction_date = self._parse_date(row.get("transaction_date"), row_number, errors)
        if transaction_date is None:
            return None

        amount = self._parse_amount(row.get("amount"), row_number, errors)
        if amount is None:
            return None

        currency = self._parse_optional_str(row.get("currency")) or self.settings.default_currency
        reference = self._parse_optional_str(row.get("reference"))
        description = self._parse_optional_str(row.get("description"))

        return bank_account, transaction_date, amount, currency, reference, description

    def _normalize_account_number(self, value: object) -> str | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        text = str(value).strip()
        return text or None

    def _parse_date(
        self, value: object, row_number: int, errors: list[RowError]
    ) -> date | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            errors.append(RowError(row_number, "Missing transaction_date"))
            return None
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        try:
            parsed = pd.to_datetime(value, errors="coerce")
        except (ValueError, TypeError):
            errors.append(RowError(row_number, f"Invalid transaction_date: {value}"))
            return None
        if pd.isna(parsed):
            errors.append(RowError(row_number, f"Invalid transaction_date: {value}"))
            return None
        return parsed.date()

    def _parse_amount(
        self, value: object, row_number: int, errors: list[RowError]
    ) -> Decimal | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            errors.append(RowError(row_number, "Missing amount"))
            return None
        try:
            amount = Decimal(str(value))
        except (InvalidOperation, ValueError):
            errors.append(RowError(row_number, f"Invalid amount: {value}"))
            return None
        if amount <= 0:
            errors.append(RowError(row_number, f"Amount must be positive, got: {amount}"))
            return None
        return amount.quantize(Decimal("0.01"))

    def _parse_optional_str(self, value: object) -> str | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        text = str(value).strip()
        return text or None

    def _find_existing_deposit(
        self,
        bank_account_id: uuid.UUID,
        transaction_date: date,
        amount: Decimal,
        reference: str | None,
        description: str | None,
    ) -> Deposit | None:
        if reference:
            stmt = select(Deposit).where(
                and_(
                    Deposit.bank_account_id == bank_account_id,
                    Deposit.transaction_date == transaction_date,
                    Deposit.amount == amount,
                    Deposit.reference == reference,
                )
            )
        else:
            stmt = select(Deposit).where(
                and_(
                    Deposit.bank_account_id == bank_account_id,
                    Deposit.transaction_date == transaction_date,
                    Deposit.amount == amount,
                    Deposit.reference.is_(None),
                    Deposit.description == description,
                )
            )
        return self.db.scalars(stmt).first()
