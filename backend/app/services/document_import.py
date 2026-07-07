from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import Literal
from uuid import UUID

import httpx
import pandas as pd
from fastapi import HTTPException
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.expense import (
    EXPENSE_CATEGORIES,
    EXPENSE_SOURCES,
    PAYMENT_METHODS,
    Expense,
)
from app.models.owner import Owner
from app.models.property import Property
from app.models.uploaded_document import UploadedDocument
from app.schemas import (
    FieldWarning,
    TransactionDraft,
    UploadAnalyzeResponse,
    UploadConfirmRequest,
    UploadConfirmResponse,
)
from app.services.bank_import import BankImportService, RowError
from app.services.document_storage import get_storage_root
from app.services.expense_query import _validate_expense_enums

logger = logging.getLogger(__name__)

DEPOSIT_EXCEL_COLUMNS = {"account_number", "transaction_date", "amount"}
EXPENSE_EXCEL_COLUMNS = {"transaction_date", "amount"}


@dataclass
class AnalyzeContext:
    property_id: UUID
    owner_id: UUID
    transaction_type: Literal["deposit", "expense"]
    filename: str
    mime_type: str


class DocumentImportService:
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()
        self.bank_import = BankImportService(db)

    def create_upload(
        self,
        *,
        property_id: UUID,
        transaction_type: Literal["deposit", "expense"],
        filename: str,
        stored_path: str,
        mime_type: str,
    ) -> UploadedDocument:
        property_row = self.db.get(Property, property_id)
        if not property_row:
            raise HTTPException(status_code=404, detail="Property not found")

        owner = self.db.get(Owner, property_row.owner_id)
        if not owner:
            raise HTTPException(status_code=404, detail="Owner not found")

        document = UploadedDocument(
            property_id=property_id,
            owner_id=owner.id,
            filename=filename,
            stored_path=stored_path,
            mime_type=mime_type,
            transaction_type=transaction_type,
            status="pending_review",
        )
        self.db.add(document)
        self.db.flush()
        return document

    def analyze(
        self,
        document: UploadedDocument,
        content: bytes,
    ) -> UploadAnalyzeResponse:
        ctx = AnalyzeContext(
            property_id=document.property_id,
            owner_id=document.owner_id,
            transaction_type=document.transaction_type,  # type: ignore[arg-type]
            filename=document.filename,
            mime_type=document.mime_type,
        )

        suffix = Path(document.filename).suffix.lower()
        drafts: list[TransactionDraft] = []
        parser = "manual"
        message: str | None = None

        if suffix in {".xlsx", ".xls", ".csv"}:
            drafts, parser, message = self._analyze_spreadsheet(content, ctx, suffix)
        elif document.mime_type.startswith("image/"):
            drafts, parser, message = self._analyze_image(content, ctx)
        elif suffix == ".pdf":
            drafts, parser, message = self._analyze_pdf(content, ctx)
        else:
            drafts = [self._manual_draft(ctx, "Unsupported file format. Enter details manually.")]
            message = "Unsupported file format."

        document.parser = parser
        document.extraction_json = {
            "drafts": [draft.model_dump(mode="json") for draft in drafts],
            "message": message,
        }
        self.db.commit()

        ready_count = sum(1 for draft in drafts if draft.status == "ready")
        review_count = sum(1 for draft in drafts if draft.status == "needs_review")
        error_count = sum(1 for draft in drafts if draft.status == "error")

        return UploadAnalyzeResponse(
            upload_id=document.id,
            filename=document.filename,
            property_id=document.property_id,
            owner_id=document.owner_id,
            transaction_type=document.transaction_type,  # type: ignore[arg-type]
            parser=parser,
            message=message,
            drafts=drafts,
            ready_count=ready_count,
            needs_review_count=review_count,
            error_count=error_count,
        )

    def confirm(
        self,
        document_id: UUID,
        payload: UploadConfirmRequest,
    ) -> UploadConfirmResponse:
        document = self.db.get(UploadedDocument, document_id)
        if not document:
            raise HTTPException(status_code=404, detail="Upload not found")
        if document.status == "confirmed":
            raise HTTPException(status_code=400, detail="Upload already confirmed")

        imported_deposit_ids: list[str] = []
        imported_expense_ids: list[str] = []
        skipped_count = 0
        errors: list[str] = []

        for index, draft in enumerate(payload.drafts):
            try:
                if draft.transaction_type == "deposit":
                    deposit_id = self._confirm_deposit(document, draft)
                    if deposit_id:
                        imported_deposit_ids.append(str(deposit_id))
                    else:
                        skipped_count += 1
                else:
                    expense_id = self._confirm_expense(document, draft)
                    imported_expense_ids.append(str(expense_id))
            except HTTPException as exc:
                errors.append(f"Row {index + 1}: {exc.detail}")
            except ValueError as exc:
                errors.append(f"Row {index + 1}: {exc}")

        if errors and not imported_deposit_ids and not imported_expense_ids:
            raise HTTPException(status_code=400, detail="; ".join(errors))

        document.status = "confirmed"
        document.confirmed_json = {
            "deposit_ids": imported_deposit_ids,
            "expense_ids": imported_expense_ids,
            "skipped_count": skipped_count,
            "errors": errors,
        }
        self.db.commit()

        return UploadConfirmResponse(
            upload_id=document.id,
            imported_deposit_count=len(imported_deposit_ids),
            imported_expense_count=len(imported_expense_ids),
            skipped_count=skipped_count,
            errors=errors,
        )

    def _analyze_spreadsheet(
        self,
        content: bytes,
        ctx: AnalyzeContext,
        suffix: str,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        if ctx.transaction_type == "deposit":
            return self._analyze_deposit_excel(content, ctx)
        return self._analyze_expense_excel(content, ctx, suffix)

    def _analyze_deposit_excel(
        self,
        content: bytes,
        ctx: AnalyzeContext,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        try:
            df = self.bank_import.parse_excel(content)
        except ValueError as exc:
            draft = self._manual_draft(ctx, str(exc))
            return [draft], "excel", str(exc)

        account_map = self.bank_import._load_account_map()
        errors: list[RowError] = []
        drafts: list[TransactionDraft] = []

        for idx, row in df.iterrows():
            row_number = int(idx) + 2
            parsed = self.bank_import._parse_row(row, row_number, account_map, errors)
            warnings: list[FieldWarning] = []

            if parsed is None:
                row_errors = [e for e in errors if e.row_number == row_number]
                message = row_errors[-1].message if row_errors else "Could not parse row"
                drafts.append(
                    TransactionDraft(
                        row_number=row_number,
                        transaction_type="deposit",
                        property_id=ctx.property_id,
                        status="error",
                        warnings=[
                            FieldWarning(field="row", message=message, severity="error")
                        ],
                    )
                )
                continue

            bank_account, transaction_date, amount, currency, reference, description = parsed
            account_number = bank_account.account_number

            if bank_account.property_id != ctx.property_id:
                warnings.append(
                    FieldWarning(
                        field="account_number",
                        message=(
                            f"Account {account_number} belongs to a different property. "
                            "Verify before confirming."
                        ),
                        severity="warning",
                    )
                )

            existing = self.bank_import._find_existing_deposit(
                bank_account.id,
                transaction_date,
                amount,
                reference,
                description,
            )
            if existing:
                warnings.append(
                    FieldWarning(
                        field="amount",
                        message="Possible duplicate deposit already in the system.",
                        severity="warning",
                    )
                )

            status = "ready" if not warnings else "needs_review"
            drafts.append(
                TransactionDraft(
                    row_number=row_number,
                    transaction_type="deposit",
                    property_id=ctx.property_id,
                    bank_account_id=bank_account.id,
                    account_number=account_number,
                    transaction_date=transaction_date,
                    amount=amount,
                    currency=currency,
                    reference=reference,
                    description=description,
                    status=status,
                    warnings=warnings,
                )
            )

        if not drafts:
            return [self._manual_draft(ctx, "No rows found in spreadsheet.")], "excel", "No rows found."

        message = None
        if errors:
            message = f"{len(errors)} row(s) had parse errors."

        return drafts, "excel", message

    def _analyze_expense_excel(
        self,
        content: bytes,
        ctx: AnalyzeContext,
        suffix: str,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        try:
            if suffix == ".csv":
                df = pd.read_csv(BytesIO(content))
            else:
                df = pd.read_excel(BytesIO(content))
        except Exception as exc:
            draft = self._manual_draft(ctx, f"Could not read spreadsheet: {exc}")
            return [draft], "excel", str(exc)

        df.columns = [str(column).strip().lower() for column in df.columns]
        missing = EXPENSE_EXCEL_COLUMNS - set(df.columns)
        if missing:
            message = f"Missing required columns: {', '.join(sorted(missing))}"
            return [self._manual_draft(ctx, message)], "excel", message

        drafts: list[TransactionDraft] = []
        for idx, row in df.iterrows():
            row_number = int(idx) + 2
            draft = self._parse_expense_row(row, row_number, ctx)
            drafts.append(draft)

        if not drafts:
            return [self._manual_draft(ctx, "No rows found in spreadsheet.")], "excel", "No rows found."

        return drafts, "excel", None

    def _parse_expense_row(
        self,
        row: pd.Series,
        row_number: int,
        ctx: AnalyzeContext,
    ) -> TransactionDraft:
        warnings: list[FieldWarning] = []

        transaction_date = self._parse_optional_date(row.get("transaction_date"), "transaction_date", warnings)
        amount = self._parse_optional_amount(row.get("amount"), warnings)
        currency = self._optional_str(row.get("currency")) or self.settings.default_currency
        category = self._optional_str(row.get("category")) or "other"
        source = self._optional_str(row.get("source")) or "manual_company"
        payment_method = self._optional_str(row.get("payment_method")) or "company_account"
        vendor_name = self._optional_str(row.get("vendor_name"))
        reference = self._optional_str(row.get("reference"))
        description = self._optional_str(row.get("description"))

        if category not in EXPENSE_CATEGORIES:
            warnings.append(
                FieldWarning(
                    field="category",
                    message=f"Unknown category '{category}'. Choose a valid category.",
                    severity="warning",
                )
            )
        if source not in EXPENSE_SOURCES:
            warnings.append(
                FieldWarning(
                    field="source",
                    message=f"Unknown source '{source}'. Choose a valid source.",
                    severity="warning",
                )
            )
        if payment_method not in PAYMENT_METHODS:
            warnings.append(
                FieldWarning(
                    field="payment_method",
                    message=f"Unknown payment method '{payment_method}'. Choose a valid option.",
                    severity="warning",
                )
            )

        if transaction_date is None:
            warnings.append(
                FieldWarning(field="transaction_date", message="Missing transaction date.", severity="error")
            )
        if amount is None:
            warnings.append(FieldWarning(field="amount", message="Missing or invalid amount.", severity="error"))

        has_errors = any(w.severity == "error" for w in warnings)
        status = "error" if has_errors else ("needs_review" if warnings else "ready")

        return TransactionDraft(
            row_number=row_number,
            transaction_type="expense",
            property_id=ctx.property_id,
            transaction_date=transaction_date,
            amount=amount,
            currency=currency,
            category=category,
            source=source,
            payment_method=payment_method,
            vendor_name=vendor_name,
            reference=reference,
            description=description,
            status=status,
            warnings=warnings,
        )

    def _analyze_image(
        self,
        content: bytes,
        ctx: AnalyzeContext,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        if not self.settings.llm_api_key:
            draft = self._manual_draft(
                ctx,
                "AI extraction requires LLM_API_KEY. Fill in the fields manually.",
            )
            return [draft], "manual", "LLM_API_KEY not configured."

        try:
            draft = self._extract_with_llm(content, ctx, is_image=True)
            return [draft], "llm", None
        except Exception as exc:
            logger.exception("LLM image extraction failed")
            draft = self._manual_draft(ctx, f"AI extraction failed: {exc}")
            return [draft], "manual", str(exc)

    def _analyze_pdf(
        self,
        content: bytes,
        ctx: AnalyzeContext,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        if not self.settings.llm_api_key:
            draft = self._manual_draft(
                ctx,
                "PDF extraction requires LLM_API_KEY. Fill in the fields manually or upload Excel.",
            )
            return [draft], "manual", "LLM_API_KEY not configured."

        try:
            draft = self._extract_with_llm(content, ctx, is_image=False)
            return [draft], "llm", None
        except Exception as exc:
            logger.exception("LLM PDF extraction failed")
            draft = self._manual_draft(ctx, f"AI extraction failed: {exc}")
            return [draft], "manual", str(exc)

    def _extract_with_llm(
        self,
        content: bytes,
        ctx: AnalyzeContext,
        *,
        is_image: bool,
    ) -> TransactionDraft:
        system_prompt = (
            "Extract a single property transaction from the document. "
            "Return JSON with keys: transaction_date (YYYY-MM-DD or null), amount (number or null), "
            "currency (3-letter code), reference, description, vendor_name, category, source, "
            "payment_method, account_number, confidence (high|medium|low), missing_fields (array of strings). "
            f"Transaction type is {ctx.transaction_type}. "
            "Use null for fields you cannot determine."
        )

        if is_image:
            media_type = ctx.mime_type
            encoded = base64.b64encode(content).decode("ascii")
            user_content: list[dict] | str = [
                {"type": "text", "text": f"Extract {ctx.transaction_type} details from this receipt or document."},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{media_type};base64,{encoded}"},
                },
            ]
        else:
            encoded = base64.b64encode(content).decode("ascii")
            user_content = (
                f"Extract {ctx.transaction_type} details from this PDF document. "
                f"Base64 PDF content: {encoded[:500]}... (truncated)"
            )

        payload = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        }
        response = httpx.post(
            f"{self.settings.llm_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self.settings.llm_api_key}"},
            json=payload,
            timeout=60.0,
        )
        response.raise_for_status()
        data = json.loads(response.json()["choices"][0]["message"]["content"])
        return self._draft_from_llm(data, ctx)

    def _draft_from_llm(self, data: dict, ctx: AnalyzeContext) -> TransactionDraft:
        warnings: list[FieldWarning] = []
        missing_fields = data.get("missing_fields") or []

        for field_name in missing_fields:
            warnings.append(
                FieldWarning(
                    field=str(field_name),
                    message="AI could not determine this field.",
                    severity="warning",
                )
            )

        confidence = str(data.get("confidence") or "low").lower()
        if confidence == "low":
            warnings.append(
                FieldWarning(
                    field="document",
                    message="Low confidence extraction — please verify all fields.",
                    severity="warning",
                )
            )

        transaction_date = self._parse_optional_date(
            data.get("transaction_date"),
            "transaction_date",
            warnings,
        )
        amount = self._parse_optional_amount(data.get("amount"), warnings)

        if ctx.transaction_type == "deposit":
            account_number = self._optional_str(data.get("account_number"))
            bank_account_id = None
            if account_number:
                account = self.db.scalars(
                    select(BankAccount).where(BankAccount.account_number == account_number)
                ).first()
                if account:
                    bank_account_id = account.id
                    if account.property_id != ctx.property_id:
                        warnings.append(
                            FieldWarning(
                                field="account_number",
                                message="Account belongs to a different property.",
                                severity="warning",
                            )
                        )
                else:
                    warnings.append(
                        FieldWarning(
                            field="account_number",
                            message=f"Unknown account number: {account_number}",
                            severity="error",
                        )
                    )
            else:
                warnings.append(
                    FieldWarning(
                        field="account_number",
                        message="Missing bank account number.",
                        severity="error",
                    )
                )

            if transaction_date is None:
                warnings.append(
                    FieldWarning(field="transaction_date", message="Missing transaction date.", severity="error")
                )
            if amount is None:
                warnings.append(FieldWarning(field="amount", message="Missing amount.", severity="error"))

            has_errors = any(w.severity == "error" for w in warnings)
            status = "error" if has_errors else ("needs_review" if warnings else "ready")

            return TransactionDraft(
                transaction_type="deposit",
                property_id=ctx.property_id,
                bank_account_id=bank_account_id,
                account_number=account_number,
                transaction_date=transaction_date,
                amount=amount,
                currency=self._optional_str(data.get("currency")) or self.settings.default_currency,
                reference=self._optional_str(data.get("reference")),
                description=self._optional_str(data.get("description")),
                status=status,
                warnings=warnings,
            )

        category = self._optional_str(data.get("category")) or "other"
        source = self._optional_str(data.get("source")) or "manual_company"
        payment_method = self._optional_str(data.get("payment_method")) or "company_account"

        if transaction_date is None:
            warnings.append(
                FieldWarning(field="transaction_date", message="Missing transaction date.", severity="error")
            )
        if amount is None:
            warnings.append(FieldWarning(field="amount", message="Missing amount.", severity="error"))

        has_errors = any(w.severity == "error" for w in warnings)
        status = "error" if has_errors else ("needs_review" if warnings else "ready")

        return TransactionDraft(
            transaction_type="expense",
            property_id=ctx.property_id,
            transaction_date=transaction_date,
            amount=amount,
            currency=self._optional_str(data.get("currency")) or self.settings.default_currency,
            category=category,
            source=source,
            payment_method=payment_method,
            vendor_name=self._optional_str(data.get("vendor_name")),
            reference=self._optional_str(data.get("reference")),
            description=self._optional_str(data.get("description")),
            status=status,
            warnings=warnings,
        )

    def _manual_draft(self, ctx: AnalyzeContext, message: str) -> TransactionDraft:
        return TransactionDraft(
            transaction_type=ctx.transaction_type,
            property_id=ctx.property_id,
            status="needs_review",
            warnings=[
                FieldWarning(field="document", message=message, severity="warning"),
            ],
        )

    def _confirm_deposit(self, document: UploadedDocument, draft: TransactionDraft) -> UUID | None:
        if not draft.bank_account_id:
            raise HTTPException(status_code=400, detail="bank_account_id is required for deposits")
        if not draft.transaction_date or not draft.amount:
            raise HTTPException(status_code=400, detail="transaction_date and amount are required")

        bank_account = self.db.get(BankAccount, draft.bank_account_id)
        if not bank_account:
            raise HTTPException(status_code=400, detail="Invalid bank_account_id")

        existing = self.bank_import._find_existing_deposit(
            bank_account.id,
            draft.transaction_date,
            draft.amount,
            draft.reference,
            draft.description,
        )
        if existing:
            return None

        deposit = Deposit(
            bank_account_id=bank_account.id,
            property_id=document.property_id,
            transaction_date=draft.transaction_date,
            amount=draft.amount,
            currency=draft.currency or self.settings.default_currency,
            reference=draft.reference,
            description=draft.description,
            source="file_upload",
        )
        self.db.add(deposit)
        self.db.flush()
        return deposit.id

    def _confirm_expense(self, document: UploadedDocument, draft: TransactionDraft) -> UUID:
        if not draft.transaction_date or not draft.amount:
            raise HTTPException(status_code=400, detail="transaction_date and amount are required")
        if not draft.category or not draft.source or not draft.payment_method:
            raise HTTPException(
                status_code=400,
                detail="category, source, and payment_method are required",
            )

        _validate_expense_enums(
            category=draft.category,
            source=draft.source,
            payment_method=draft.payment_method,
        )

        expense = Expense(
            property_id=document.property_id,
            transaction_date=draft.transaction_date,
            amount=draft.amount,
            currency=draft.currency or self.settings.default_currency,
            category=draft.category,
            source=draft.source,
            payment_method=draft.payment_method,
            vendor_name=draft.vendor_name,
            reference=draft.reference,
            description=draft.description,
        )
        self.db.add(expense)
        self.db.flush()
        return expense.id

    def _parse_optional_date(
        self,
        value: object,
        field: str,
        warnings: list[FieldWarning],
    ) -> date | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        if isinstance(value, date):
            return value
        try:
            parsed = pd.to_datetime(value, errors="coerce")
        except (ValueError, TypeError):
            warnings.append(
                FieldWarning(field=field, message=f"Invalid date: {value}", severity="error")
            )
            return None
        if pd.isna(parsed):
            warnings.append(
                FieldWarning(field=field, message=f"Invalid date: {value}", severity="error")
            )
            return None
        return parsed.date()

    def _parse_optional_amount(
        self,
        value: object,
        warnings: list[FieldWarning],
    ) -> Decimal | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        try:
            amount = Decimal(str(value))
        except Exception:
            warnings.append(
                FieldWarning(field="amount", message=f"Invalid amount: {value}", severity="error")
            )
            return None
        if amount <= 0:
            warnings.append(
                FieldWarning(field="amount", message="Amount must be positive.", severity="error")
            )
            return None
        return amount.quantize(Decimal("0.01"))

    @staticmethod
    def _optional_str(value: object) -> str | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        text = str(value).strip()
        return text or None

    def read_stored_file(self, document: UploadedDocument) -> bytes:
        path = get_storage_root() / document.stored_path
        if not path.exists():
            raise HTTPException(status_code=404, detail="Stored file not found")
        return path.read_bytes()
