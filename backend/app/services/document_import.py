from __future__ import annotations

import base64
import json
import logging
import re
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
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

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

MatchConfidence = Literal["high", "medium", "low", "none"]


@dataclass
class AnalyzeContext:
    property_id: UUID | None
    owner_id: UUID | None
    transaction_type: Literal["deposit", "expense"]
    filename: str
    mime_type: str
    auto_detect_type: bool = False


@dataclass
class PropertyMatch:
    property_id: UUID
    owner_id: UUID
    client_prop_id: str
    property_name: str
    owner_name: str
    confidence: MatchConfidence
    reason: str


class DocumentImportService:
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()
        self.bank_import = BankImportService(db)

    def create_upload(
        self,
        *,
        property_id: UUID | None,
        owner_id: UUID | None,
        transaction_type: Literal["deposit", "expense"],
        filename: str,
        stored_path: str,
        mime_type: str,
        auto_detect_type: bool = False,
    ) -> UploadedDocument:
        if property_id is not None:
            property_row = self.db.get(Property, property_id)
            if not property_row:
                raise HTTPException(status_code=404, detail="Property not found")
            owner_id = property_row.owner_id
            owner = self.db.get(Owner, owner_id)
            if not owner:
                raise HTTPException(status_code=404, detail="Owner not found")

        document = UploadedDocument(
            property_id=property_id,
            owner_id=owner_id,
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
        *,
        auto_detect_type: bool = False,
    ) -> UploadAnalyzeResponse:
        ctx = AnalyzeContext(
            property_id=document.property_id,
            owner_id=document.owner_id,
            transaction_type=document.transaction_type,  # type: ignore[arg-type]
            filename=document.filename,
            mime_type=document.mime_type,
            auto_detect_type=auto_detect_type,
        )

        suffix = Path(document.filename).suffix.lower()
        drafts: list[TransactionDraft] = []
        parser = "manual"
        message: str | None = None
        match_confidence: MatchConfidence | None = None

        if suffix in {".xlsx", ".xls", ".csv"}:
            drafts, parser, message = self._analyze_spreadsheet(content, ctx, suffix)
        elif document.mime_type.startswith("image/"):
            drafts, parser, message = self._analyze_image(content, ctx)
        elif suffix == ".pdf":
            drafts, parser, message = self._analyze_pdf(content, ctx)
        else:
            drafts = [self._manual_draft(ctx, "Unsupported file format. Enter details manually.")]
            message = "Unsupported file format."

        # Sync document with first draft's matched property / type
        if drafts:
            primary = drafts[0]
            if primary.property_id and document.property_id != primary.property_id:
                document.property_id = primary.property_id
                document.owner_id = primary.owner_id
            if primary.transaction_type and document.transaction_type != primary.transaction_type:
                document.transaction_type = primary.transaction_type
            match_confidence = primary.match_confidence

        document.parser = parser
        document.extraction_json = {
            "drafts": [draft.model_dump(mode="json") for draft in drafts],
            "message": message,
            "match_confidence": match_confidence,
        }
        self.db.commit()

        ready_count = sum(1 for draft in drafts if draft.status == "ready")
        review_count = sum(1 for draft in drafts if draft.status == "needs_review")
        error_count = sum(1 for draft in drafts if draft.status == "error")

        primary = drafts[0] if drafts else None
        return UploadAnalyzeResponse(
            upload_id=document.id,
            filename=document.filename,
            mime_type=document.mime_type,
            property_id=document.property_id,
            owner_id=document.owner_id,
            client_prop_id=primary.client_prop_id if primary else None,
            property_name=primary.property_name if primary else None,
            owner_name=primary.owner_name if primary else None,
            transaction_type=document.transaction_type,  # type: ignore[arg-type]
            parser=parser,
            message=message,
            match_confidence=match_confidence,
            drafts=drafts,
            ready_count=ready_count,
            needs_review_count=review_count,
            error_count=error_count,
            preview_url=f"/api/v1/uploads/{document.id}/file",
            storage_uri=_storage_uri_safe(document.stored_path),
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
                property_id = draft.property_id or document.property_id
                if not property_id:
                    raise HTTPException(
                        status_code=400,
                        detail="property_id is required — select the correct client/property",
                    )
                draft.property_id = property_id

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

        # Keep document linked to the confirmed property when possible
        first_confirmed = next(
            (d for d in payload.drafts if d.property_id),
            None,
        )
        if first_confirmed and first_confirmed.property_id:
            document.property_id = first_confirmed.property_id
            property_row = self.db.get(Property, first_confirmed.property_id)
            if property_row:
                document.owner_id = property_row.owner_id
            document.transaction_type = first_confirmed.transaction_type

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
        property_meta = self._property_meta(ctx.property_id) if ctx.property_id else None

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

            if ctx.property_id and bank_account.property_id != ctx.property_id:
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
                    client_prop_id=property_meta["client_prop_id"] if property_meta else None,
                    property_name=property_meta["property_name"] if property_meta else None,
                    owner_id=property_meta["owner_id"] if property_meta else None,
                    owner_name=property_meta["owner_name"] if property_meta else None,
                    bank_account_id=bank_account.id,
                    account_number=account_number,
                    transaction_date=transaction_date,
                    amount=amount,
                    currency=currency,
                    reference=reference,
                    description=description,
                    match_confidence="high" if ctx.property_id else "none",
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
        property_meta = self._property_meta(ctx.property_id) if ctx.property_id else None

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
            client_prop_id=property_meta["client_prop_id"] if property_meta else None,
            property_name=property_meta["property_name"] if property_meta else None,
            owner_id=property_meta["owner_id"] if property_meta else None,
            owner_name=property_meta["owner_name"] if property_meta else None,
            transaction_date=transaction_date,
            amount=amount,
            currency=currency,
            category=category,
            source=source,
            payment_method=payment_method,
            vendor_name=vendor_name,
            reference=reference,
            description=description,
            match_confidence="high" if ctx.property_id else "none",
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
                "AI extraction requires LLM_API_KEY. Fill in the fields manually and select the client.",
            )
            return [draft], "manual", "LLM_API_KEY not configured."

        try:
            draft = self._extract_with_llm(content, ctx, is_image=True)
            return [draft], "llm", None
        except Exception as exc:
            logger.exception("LLM image extraction failed")
            friendly = self._friendly_llm_error(exc)
            draft = self._manual_draft(ctx, friendly)
            return [draft], "manual", friendly

    def _analyze_pdf(
        self,
        content: bytes,
        ctx: AnalyzeContext,
    ) -> tuple[list[TransactionDraft], str, str | None]:
        pdf_text = self._extract_pdf_text(content)

        if not self.settings.llm_api_key:
            # Without LLM, try deterministic matching from extracted text
            if pdf_text:
                draft = self._draft_from_text_hints(pdf_text, ctx)
                return [draft], "pdf_text", "LLM_API_KEY not configured — matched from PDF text only."
            draft = self._manual_draft(
                ctx,
                "PDF extraction requires LLM_API_KEY. Fill in the fields manually or upload Excel.",
            )
            return [draft], "manual", "LLM_API_KEY not configured."

        try:
            draft = self._extract_with_llm(
                content,
                ctx,
                is_image=False,
                pdf_text=pdf_text,
            )
            return [draft], "llm", None
        except Exception as exc:
            logger.exception("LLM PDF extraction failed")
            friendly = self._friendly_llm_error(exc)
            if pdf_text:
                draft = self._draft_from_text_hints(pdf_text, ctx)
                draft.warnings.insert(
                    0,
                    FieldWarning(
                        field="document",
                        message=f"{friendly} Used PDF text matching instead.",
                        severity="warning",
                    ),
                )
                return [draft], "pdf_text", friendly
            draft = self._manual_draft(ctx, friendly)
            return [draft], "manual", friendly

    @staticmethod
    def _friendly_llm_error(exc: Exception) -> str:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status == 401:
            return (
                "AI extraction failed: LLM_API_KEY is missing or invalid. "
                "Fill in the fields manually and select the client."
            )
        if status == 429:
            return "AI extraction rate-limited. Fill in the fields manually and try again later."
        return f"AI extraction failed: {exc}"

    def _extract_pdf_text(self, content: bytes) -> str:
        try:
            from pypdf import PdfReader
        except ImportError:
            logger.warning("pypdf not installed — PDF text extraction unavailable")
            return ""

        try:
            reader = PdfReader(BytesIO(content))
            parts: list[str] = []
            for page in reader.pages[:10]:
                text = page.extract_text() or ""
                if text.strip():
                    parts.append(text.strip())
            return "\n\n".join(parts)[:12000]
        except Exception:
            logger.exception("Failed to extract PDF text")
            return ""

    def _property_catalog(self) -> list[dict]:
        rows = self.db.scalars(
            select(Property).options(joinedload(Property.owner), joinedload(Property.bank_accounts))
        ).unique().all()
        catalog = []
        for prop in rows:
            catalog.append(
                {
                    "property_id": str(prop.id),
                    "client_prop_id": prop.client_prop_id,
                    "property_name": prop.name,
                    "address": prop.address,
                    "city": prop.city,
                    "owner_name": prop.owner.name if prop.owner else None,
                    "account_numbers": [a.account_number for a in prop.bank_accounts],
                }
            )
        return catalog

    def _extract_with_llm(
        self,
        content: bytes,
        ctx: AnalyzeContext,
        *,
        is_image: bool,
        pdf_text: str = "",
    ) -> TransactionDraft:
        catalog = self._property_catalog()
        catalog_json = json.dumps(catalog, ensure_ascii=False)

        type_instruction = (
            "Detect whether this is a deposit (money received / rent / bank credit) "
            "or an expense (receipt / invoice / bill / payment out). "
            "Set transaction_type accordingly."
            if ctx.auto_detect_type
            else f"Transaction type is {ctx.transaction_type}."
        )

        system_prompt = (
            "Extract a single property finance transaction from the document. "
            "Return JSON with keys: "
            "transaction_type (deposit|expense), "
            "transaction_date (YYYY-MM-DD or null), amount (number or null), "
            "currency (3-letter code), reference, description, vendor_name, category, source, "
            "payment_method, account_number, "
            "matched_property_id (UUID string from catalog or null), "
            "matched_client_prop_id, matched_property_name, matched_owner_name, "
            "confidence (high|medium|low), missing_fields (array of strings), "
            "match_reason (short string). "
            f"{type_instruction} "
            "Match the document to the most likely property/client from the catalog using "
            "property name, owner name, address, client_prop_id, or bank account number. "
            "Use null for fields you cannot determine. "
            f"Allowed categories: {', '.join(EXPENSE_CATEGORIES)}. "
            f"Allowed sources: {', '.join(EXPENSE_SOURCES)}. "
            f"Allowed payment methods: {', '.join(PAYMENT_METHODS)}."
        )

        if is_image:
            media_type = ctx.mime_type
            encoded = base64.b64encode(content).decode("ascii")
            user_content: list[dict] | str = [
                {
                    "type": "text",
                    "text": (
                        "Extract transaction details and match the correct client/property.\n"
                        f"Known properties catalog:\n{catalog_json}"
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{media_type};base64,{encoded}"},
                },
            ]
        else:
            text_block = pdf_text or "(No extractable text — document may be a scanned image PDF.)"
            user_content = (
                "Extract transaction details from this PDF and match the correct client/property.\n"
                f"PDF text:\n{text_block}\n\n"
                f"Known properties catalog:\n{catalog_json}"
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
            timeout=90.0,
        )
        response.raise_for_status()
        data = json.loads(response.json()["choices"][0]["message"]["content"])
        return self._draft_from_llm(data, ctx, pdf_text=pdf_text)

    def _draft_from_text_hints(self, text: str, ctx: AnalyzeContext) -> TransactionDraft:
        """Best-effort extraction without LLM using PDF text + DB matching."""
        warnings: list[FieldWarning] = [
            FieldWarning(
                field="document",
                message="Limited extraction without AI — verify all fields.",
                severity="warning",
            )
        ]

        amount = None
        amount_match = re.search(
            r"(?:total|amount|sum|סה[\"']?כ)\s*[:\-]?\s*(?:₪|ILS|NIS)?\s*([0-9]+(?:[.,][0-9]{1,2})?)",
            text,
            re.IGNORECASE,
        )
        if not amount_match:
            amount_match = re.search(r"₪\s*([0-9]+(?:[.,][0-9]{1,2})?)", text)
        if amount_match:
            amount = self._parse_optional_amount(
                amount_match.group(1).replace(",", ""),
                warnings,
            )

        date_match = re.search(r"(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})", text)
        transaction_date = None
        if date_match:
            transaction_date = self._parse_optional_date(date_match.group(1), "transaction_date", warnings)

        hints = {
            "account_number": None,
            "client_prop_id": None,
            "property_name": None,
            "owner_name": None,
            "address": None,
        }
        for account in self.db.scalars(select(BankAccount)).all():
            if account.account_number and account.account_number in text:
                hints["account_number"] = account.account_number
                break
        for prop in self.db.scalars(select(Property).options(joinedload(Property.owner))).unique().all():
            if prop.client_prop_id and prop.client_prop_id in text:
                hints["client_prop_id"] = prop.client_prop_id
            if prop.name and prop.name.lower() in text.lower():
                hints["property_name"] = prop.name
            if prop.owner and prop.owner.name and prop.owner.name.lower() in text.lower():
                hints["owner_name"] = prop.owner.name
            if prop.address and prop.address.split(",")[0].lower() in text.lower():
                hints["address"] = prop.address

        matched = self._resolve_property_match(hints, ctx)
        txn_type = ctx.transaction_type
        if ctx.auto_detect_type:
            lowered = text.lower()
            if any(word in lowered for word in ("invoice", "receipt", "bill", "חשבונית", "קבלה")):
                txn_type = "expense"
            elif any(word in lowered for word in ("deposit", "rent", "credit", "הפקדה", "שכירות")):
                txn_type = "deposit"

        return self._build_document_draft(
            ctx=ctx,
            transaction_type=txn_type,
            transaction_date=transaction_date,
            amount=amount,
            currency=self.settings.default_currency,
            matched=matched,
            account_number=hints.get("account_number"),
            vendor_name=None,
            reference=None,
            description=text[:240] if text else None,
            category="other" if txn_type == "expense" else None,
            source="manual_company" if txn_type == "expense" else None,
            payment_method="company_account" if txn_type == "expense" else None,
            confidence="low",
            extra_warnings=warnings,
        )

    def _draft_from_llm(
        self,
        data: dict,
        ctx: AnalyzeContext,
        *,
        pdf_text: str = "",
    ) -> TransactionDraft:
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
        if confidence not in {"high", "medium", "low"}:
            confidence = "low"
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

        if ctx.auto_detect_type:
            detected = str(data.get("transaction_type") or "").lower()
            txn_type: Literal["deposit", "expense"] = (
                detected if detected in {"deposit", "expense"} else "expense"
            )
        else:
            txn_type = ctx.transaction_type

        hints = {
            "property_id": data.get("matched_property_id"),
            "client_prop_id": self._optional_str(data.get("matched_client_prop_id")),
            "property_name": self._optional_str(data.get("matched_property_name")),
            "owner_name": self._optional_str(data.get("matched_owner_name")),
            "account_number": self._optional_str(data.get("account_number")),
            "address": None,
        }
        # Also scan PDF text for account / prop id as a safety net
        if pdf_text:
            for account in self.db.scalars(select(BankAccount)).all():
                if account.account_number and account.account_number in pdf_text and not hints["account_number"]:
                    hints["account_number"] = account.account_number

        matched = self._resolve_property_match(hints, ctx)
        if matched and data.get("match_reason"):
            # keep LLM reason for UI via warning only when medium/low
            if matched.confidence in {"medium", "low"}:
                warnings.append(
                    FieldWarning(
                        field="property_id",
                        message=f"Matched client: {matched.reason}",
                        severity="warning",
                    )
                )

        return self._build_document_draft(
            ctx=ctx,
            transaction_type=txn_type,
            transaction_date=transaction_date,
            amount=amount,
            currency=self._optional_str(data.get("currency")) or self.settings.default_currency,
            matched=matched,
            account_number=self._optional_str(data.get("account_number")),
            vendor_name=self._optional_str(data.get("vendor_name")),
            reference=self._optional_str(data.get("reference")),
            description=self._optional_str(data.get("description")),
            category=self._optional_str(data.get("category")) or "other",
            source=self._optional_str(data.get("source")) or "manual_company",
            payment_method=self._optional_str(data.get("payment_method")) or "company_account",
            confidence=confidence,  # type: ignore[arg-type]
            extra_warnings=warnings,
        )

    def _resolve_property_match(
        self,
        hints: dict,
        ctx: AnalyzeContext,
    ) -> PropertyMatch | None:
        # Explicit user selection wins
        if ctx.property_id:
            meta = self._property_meta(ctx.property_id)
            if meta:
                return PropertyMatch(
                    property_id=ctx.property_id,
                    owner_id=meta["owner_id"],
                    client_prop_id=meta["client_prop_id"],
                    property_name=meta["property_name"],
                    owner_name=meta["owner_name"],
                    confidence="high",
                    reason="Selected by user",
                )

        # Exact property UUID from LLM
        raw_id = hints.get("property_id")
        if raw_id:
            try:
                prop_uuid = UUID(str(raw_id))
                meta = self._property_meta(prop_uuid)
                if meta:
                    return PropertyMatch(
                        property_id=prop_uuid,
                        owner_id=meta["owner_id"],
                        client_prop_id=meta["client_prop_id"],
                        property_name=meta["property_name"],
                        owner_name=meta["owner_name"],
                        confidence="high",
                        reason="Matched property id from document",
                    )
            except (ValueError, TypeError):
                pass

        # Bank account number
        account_number = hints.get("account_number")
        if account_number:
            account = self.db.scalars(
                select(BankAccount).where(BankAccount.account_number == account_number)
            ).first()
            if account and account.property_id:
                meta = self._property_meta(account.property_id)
                if meta:
                    return PropertyMatch(
                        property_id=account.property_id,
                        owner_id=meta["owner_id"],
                        client_prop_id=meta["client_prop_id"],
                        property_name=meta["property_name"],
                        owner_name=meta["owner_name"],
                        confidence="high",
                        reason=f"Matched bank account {account_number}",
                    )

        # client_prop_id
        client_prop_id = hints.get("client_prop_id")
        if client_prop_id:
            prop = self.db.scalars(
                select(Property).where(Property.client_prop_id == client_prop_id)
            ).first()
            if prop:
                meta = self._property_meta(prop.id)
                if meta:
                    return PropertyMatch(
                        property_id=prop.id,
                        owner_id=meta["owner_id"],
                        client_prop_id=meta["client_prop_id"],
                        property_name=meta["property_name"],
                        owner_name=meta["owner_name"],
                        confidence="high",
                        reason=f"Matched client prop id {client_prop_id}",
                    )

        properties = self.db.scalars(
            select(Property).options(joinedload(Property.owner))
        ).unique().all()

        # Exact / case-insensitive property name
        property_name = (hints.get("property_name") or "").strip().lower()
        if property_name:
            for prop in properties:
                if prop.name.lower() == property_name:
                    meta = self._property_meta(prop.id)
                    if meta:
                        return PropertyMatch(
                            property_id=prop.id,
                            owner_id=meta["owner_id"],
                            client_prop_id=meta["client_prop_id"],
                            property_name=meta["property_name"],
                            owner_name=meta["owner_name"],
                            confidence="high",
                            reason=f"Matched property name '{prop.name}'",
                        )
            for prop in properties:
                if property_name in prop.name.lower() or prop.name.lower() in property_name:
                    meta = self._property_meta(prop.id)
                    if meta:
                        return PropertyMatch(
                            property_id=prop.id,
                            owner_id=meta["owner_id"],
                            client_prop_id=meta["client_prop_id"],
                            property_name=meta["property_name"],
                            owner_name=meta["owner_name"],
                            confidence="medium",
                            reason=f"Partial property name match '{prop.name}'",
                        )

        # Owner name — if owner has exactly one property, use it
        owner_name = (hints.get("owner_name") or "").strip().lower()
        if owner_name:
            owner_matches = [
                prop
                for prop in properties
                if prop.owner and owner_name in prop.owner.name.lower()
            ]
            if len(owner_matches) == 1:
                prop = owner_matches[0]
                meta = self._property_meta(prop.id)
                if meta:
                    return PropertyMatch(
                        property_id=prop.id,
                        owner_id=meta["owner_id"],
                        client_prop_id=meta["client_prop_id"],
                        property_name=meta["property_name"],
                        owner_name=meta["owner_name"],
                        confidence="medium",
                        reason=f"Matched sole property of owner '{prop.owner.name}'",
                    )
            elif len(owner_matches) > 1:
                # Prefer address hint if available
                address_hint = (hints.get("address") or "").strip().lower()
                if address_hint:
                    for prop in owner_matches:
                        if prop.address and address_hint in prop.address.lower():
                            meta = self._property_meta(prop.id)
                            if meta:
                                return PropertyMatch(
                                    property_id=prop.id,
                                    owner_id=meta["owner_id"],
                                    client_prop_id=meta["client_prop_id"],
                                    property_name=meta["property_name"],
                                    owner_name=meta["owner_name"],
                                    confidence="medium",
                                    reason="Matched owner + address",
                                )

        return None

    def _build_document_draft(
        self,
        *,
        ctx: AnalyzeContext,
        transaction_type: Literal["deposit", "expense"],
        transaction_date: date | None,
        amount: Decimal | None,
        currency: str,
        matched: PropertyMatch | None,
        account_number: str | None,
        vendor_name: str | None,
        reference: str | None,
        description: str | None,
        category: str | None,
        source: str | None,
        payment_method: str | None,
        confidence: MatchConfidence,
        extra_warnings: list[FieldWarning],
    ) -> TransactionDraft:
        warnings = list(extra_warnings)
        bank_account_id = None
        property_id = matched.property_id if matched else ctx.property_id
        owner_id = matched.owner_id if matched else ctx.owner_id
        match_confidence: MatchConfidence = matched.confidence if matched else "none"

        if not matched:
            warnings.append(
                FieldWarning(
                    field="property_id",
                    message="Could not auto-match a client/property. Select one before confirming.",
                    severity="error",
                )
            )

        if transaction_type == "deposit":
            if account_number:
                account = self.db.scalars(
                    select(BankAccount).where(BankAccount.account_number == account_number)
                ).first()
                if account:
                    bank_account_id = account.id
                    if property_id and account.property_id != property_id:
                        warnings.append(
                            FieldWarning(
                                field="account_number",
                                message="Account belongs to a different property.",
                                severity="warning",
                            )
                        )
                    elif not property_id and account.property_id:
                        property_id = account.property_id
                        meta = self._property_meta(account.property_id)
                        if meta:
                            owner_id = meta["owner_id"]
                            matched = PropertyMatch(
                                property_id=account.property_id,
                                owner_id=meta["owner_id"],
                                client_prop_id=meta["client_prop_id"],
                                property_name=meta["property_name"],
                                owner_name=meta["owner_name"],
                                confidence="high",
                                reason=f"Matched bank account {account_number}",
                            )
                            match_confidence = "high"
                else:
                    warnings.append(
                        FieldWarning(
                            field="account_number",
                            message=f"Unknown account number: {account_number}",
                            severity="error",
                        )
                    )
            elif property_id:
                # Prefer the property's first bank account when none extracted
                account = self.db.scalars(
                    select(BankAccount).where(BankAccount.property_id == property_id)
                ).first()
                if account:
                    bank_account_id = account.id
                    account_number = account.account_number
                    warnings.append(
                        FieldWarning(
                            field="account_number",
                            message="No account on document — using property's default account.",
                            severity="warning",
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
        # Document uploads always need human confirmation
        if has_errors:
            status: Literal["ready", "needs_review", "error"] = "error"
        elif confidence == "high" and not warnings:
            status = "ready"
        else:
            status = "needs_review"

        meta = matched
        return TransactionDraft(
            transaction_type=transaction_type,
            property_id=property_id,
            client_prop_id=meta.client_prop_id if meta else None,
            property_name=meta.property_name if meta else None,
            owner_id=owner_id or (meta.owner_id if meta else None),
            owner_name=meta.owner_name if meta else None,
            bank_account_id=bank_account_id,
            account_number=account_number,
            transaction_date=transaction_date,
            amount=amount,
            currency=currency,
            category=category if transaction_type == "expense" else None,
            source=source if transaction_type == "expense" else None,
            payment_method=payment_method if transaction_type == "expense" else None,
            vendor_name=vendor_name if transaction_type == "expense" else None,
            reference=reference,
            description=description,
            match_confidence=match_confidence,
            status=status,
            warnings=warnings,
        )

    def _property_meta(self, property_id: UUID) -> dict | None:
        prop = self.db.scalars(
            select(Property)
            .options(joinedload(Property.owner))
            .where(Property.id == property_id)
        ).first()
        if not prop:
            return None
        return {
            "owner_id": prop.owner_id,
            "client_prop_id": prop.client_prop_id,
            "property_name": prop.name,
            "owner_name": prop.owner.name if prop.owner else "",
        }

    def _manual_draft(self, ctx: AnalyzeContext, message: str) -> TransactionDraft:
        meta = self._property_meta(ctx.property_id) if ctx.property_id else None
        return TransactionDraft(
            transaction_type=ctx.transaction_type,
            property_id=ctx.property_id,
            client_prop_id=meta["client_prop_id"] if meta else None,
            property_name=meta["property_name"] if meta else None,
            owner_id=meta["owner_id"] if meta else ctx.owner_id,
            owner_name=meta["owner_name"] if meta else None,
            match_confidence="high" if ctx.property_id else "none",
            status="needs_review",
            warnings=[
                FieldWarning(field="document", message=message, severity="warning"),
            ],
        )

    def _confirm_deposit(self, document: UploadedDocument, draft: TransactionDraft) -> UUID | None:
        if not draft.property_id:
            raise HTTPException(status_code=400, detail="property_id is required")
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
            property_id=draft.property_id,
            transaction_date=draft.transaction_date,
            amount=draft.amount,
            currency=draft.currency or self.settings.default_currency,
            reference=draft.reference,
            description=draft.description,
            source="file_upload",
            receipt_ref=str(document.id),
            source_file=document.filename,
        )
        self.db.add(deposit)
        self.db.flush()
        return deposit.id

    def _confirm_expense(self, document: UploadedDocument, draft: TransactionDraft) -> UUID:
        if not draft.property_id:
            raise HTTPException(status_code=400, detail="property_id is required")
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
            property_id=draft.property_id,
            transaction_date=draft.transaction_date,
            amount=draft.amount,
            currency=draft.currency or self.settings.default_currency,
            category=draft.category,
            source=draft.source,
            payment_method=draft.payment_method,
            vendor_name=draft.vendor_name,
            reference=draft.reference,
            description=draft.description,
            receipt_ref=str(document.id),
            source_file=document.filename,
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
            text = str(value).strip()
            # Prefer ISO dates without dayfirst ambiguity
            if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
                parsed = pd.to_datetime(text, errors="coerce", dayfirst=False)
            else:
                parsed = pd.to_datetime(value, errors="coerce", dayfirst=True)
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
        result = parsed.date() if hasattr(parsed, "date") else parsed
        if isinstance(result, date) and result.year < 2000:
            warnings.append(
                FieldWarning(
                    field=field,
                    message=f"Date looks like an Excel serial leftover ({result}); ignored.",
                    severity="error",
                )
            )
            return None
        return result

    def _parse_optional_amount(
        self,
        value: object,
        warnings: list[FieldWarning],
    ) -> Decimal | None:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        try:
            amount = Decimal(str(value).replace(",", ""))
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


def _storage_uri_safe(stored_path: str) -> str | None:
    try:
        from app.services.document_storage import storage_uri_for

        return storage_uri_for(stored_path)
    except (OSError, ValueError):
        return None
