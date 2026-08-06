from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import AIQueryFilters, AIQueryResponse, DepositQueryIntent, PeriodRange
from app.services.deposit_query import find_deposit_gaps, list_deposits
from app.services.expense_query import list_expenses
from app.services.transaction_view import normalize_transaction_row

logger = logging.getLogger(__name__)

ALLOWED_QUERY_TYPES = {"list", "sum", "count", "gap_analysis", "compare_periods"}
ALLOWED_DOMAINS = {"deposits", "expenses", "transactions"}
DEPOSIT_GROUP_BY = {"property", "owner", "month"}
EXPENSE_GROUP_BY = {"property", "owner", "category"}
TRANSACTIONS_GROUP_BY = {"property", "owner", "month"}
OUT_OF_SCOPE_KEYWORDS = (
    "whatsapp",
    "ocr",
    "upload receipt",
    "email attachment",
    "pdf statement",
    "parse invoice",
)
TRANSACTION_SIGNALS = (
    "transaction",
    "transactions",
    "source file",
    "from file",
    "imported from",
)
EXPENSE_SIGNALS = (
    "expense",
    "expenses",
    "utility",
    "utilities",
    "electricity",
    "electric",
    "maintenance",
    "insurance",
    "standing order",
    "credit card",
    "tax",
    "arnona",
    "management fee",
    "vendor",
    "paid for",
    "he/she paid",
    "he she paid",
    "resident paid",
)
DEPOSIT_SIGNALS = (
    "deposit",
    "deposits",
    "income",
    "gap",
    "missing deposit",
    "no deposit",
    "expected deposit",
)
CATEGORY_KEYWORDS = {
    "utilities": ("utility bill", "utility bills", "utilities"),
    "maintenance": ("maintenance", "repair"),
    "insurance": ("insurance",),
    "tax": ("tax", "arnona"),
    "management_fee": ("management fee",),
}
SPECIFIC_EXPENSE_SEARCH = (
    ("electric", ("electricity", "electric")),
    ("water", ("water",)),
    ("plumb", ("plumbing", "plumber")),
)
SOURCE_KEYWORDS = {
    "standing_order": ("standing order",),
    "credit_card": ("credit card",),
    "manual_owner": ("owner paid", "owner personal", "paid personally"),
    "manual_company": ("company paid", "management company", "paid by company"),
    "bank_statement": ("bank statement", "from the bank", "bank account excel"),
    "management_ledger": ("management ledger", "management sheet"),
}
LEDGER_COLUMN_KEYWORDS = {
    "nearly_cc": ("nearly cc", "nearly credit"),
    "cash": ("cash column", "from cash"),
    "other": ("other column", "from other"),
}
MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


class AIQueryService:
    def __init__(self, db: Session):
        self.db = db
        self.settings = get_settings()

    def query(
        self,
        question: str,
        filters: AIQueryFilters | None = None,
    ) -> AIQueryResponse:
        trimmed = (question or "").strip()
        has_filters = bool(
            filters
            and (
                filters.owner_ids
                or filters.property_ids
                or filters.client_prop_ids
                or filters.date_from
                or filters.date_to
                or filters.min_amount is not None
                or filters.max_amount is not None
            )
        )
        if not trimmed and not has_filters:
            raise HTTPException(
                status_code=400,
                detail="Enter a question and/or choose at least one filter.",
            )
        if not trimmed:
            trimmed = "Show matching transactions"

        if self._is_out_of_scope(trimmed):
            raise HTTPException(
                status_code=400,
                detail=(
                    "This question is outside current scope. "
                    "Only deposit, income, and expense queries are supported."
                ),
            )

        parser = "rules"
        if self.settings.llm_api_key:
            try:
                intent = self._parse_with_llm(trimmed)
                parser = "llm"
            except Exception:
                logger.exception("LLM parsing failed; falling back to rules")
                intent = self._parse_with_rules(trimmed)
        else:
            intent = self._parse_with_rules(trimmed)

        intent = self._validate_intent(intent)
        intent = self._resolve_names(intent)
        intent = self._apply_structured_filters(intent, filters)
        data = self._execute_intent(intent)
        answer = self._build_answer(intent, data)
        logger.info(
            "ai_query domain=%s query_type=%s parser=%s",
            intent.domain,
            intent.query_type,
            parser,
        )

        return AIQueryResponse(
            answer=answer,
            data=data,
            query_used=intent,
            parser=parser,
        )

    def _apply_structured_filters(
        self,
        intent: DepositQueryIntent,
        filters: AIQueryFilters | None,
    ) -> DepositQueryIntent:
        if not filters:
            return intent

        updates: dict[str, Any] = {}
        if filters.date_from is not None:
            updates["date_from"] = filters.date_from
            updates["year"] = None
            updates["month"] = None
        if filters.date_to is not None:
            updates["date_to"] = filters.date_to
            updates["year"] = None
            updates["month"] = None
        if filters.min_amount is not None:
            updates["min_amount"] = filters.min_amount
        if filters.max_amount is not None:
            updates["max_amount"] = filters.max_amount

        if filters.owner_ids:
            updates["owner_ids"] = list(filters.owner_ids)
            updates["owner_id"] = filters.owner_ids[0] if len(filters.owner_ids) == 1 else None
            updates["owner_name"] = None
        if filters.property_ids:
            updates["property_ids"] = list(filters.property_ids)
            updates["property_id"] = (
                filters.property_ids[0] if len(filters.property_ids) == 1 else None
            )
            updates["property_name"] = None
        if filters.client_prop_ids:
            cleaned = [value.strip() for value in filters.client_prop_ids if value.strip()]
            updates["client_prop_ids"] = cleaned
            updates["client_prop_id"] = cleaned[0] if len(cleaned) == 1 else None

        return intent.model_copy(update=updates) if updates else intent

    def _is_out_of_scope(self, question: str) -> bool:
        lowered = question.lower()
        return any(keyword in lowered for keyword in OUT_OF_SCOPE_KEYWORDS)

    def _detect_domain(self, text: str) -> str:
        has_expense = any(signal in text for signal in EXPENSE_SIGNALS)
        has_deposit = any(signal in text for signal in DEPOSIT_SIGNALS)
        has_transaction = any(signal in text for signal in TRANSACTION_SIGNALS)
        if has_expense and not has_deposit:
            return "expenses"
        if has_deposit and not has_expense:
            return "deposits"
        if has_transaction or "incomplete import" in text or "needs review" in text:
            return "transactions"
        if has_expense:
            return "expenses"
        return "deposits"

    def build_system_prompt(self) -> str:
        return (
            "You translate natural-language questions about property finances into JSON intent objects. "
            "Return ONLY valid JSON matching this schema:\n"
            "{"
            '"domain": "deposits|expenses|transactions", '
            '"query_type": "list|sum|count|gap_analysis|compare_periods", '
            '"property_name": string|null, "client_prop_id": string|null, '
            '"owner_name": string|null, '
            '"date_from": "YYYY-MM-DD"|null, "date_to": "YYYY-MM-DD"|null, '
            '"year": number|null, "month": number|null, '
            '"min_amount": number|null, "max_amount": number|null, '
            '"group_by": "property|owner|month|category"|null, '
            '"category": string|null, "source": string|null, "payment_method": string|null, '
            '"search_text": string|null, "source_file": string|null, '
            '"needs_review": true|false|null, '
            '"is_rental_income": true|false|null, '
            '"paid_by_resident": true|false|null, '
            '"paid_by_owner": true|false|null, '
            '"paid_by_company": true|false|null, '
            '"ledger_column": "nearly_cc|cash|other"|null, '
            '"period_a": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null, '
            '"period_b": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null'
            "}\n"
            "Use domain=expenses for utility bills, maintenance, insurance, tax, and other costs. "
            "Use domain=deposits for owner deposits and income. "
            "Use domain=transactions for mixed deposit+expense questions, source-file imports, "
            "incomplete imports, or when the user says transactions. "
            "source_file filters by the original import/upload filename (partial match ok). "
            "client_prop_id is the Excel Prop ID (e.g. BUFFER, 05EX). "
            "needs_review=true means incomplete imports missing date/amount. "
            "is_rental_income=true for rental income deposits (not company float inflow). "
            "paid_by_resident=true for He/She paid expenses. "
            "source may be bank_statement, credit_card, management_ledger, standing_order, etc. "
            "Never generate SQL."
        )

    def _parse_with_llm(self, question: str) -> DepositQueryIntent:
        payload = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": self.build_system_prompt()},
                {"role": "user", "content": question},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0,
        }
        response = httpx.post(
            f"{self.settings.llm_base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self.settings.llm_api_key}"},
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        return DepositQueryIntent.model_validate(json.loads(content))

    def _parse_with_rules(self, question: str) -> DepositQueryIntent:
        lowered = question.lower()
        domain = self._detect_domain(lowered)
        year = self._extract_year(lowered) or date.today().year
        month = self._extract_month(lowered)
        property_name = self._extract_property_name(lowered)
        client_prop_id = self._extract_client_prop_id(question)
        owner_name = self._extract_owner_name(lowered)
        date_from, date_to = self._extract_date_range(lowered, year)
        min_amount, max_amount = self._extract_amount_bounds(lowered)
        source_file = self._extract_source_file(question)
        needs_review = self._extract_needs_review(lowered)
        is_rental_income = self._extract_rental_income(lowered)
        paid_by_resident = self._extract_paid_by_resident(lowered)
        paid_by_owner = self._extract_paid_by_owner(lowered)
        paid_by_company = self._extract_paid_by_company(lowered)
        ledger_column = self._extract_ledger_column(lowered)
        category = None
        search_text = None
        source = None
        if is_rental_income:
            domain = "deposits"
        elif paid_by_resident or paid_by_owner or paid_by_company or ledger_column:
            domain = "expenses"
        elif source_file and domain == "deposits" and not any(
            signal in lowered for signal in DEPOSIT_SIGNALS
        ):
            # "from source file X" without deposit/expense wording → mixed
            domain = "transactions"

        if domain == "expenses":
            search_text = self._extract_expense_search_text(lowered)
            if not search_text:
                category = self._extract_expense_category(lowered)
            source = self._extract_expense_source(lowered)
        elif domain == "transactions":
            source = self._extract_expense_source(lowered)
            if "bank statement" in lowered:
                source = source or "bank_statement"
        elif "bank statement" in lowered:
            source = "bank_statement"

        common = dict(
            property_name=property_name,
            client_prop_id=client_prop_id,
            owner_name=owner_name,
            date_from=date_from,
            date_to=date_to,
            min_amount=min_amount,
            max_amount=max_amount,
            category=category,
            source=source,
            search_text=search_text,
            source_file=source_file,
            needs_review=needs_review,
            is_rental_income=is_rental_income,
            paid_by_resident=paid_by_resident,
            paid_by_owner=paid_by_owner,
            paid_by_company=paid_by_company,
            ledger_column=ledger_column,
        )

        if domain == "deposits" and any(
            word in lowered for word in ("gap", "missing", "no deposit", "had no deposit")
        ):
            return DepositQueryIntent(
                domain=domain,
                query_type="gap_analysis",
                year=year,
                month=month,
                date_from=date_from,
                date_to=date_to,
                client_prop_id=client_prop_id,
                source_file=source_file,
            )

        if "compare" in lowered and (" vs " in lowered or " versus " in lowered):
            period_a, period_b = self._extract_compare_periods(lowered, year)
            return DepositQueryIntent(
                domain=domain,
                query_type="compare_periods",
                period_a=period_a,
                period_b=period_b,
                **common,
            )

        if lowered.startswith("how many") or "how many" in lowered or lowered.startswith("count"):
            return DepositQueryIntent(
                domain=domain,
                query_type="count",
                year=year if not date_from else None,
                **common,
            )

        if "total" in lowered or "sum" in lowered:
            group_by = None
            if "per owner" in lowered or "by owner" in lowered:
                group_by = "owner"
            elif "per property" in lowered or "by property" in lowered:
                group_by = "property"
            elif domain == "expenses" and ("per category" in lowered or "by category" in lowered):
                group_by = "category"
            if "this year" in lowered:
                common["date_from"] = date(year, 1, 1)
                common["date_to"] = date(year, 12, 31)
            return DepositQueryIntent(
                domain=domain,
                query_type="sum",
                group_by=group_by,
                year=year if not common["date_from"] else None,
                **common,
            )

        return DepositQueryIntent(
            domain=domain,
            query_type="list",
            year=year if not date_from else None,
            month=month,
            **common,
        )

    def _validate_intent(self, intent: DepositQueryIntent) -> DepositQueryIntent:
        if intent.domain not in ALLOWED_DOMAINS:
            raise HTTPException(status_code=400, detail=f"Unsupported domain: {intent.domain}")
        if intent.query_type not in ALLOWED_QUERY_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported query_type: {intent.query_type}")
        if intent.query_type == "gap_analysis" and intent.domain not in {"deposits"}:
            raise HTTPException(
                status_code=400,
                detail="gap_analysis is only supported for deposit queries.",
            )
        if intent.domain == "transactions":
            allowed_group_by = TRANSACTIONS_GROUP_BY
        elif intent.domain == "expenses":
            allowed_group_by = EXPENSE_GROUP_BY
        else:
            allowed_group_by = DEPOSIT_GROUP_BY
        if intent.group_by and intent.group_by not in allowed_group_by:
            raise HTTPException(status_code=400, detail=f"Unsupported group_by: {intent.group_by}")
        # Free-text categories from client ledgers are allowed
        return intent

    def _resolve_names(self, intent: DepositQueryIntent) -> DepositQueryIntent:
        updates: dict[str, Any] = {}
        if intent.client_prop_id and not intent.property_id:
            prop = self.db.scalar(
                select(Property).where(
                    func.upper(Property.client_prop_id) == intent.client_prop_id.strip().upper()
                )
            )
            if prop:
                updates["property_id"] = prop.id
                updates["client_prop_id"] = prop.client_prop_id
        if intent.property_name and not intent.property_id and "property_id" not in updates:
            prop = self.db.scalar(
                select(Property).where(Property.name.ilike(f"%{intent.property_name.strip()}%"))
            )
            if prop:
                updates["property_id"] = prop.id
                if not intent.client_prop_id:
                    updates["client_prop_id"] = prop.client_prop_id
        if intent.owner_name and not intent.owner_id:
            needle = intent.owner_name.strip()
            owner = self.db.scalar(
                select(Owner).where(Owner.name.ilike(f"%{needle}%"))
            )
            if not owner:
                # Partial / alias match (e.g. "My Israel Property" → "... (MIP)").
                matched_name = self._best_entity_name_in_text(
                    needle.lower(),
                    [row.name for row in self.db.scalars(select(Owner)).all()],
                    min_token_len=2,
                )
                if matched_name:
                    owner = self.db.scalar(
                        select(Owner).where(Owner.name == matched_name)
                    )
            if owner:
                updates["owner_id"] = owner.id
                updates["owner_name"] = owner.name
        if updates:
            return intent.model_copy(update=updates)
        return intent

    def _execute_intent(self, intent: DepositQueryIntent) -> list[dict]:
        if intent.domain == "transactions":
            return self._execute_transactions_intent(intent)
        if intent.domain == "expenses":
            return self._execute_expense_intent(intent)
        if intent.query_type == "list":
            return self._execute_list(intent)
        if intent.query_type == "sum":
            return self._execute_sum(intent)
        if intent.query_type == "count":
            return self._execute_count(intent)
        if intent.query_type == "gap_analysis":
            return self._execute_gap_analysis(intent)
        if intent.query_type == "compare_periods":
            return self._execute_compare_periods(intent)
        return []

    def _execute_transactions_intent(self, intent: DepositQueryIntent) -> list[dict]:
        if intent.query_type == "list":
            return self._execute_transactions_list(intent)
        if intent.query_type == "sum":
            return self._execute_transactions_sum(intent)
        if intent.query_type == "count":
            return self._execute_transactions_count(intent)
        if intent.query_type == "compare_periods":
            return self._execute_transactions_compare(intent)
        raise HTTPException(
            status_code=400,
            detail=f"Query type '{intent.query_type}' is not supported for transactions.",
        )

    def _execute_transactions_list(self, intent: DepositQueryIntent) -> list[dict]:
        deposits = self._execute_list(intent)
        expenses = self._execute_expense_list(intent)
        rows = list(deposits) + list(expenses)
        # Newest date first; missing dates at the end (do not pin needs_review).
        rows.sort(key=lambda row: row.get("transaction_date") or "", reverse=True)
        return rows[:200]

    def _execute_transactions_sum(self, intent: DepositQueryIntent) -> list[dict]:
        deposit_data = self._execute_sum(
            intent.model_copy(update={"domain": "deposits", "group_by": None})
        )
        expense_data = self._execute_expense_sum(
            intent.model_copy(update={"domain": "expenses", "group_by": None})
        )
        deposit_total = Decimal(str(deposit_data[0]["total_amount"])) if deposit_data else Decimal("0")
        expense_total = Decimal(str(expense_data[0]["total_amount"])) if expense_data else Decimal("0")
        deposit_count = deposit_data[0].get("deposit_count", 0) if deposit_data else 0
        expense_count = expense_data[0].get("expense_count", 0) if expense_data else 0
        return [
            {
                "deposit_total": str(deposit_total),
                "deposit_count": deposit_count,
                "expense_total": str(expense_total),
                "expense_count": expense_count,
                "net_total": str(deposit_total - expense_total),
                "transaction_count": int(deposit_count or 0) + int(expense_count or 0),
            }
        ]

    def _execute_transactions_count(self, intent: DepositQueryIntent) -> list[dict]:
        deposit_data = self._execute_count(intent.model_copy(update={"domain": "deposits"}))
        expense_data = self._execute_expense_count(
            intent.model_copy(update={"domain": "expenses"})
        )
        deposit_count = deposit_data[0].get("deposit_count", 0) if deposit_data else 0
        expense_count = expense_data[0].get("expense_count", 0) if expense_data else 0
        return [
            {
                "deposit_count": deposit_count,
                "expense_count": expense_count,
                "transaction_count": int(deposit_count or 0) + int(expense_count or 0),
            }
        ]

    def _execute_transactions_compare(self, intent: DepositQueryIntent) -> list[dict]:
        if not intent.period_a or not intent.period_b:
            raise HTTPException(status_code=400, detail="compare_periods requires period_a and period_b")
        results = []
        for label, period in ("period_a", intent.period_a), ("period_b", intent.period_b):
            scoped = intent.model_copy(
                update={
                    "date_from": period.date_from,
                    "date_to": period.date_to,
                    "year": None,
                    "month": None,
                    "group_by": None,
                }
            )
            summary = self._execute_transactions_sum(scoped)[0]
            results.append(
                {
                    "period": label,
                    "date_from": period.date_from.isoformat() if period.date_from else None,
                    "date_to": period.date_to.isoformat() if period.date_to else None,
                    **summary,
                }
            )
        return results

    def _execute_expense_intent(self, intent: DepositQueryIntent) -> list[dict]:
        if intent.query_type == "list":
            return self._execute_expense_list(intent)
        if intent.query_type == "sum":
            return self._execute_expense_sum(intent)
        if intent.query_type == "count":
            return self._execute_expense_count(intent)
        if intent.query_type == "compare_periods":
            return self._execute_expense_compare_periods(intent)
        raise HTTPException(
            status_code=400,
            detail=f"Query type '{intent.query_type}' is not supported for expenses.",
        )

    def _execute_expense_list(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        items, _ = list_expenses(
            self.db,
            property_id=intent.property_id,
            property_ids=intent.property_ids,
            client_prop_id=intent.client_prop_id,
            client_prop_ids=intent.client_prop_ids,
            owner_id=intent.owner_id,
            owner_ids=intent.owner_ids,
            category=intent.category,
            source=intent.source,
            payment_method=intent.payment_method,
            search_text=intent.search_text,
            date_from=date_from,
            date_to=date_to,
            min_amount=intent.min_amount,
            max_amount=intent.max_amount,
            source_file=intent.source_file,
            needs_review=intent.needs_review,
            paid_by_resident=intent.paid_by_resident,
            paid_by_owner=intent.paid_by_owner,
            paid_by_company=intent.paid_by_company,
            ledger_column=intent.ledger_column,
            page=1,
            page_size=200,
        )
        return [
            normalize_transaction_row("expense", item.model_dump(mode="json"))
            for item in items
        ]

    def _execute_expense_sum(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        if intent.group_by == "owner":
            stmt = (
                select(Owner.name, func.coalesce(func.sum(Expense.amount), 0), func.count(Expense.id))
                .join(Property, Property.owner_id == Owner.id)
                .join(Expense, Expense.property_id == Property.id)
            )
            stmt = self._apply_expense_filters(stmt, date_from, date_to, intent)
            rows = self.db.execute(stmt.group_by(Owner.name).order_by(Owner.name)).all()
            return [
                {"owner_name": name, "total_amount": str(total), "expense_count": count}
                for name, total, count in rows
            ]
        if intent.group_by == "property":
            stmt = (
                select(Property.name, func.coalesce(func.sum(Expense.amount), 0), func.count(Expense.id))
                .join(Expense, Expense.property_id == Property.id)
            )
            stmt = self._apply_expense_filters(stmt, date_from, date_to, intent)
            rows = self.db.execute(stmt.group_by(Property.name).order_by(Property.name)).all()
            return [
                {"property_name": name, "total_amount": str(total), "expense_count": count}
                for name, total, count in rows
            ]
        if intent.group_by == "category":
            stmt = (
                select(Expense.category, func.coalesce(func.sum(Expense.amount), 0), func.count(Expense.id))
                .select_from(Expense)
                .join(Property, Expense.property_id == Property.id)
            )
            stmt = self._apply_expense_filters(stmt, date_from, date_to, intent)
            rows = self.db.execute(stmt.group_by(Expense.category).order_by(Expense.category)).all()
            return [
                {"category": category, "total_amount": str(total), "expense_count": count}
                for category, total, count in rows
            ]

        stmt = (
            select(func.coalesce(func.sum(Expense.amount), 0))
            .select_from(Expense)
            .join(Property, Expense.property_id == Property.id)
        )
        stmt = self._apply_expense_filters(stmt, date_from, date_to, intent)
        total = self.db.scalar(stmt)

        count_stmt = (
            select(func.count())
            .select_from(Expense)
            .join(Property, Expense.property_id == Property.id)
        )
        count_stmt = self._apply_expense_filters(count_stmt, date_from, date_to, intent)
        count = self.db.scalar(count_stmt)
        return [{"total_amount": str(total or 0), "expense_count": count or 0}]

    def _execute_expense_count(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        count_stmt = (
            select(func.count())
            .select_from(Expense)
            .join(Property, Expense.property_id == Property.id)
        )
        count_stmt = self._apply_expense_filters(count_stmt, date_from, date_to, intent)
        count = self.db.scalar(count_stmt)
        return [{"expense_count": count or 0}]

    def _execute_expense_compare_periods(self, intent: DepositQueryIntent) -> list[dict]:
        if not intent.period_a or not intent.period_b:
            raise HTTPException(status_code=400, detail="compare_periods requires period_a and period_b")

        results = []
        for label, period in ("period_a", intent.period_a), ("period_b", intent.period_b):
            total_stmt = (
                select(func.coalesce(func.sum(Expense.amount), 0))
                .select_from(Expense)
                .join(Property, Expense.property_id == Property.id)
            )
            total_stmt = self._apply_expense_filters(
                total_stmt, period.date_from, period.date_to, intent
            )
            total = self.db.scalar(total_stmt)

            count_stmt = (
                select(func.count())
                .select_from(Expense)
                .join(Property, Expense.property_id == Property.id)
            )
            count_stmt = self._apply_expense_filters(
                count_stmt, period.date_from, period.date_to, intent
            )
            count = self.db.scalar(count_stmt)
            results.append(
                {
                    "period": label,
                    "date_from": period.date_from.isoformat() if period.date_from else None,
                    "date_to": period.date_to.isoformat() if period.date_to else None,
                    "total_amount": str(total or 0),
                    "expense_count": count or 0,
                }
            )
        return results

    def _execute_list(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        items, _ = list_deposits(
            self.db,
            property_id=intent.property_id,
            property_ids=intent.property_ids,
            client_prop_id=intent.client_prop_id,
            client_prop_ids=intent.client_prop_ids,
            owner_id=intent.owner_id,
            owner_ids=intent.owner_ids,
            date_from=date_from,
            date_to=date_to,
            min_amount=intent.min_amount,
            max_amount=intent.max_amount,
            source_file=intent.source_file,
            needs_review=intent.needs_review,
            is_rental_income=intent.is_rental_income,
            page=1,
            page_size=200,
        )
        return [
            normalize_transaction_row("deposit", item.model_dump(mode="json"))
            for item in items
        ]

    def _execute_sum(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        if intent.group_by == "owner":
            stmt = (
                select(Owner.name, func.coalesce(func.sum(Deposit.amount), 0), func.count(Deposit.id))
                .join(Property, Property.owner_id == Owner.id)
                .join(Deposit, Deposit.property_id == Property.id)
            )
            stmt = self._apply_deposit_filters(
                stmt,
                date_from,
                date_to,
                min_amount=intent.min_amount,
                max_amount=intent.max_amount,
                intent=intent,
            )
            rows = self.db.execute(
                stmt.group_by(Owner.name).order_by(Owner.name)
            ).all()
            return [
                {"owner_name": name, "total_amount": str(total), "deposit_count": count}
                for name, total, count in rows
            ]
        if intent.group_by == "property":
            stmt = (
                select(Property.name, func.coalesce(func.sum(Deposit.amount), 0), func.count(Deposit.id))
                .join(Deposit, Deposit.property_id == Property.id)
            )
            stmt = self._apply_deposit_filters(
                stmt,
                date_from,
                date_to,
                intent.property_id,
                intent.owner_id,
                intent.min_amount,
                intent.max_amount,
                intent=intent,
            )
            rows = self.db.execute(
                stmt.group_by(Property.name).order_by(Property.name)
            ).all()
            return [
                {"property_name": name, "total_amount": str(total), "deposit_count": count}
                for name, total, count in rows
            ]

        stmt = (
            select(func.coalesce(func.sum(Deposit.amount), 0))
            .select_from(Deposit)
            .join(Property, Deposit.property_id == Property.id)
        )
        stmt = self._apply_deposit_filters(
            stmt,
            date_from,
            date_to,
            intent.property_id,
            intent.owner_id,
            intent.min_amount,
            intent.max_amount,
            intent=intent,
        )
        total = self.db.scalar(stmt)

        count_stmt = (
            select(func.count())
            .select_from(Deposit)
            .join(Property, Deposit.property_id == Property.id)
        )
        count_stmt = self._apply_deposit_filters(
            count_stmt,
            date_from,
            date_to,
            intent.property_id,
            intent.owner_id,
            intent.min_amount,
            intent.max_amount,
            intent=intent,
        )
        count = self.db.scalar(count_stmt)
        return [{"total_amount": str(total or 0), "deposit_count": count or 0}]

    def _execute_count(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        count_stmt = (
            select(func.count())
            .select_from(Deposit)
            .join(Property, Deposit.property_id == Property.id)
        )
        count_stmt = self._apply_deposit_filters(
            count_stmt,
            date_from,
            date_to,
            intent.property_id,
            intent.owner_id,
            intent.min_amount,
            intent.max_amount,
            intent=intent,
        )
        count = self.db.scalar(count_stmt)
        return [{"deposit_count": count or 0}]

    def _execute_gap_analysis(self, intent: DepositQueryIntent) -> list[dict]:
        if intent.year and intent.month:
            gaps = find_deposit_gaps(
                self.db,
                year=intent.year,
                month=intent.month,
                property_id=intent.property_id,
                client_prop_id=intent.client_prop_id,
                owner_id=intent.owner_id,
            )
        else:
            date_from, date_to = self._intent_dates(intent)
            gaps = find_deposit_gaps(
                self.db,
                date_from=date_from,
                date_to=date_to,
                property_id=intent.property_id,
                client_prop_id=intent.client_prop_id,
                owner_id=intent.owner_id,
            )
        return [gap.model_dump(mode="json") for gap in gaps]

    def _execute_compare_periods(self, intent: DepositQueryIntent) -> list[dict]:
        if not intent.period_a or not intent.period_b:
            raise HTTPException(status_code=400, detail="compare_periods requires period_a and period_b")

        results = []
        for label, period in ("period_a", intent.period_a), ("period_b", intent.period_b):
            total_stmt = (
                select(func.coalesce(func.sum(Deposit.amount), 0))
                .select_from(Deposit)
                .join(Property, Deposit.property_id == Property.id)
            )
            total_stmt = self._apply_deposit_filters(
                total_stmt,
                period.date_from,
                period.date_to,
                intent.property_id,
                intent.owner_id,
                intent.min_amount,
                intent.max_amount,
                intent=intent,
            )
            total = self.db.scalar(total_stmt)

            count_stmt = (
                select(func.count())
                .select_from(Deposit)
                .join(Property, Deposit.property_id == Property.id)
            )
            count_stmt = self._apply_deposit_filters(
                count_stmt,
                period.date_from,
                period.date_to,
                intent.property_id,
                intent.owner_id,
                intent.min_amount,
                intent.max_amount,
                intent=intent,
            )
            count = self.db.scalar(count_stmt)
            results.append(
                {
                    "period": label,
                    "date_from": period.date_from.isoformat() if period.date_from else None,
                    "date_to": period.date_to.isoformat() if period.date_to else None,
                    "total_amount": str(total or 0),
                    "deposit_count": count or 0,
                }
            )
        return results

    def _build_answer(self, intent: DepositQueryIntent, data: list[dict]) -> str:
        if intent.domain == "transactions":
            return self._build_transactions_answer(intent, data)

        is_expense = intent.domain == "expenses"
        item_label = "expense" if is_expense else "deposit"
        count_key = "expense_count" if is_expense else "deposit_count"

        if intent.query_type == "list":
            msg = f"Found {len(data)} {item_label}(s) matching your query."
            if intent.category:
                msg += f" Category: {intent.category}."
            if intent.search_text:
                msg += f' Matching "{intent.search_text}".'
            if intent.source_file:
                msg += f' Source file: "{intent.source_file}".'
            if intent.min_amount is not None:
                msg += f" Filtered to amounts >= {intent.min_amount}."
            if intent.max_amount is not None:
                msg += f" Filtered to amounts <= {intent.max_amount}."
            return msg
        if intent.query_type == "count":
            count = data[0][count_key] if data else 0
            return f"There are {count} {item_label}(s) matching your query."
        if intent.query_type == "sum":
            if intent.group_by:
                return f"Totals grouped by {intent.group_by}: {len(data)} group(s) found."
            total = data[0]["total_amount"] if data else "0"
            count = data[0].get(count_key, 0) if data else 0
            label = "expenses" if is_expense else "deposits"
            return f"Total {label}: {total} ILS across {count} transaction(s)."
        if intent.query_type == "gap_analysis":
            if not data:
                return "No missing expected deposits were found for the requested period."
            names = ", ".join(item["property_name"] for item in data)
            return f"Missing expected deposits for: {names}."
        if intent.query_type == "compare_periods":
            if len(data) == 2:
                a, b = data[0], data[1]
                return (
                    f"Period A total: {a['total_amount']} ILS ({a[count_key]} {item_label}s). "
                    f"Period B total: {b['total_amount']} ILS ({b[count_key]} {item_label}s)."
                )
        return "Query completed."

    def _build_transactions_answer(self, intent: DepositQueryIntent, data: list[dict]) -> str:
        if intent.query_type == "list":
            deposits = sum(1 for row in data if row.get("kind") == "deposit")
            expenses = sum(1 for row in data if row.get("kind") == "expense")
            msg = (
                f"Found {len(data)} transaction(s) "
                f"({deposits} deposit(s), {expenses} expense(s))."
            )
            if intent.source_file:
                msg += f' Source file: "{intent.source_file}".'
            return msg
        if intent.query_type == "count" and data:
            row = data[0]
            return (
                f"There are {row.get('transaction_count', 0)} transaction(s) "
                f"({row.get('deposit_count', 0)} deposit(s), "
                f"{row.get('expense_count', 0)} expense(s))."
            )
        if intent.query_type == "sum" and data:
            row = data[0]
            return (
                f"Deposits {row.get('deposit_total', '0')} ILS "
                f"({row.get('deposit_count', 0)}) − "
                f"expenses {row.get('expense_total', '0')} ILS "
                f"({row.get('expense_count', 0)}) = "
                f"net {row.get('net_total', '0')} ILS."
            )
        if intent.query_type == "compare_periods" and len(data) == 2:
            a, b = data[0], data[1]
            return (
                f"Period A net: {a.get('net_total', '0')} ILS "
                f"({a.get('transaction_count', 0)} tx). "
                f"Period B net: {b.get('net_total', '0')} ILS "
                f"({b.get('transaction_count', 0)} tx)."
            )
        return "Query completed."

    def _intent_dates(self, intent: DepositQueryIntent) -> tuple[date | None, date | None]:
        if intent.date_from or intent.date_to:
            return intent.date_from, intent.date_to
        if intent.year and intent.month:
            start = date(intent.year, intent.month, 1)
            if intent.month == 12:
                end = date(intent.year, 12, 31)
            else:
                end = date(intent.year, intent.month + 1, 1) - timedelta(days=1)
            return start, end
        if intent.year:
            return date(intent.year, 1, 1), date(intent.year, 12, 31)
        return None, None

    def _apply_deposit_filters(
        self,
        stmt,
        date_from: date | None,
        date_to: date | None,
        property_id: UUID | None = None,
        owner_id: UUID | None = None,
        min_amount: Decimal | None = None,
        max_amount: Decimal | None = None,
        intent: DepositQueryIntent | None = None,
    ):
        if date_from:
            stmt = stmt.where(Deposit.transaction_date >= date_from)
        if date_to:
            stmt = stmt.where(Deposit.transaction_date <= date_to)

        property_ids = list(intent.property_ids) if intent and intent.property_ids else []
        if property_id and property_id not in property_ids:
            property_ids.append(property_id)
        if len(property_ids) == 1:
            stmt = stmt.where(Deposit.property_id == property_ids[0])
        elif len(property_ids) > 1:
            stmt = stmt.where(Deposit.property_id.in_(property_ids))

        owner_ids = list(intent.owner_ids) if intent and intent.owner_ids else []
        if owner_id and owner_id not in owner_ids:
            owner_ids.append(owner_id)
        if len(owner_ids) == 1:
            stmt = stmt.where(Property.owner_id == owner_ids[0])
        elif len(owner_ids) > 1:
            stmt = stmt.where(Property.owner_id.in_(owner_ids))

        if min_amount is not None:
            stmt = stmt.where(Deposit.amount >= min_amount)
        if max_amount is not None:
            stmt = stmt.where(Deposit.amount <= max_amount)
        if intent is not None:
            client_prop_ids = [
                value.strip().upper()
                for value in (intent.client_prop_ids or [])
                if value and value.strip()
            ]
            if intent.client_prop_id and not property_ids:
                client_prop_ids.append(intent.client_prop_id.strip().upper())
            seen: set[str] = set()
            client_prop_ids = [
                value for value in client_prop_ids if not (value in seen or seen.add(value))
            ]
            if len(client_prop_ids) == 1 and not property_ids:
                stmt = stmt.where(func.upper(Property.client_prop_id) == client_prop_ids[0])
            elif len(client_prop_ids) > 1 and not property_ids:
                stmt = stmt.where(func.upper(Property.client_prop_id).in_(client_prop_ids))
            if intent.source_file:
                stmt = stmt.where(Deposit.source_file.ilike(f"%{intent.source_file.strip()}%"))
            if intent.needs_review is not None:
                stmt = stmt.where(Deposit.needs_review.is_(intent.needs_review))
            if intent.is_rental_income is not None:
                stmt = stmt.where(Deposit.is_rental_income.is_(intent.is_rental_income))
            else:
                # Default to Excel Inflow (company float) — exclude rental unless asked.
                stmt = stmt.where(Deposit.is_rental_income.is_(False))
            if intent.source:
                stmt = stmt.where(Deposit.source == intent.source)
        return stmt

    def _apply_expense_filters(
        self,
        stmt,
        date_from: date | None,
        date_to: date | None,
        intent: DepositQueryIntent,
    ):
        if date_from:
            stmt = stmt.where(Expense.transaction_date >= date_from)
        if date_to:
            stmt = stmt.where(Expense.transaction_date <= date_to)

        property_ids = list(intent.property_ids or [])
        if intent.property_id and intent.property_id not in property_ids:
            property_ids.append(intent.property_id)
        if len(property_ids) == 1:
            stmt = stmt.where(Expense.property_id == property_ids[0])
        elif len(property_ids) > 1:
            stmt = stmt.where(Expense.property_id.in_(property_ids))

        client_prop_ids = [
            value.strip().upper()
            for value in (intent.client_prop_ids or [])
            if value and value.strip()
        ]
        if intent.client_prop_id and not property_ids:
            client_prop_ids.append(intent.client_prop_id.strip().upper())
        seen: set[str] = set()
        client_prop_ids = [
            value for value in client_prop_ids if not (value in seen or seen.add(value))
        ]
        if len(client_prop_ids) == 1 and not property_ids:
            stmt = stmt.where(func.upper(Property.client_prop_id) == client_prop_ids[0])
        elif len(client_prop_ids) > 1 and not property_ids:
            stmt = stmt.where(func.upper(Property.client_prop_id).in_(client_prop_ids))

        owner_ids = list(intent.owner_ids or [])
        if intent.owner_id and intent.owner_id not in owner_ids:
            owner_ids.append(intent.owner_id)
        if len(owner_ids) == 1:
            stmt = stmt.where(Property.owner_id == owner_ids[0])
        elif len(owner_ids) > 1:
            stmt = stmt.where(Property.owner_id.in_(owner_ids))

        if intent.category:
            stmt = stmt.where(Expense.category == intent.category)
        if intent.source:
            stmt = stmt.where(Expense.source == intent.source)
        if intent.payment_method:
            stmt = stmt.where(Expense.payment_method == intent.payment_method)
        if intent.search_text:
            pattern = f"%{intent.search_text}%"
            stmt = stmt.where(
                or_(
                    Expense.description.ilike(pattern),
                    Expense.vendor_name.ilike(pattern),
                )
            )
        if intent.min_amount is not None:
            stmt = stmt.where(Expense.amount >= intent.min_amount)
        if intent.max_amount is not None:
            stmt = stmt.where(Expense.amount <= intent.max_amount)
        if intent.source_file:
            stmt = stmt.where(Expense.source_file.ilike(f"%{intent.source_file.strip()}%"))
        if intent.needs_review is not None:
            stmt = stmt.where(Expense.needs_review.is_(intent.needs_review))
        explicit_payer = (
            intent.paid_by_resident is not None
            or intent.paid_by_owner is not None
            or intent.paid_by_company is not None
        )
        if intent.paid_by_resident is not None:
            stmt = stmt.where(Expense.paid_by_resident.is_(intent.paid_by_resident))
        if intent.paid_by_owner is not None:
            stmt = stmt.where(Expense.paid_by_owner.is_(intent.paid_by_owner))
        if intent.paid_by_company is not None:
            stmt = stmt.where(Expense.paid_by_company.is_(intent.paid_by_company))
        elif not explicit_payer:
            # Default to Excel Amount (company float) — exclude He/She and Owner paid.
            stmt = stmt.where(
                Expense.paid_by_resident.is_(False),
                Expense.paid_by_owner.is_(False),
            )
        if intent.ledger_column:
            stmt = stmt.where(Expense.ledger_column == intent.ledger_column)
        return stmt

    def _extract_year(self, text: str) -> int | None:
        match = re.search(r"\b(20\d{2})\b", text)
        return int(match.group(1)) if match else None

    def _extract_month(self, text: str) -> int | None:
        for name, number in MONTHS.items():
            if name in text:
                return number
        return None

    @staticmethod
    def _entity_match_tokens(name: str) -> list[str]:
        """Build searchable labels for an owner/property display name.

        Names often look like ``My Israel Property (MIP)`` or include Hebrew
        aliases in parentheses — match the base label and short Latin aliases.
        """
        tokens: list[str] = []
        full = re.sub(r"\s+", " ", (name or "").strip().lower())
        if full:
            tokens.append(full)
        base = re.sub(r"\([^)]*\)", " ", name or "")
        base = re.sub(r"\s+", " ", base).strip().lower()
        if base and base not in tokens:
            tokens.append(base)
        for alias in re.findall(r"\(([^)]*)\)", name or ""):
            # Keep Latin / digit aliases like MIP; drop pure Hebrew blobs.
            latin = re.sub(r"[^\w\s\-]+", " ", alias, flags=re.UNICODE)
            latin = re.sub(r"\s+", " ", latin).strip().lower()
            if latin and re.search(r"[a-z0-9]", latin) and latin not in tokens:
                tokens.append(latin)
        # Longest first so "My Israel Property" wins over "MIP" when both match.
        tokens.sort(key=len, reverse=True)
        return tokens

    def _best_entity_name_in_text(
        self,
        text: str,
        names: list[str],
        *,
        min_token_len: int = 3,
    ) -> str | None:
        best_name: str | None = None
        best_len = 0
        for name in names:
            for token in self._entity_match_tokens(name):
                if len(token) < min_token_len:
                    continue
                # Short aliases (MIP) need a word boundary; longer phrases can
                # match as substrings.
                if len(token) <= 4:
                    if not re.search(rf"\b{re.escape(token)}\b", text):
                        continue
                elif token not in text:
                    continue
                if len(token) > best_len:
                    best_name = name
                    best_len = len(token)
        return best_name

    def _extract_property_name(self, text: str) -> str | None:
        names = [prop.name for prop in self.db.scalars(select(Property)).all()]
        return self._best_entity_name_in_text(text, names)

    def _extract_owner_name(self, text: str) -> str | None:
        if "per owner" in text or "by owner" in text:
            return None

        owners = list(self.db.scalars(select(Owner)).all())
        owner_names = [owner.name for owner in owners]

        # Prefer an explicit "owner …" phrase, then fall back to name scan.
        explicit = re.search(
            r"(?:for\s+)?(?:the\s+)?owner\s+(.+?)(?="
            r"\s*,|\s+above|\s+over|\s+greater than|\s+more than|\s+at least|"
            r"\s+below|\s+under|\s+less than|\s+at most|"
            r"\s+from\b|\s+since\b|\s+onward|\s+onwards|"
            r"\s+in\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|"
            r"jul|july|aug|august|sep|sept|september|oct|october|nov|november|"
            r"dec|december|q[1-4]|20\d{2})|"
            r"\s+for\s+(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|"
            r"jul|july|aug|august|sep|sept|september|oct|october|nov|november|"
            r"dec|december|q[1-4]|20\d{2})|"
            r"\s+this\s+year|$)",
            text,
            flags=re.IGNORECASE,
        )
        if explicit:
            fragment = explicit.group(1).strip(" .,;:")
            if fragment:
                matched = self._best_entity_name_in_text(fragment, owner_names, min_token_len=2)
                if matched:
                    return matched
                # Fragment may be a partial of the DB name (e.g. without "(MIP)").
                for owner_name in owner_names:
                    for token in self._entity_match_tokens(owner_name):
                        if fragment == token or fragment in token or token in fragment:
                            return owner_name

        return self._best_entity_name_in_text(text, owner_names)

    def _extract_date_range(self, text: str, year: int) -> tuple[date | None, date | None]:
        if "last 30 days" in text:
            date_to = date.today()
            return date_to - timedelta(days=30), date_to
        if "last month" in text:
            today = date.today()
            first_this_month = date(today.year, today.month, 1)
            last_day_prev = first_this_month - timedelta(days=1)
            first_prev = date(last_day_prev.year, last_day_prev.month, 1)
            return first_prev, last_day_prev
        if "q1" in text:
            return date(year, 1, 1), date(year, 3, 31)
        if "q2" in text:
            return date(year, 4, 1), date(year, 6, 30)
        if "q3" in text:
            return date(year, 7, 1), date(year, 9, 30)
        if "q4" in text:
            return date(year, 10, 1), date(year, 12, 31)
        month = self._extract_month(text)
        if month:
            start = date(year, month, 1)
            open_ended = bool(
                re.search(r"\b(onward|onwards|and later|and after)\b", text)
                or re.search(
                    r"\b(?:since|from)\s+"
                    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
                    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
                    r"nov(?:ember)?|dec(?:ember)?|q[1-4]|20\d{2})",
                    text,
                )
            )
            # "from/since February …" or "February … onward" → no end date.
            if open_ended:
                return start, None
            if month == 12:
                end = date(year, 12, 31)
            else:
                end = date(year, month + 1, 1) - timedelta(days=1)
            return start, end
        if "this year" in text:
            return date(year, 1, 1), date(year, 12, 31)
        return None, None

    def _extract_amount_bounds(self, text: str) -> tuple[Decimal | None, Decimal | None]:
        min_amount: Decimal | None = None
        max_amount: Decimal | None = None

        min_match = re.search(
            r"(?:above|over|greater than|more than|at least|minimum)\s+([\d,]+(?:\.\d+)?)",
            text,
        )
        if min_match:
            min_amount = Decimal(min_match.group(1).replace(",", ""))

        max_match = re.search(
            r"(?:below|under|less than|at most|maximum)\s+([\d,]+(?:\.\d+)?)",
            text,
        )
        if max_match:
            max_amount = Decimal(max_match.group(1).replace(",", ""))

        return min_amount, max_amount

    def _extract_expense_category(self, text: str) -> str | None:
        for category, keywords in CATEGORY_KEYWORDS.items():
            if any(keyword in text for keyword in keywords):
                return category
        return None

    def _extract_expense_search_text(self, text: str) -> str | None:
        for search_term, keywords in SPECIFIC_EXPENSE_SEARCH:
            if any(keyword in text for keyword in keywords):
                return search_term
        return None

    def _extract_expense_source(self, text: str) -> str | None:
        for source, keywords in SOURCE_KEYWORDS.items():
            if any(keyword in text for keyword in keywords):
                return source
        return None

    def _extract_client_prop_id(self, question: str) -> str | None:
        lowered = question.lower()
        match = re.search(
            r"(?:prop(?:erty)?\s*id|client\s*prop(?:erty)?\s*id)\s*[:=]?\s*([A-Za-z0-9_-]+)",
            lowered,
        )
        if match:
            return match.group(1).upper()
        # Prefer exact Prop ID tokens from DB (BUFFER, 05EX, etc.)
        for prop in self.db.scalars(select(Property)).all():
            token = prop.client_prop_id.strip()
            if not token:
                continue
            if re.search(rf"\b{re.escape(token)}\b", question, flags=re.IGNORECASE):
                return prop.client_prop_id
        return None

    def _extract_source_file(self, question: str) -> str | None:
        match = re.search(
            r"(?:source\s*file|from\s+file|imported\s+from|upload(?:ed)?\s+from)\s+"
            r"[\"']?([^\"'\n]+?\.(?:xlsx|xls|csv))[\"']?",
            question,
            flags=re.IGNORECASE,
        )
        if match:
            return match.group(1).strip()
        match = re.search(
            r"(?:source\s*file|from\s+file|imported\s+from|upload(?:ed)?\s+from)\s+"
            r"[\"']?([^\"'\n]+?)[\"']?(?:\s|$)",
            question,
            flags=re.IGNORECASE,
        )
        if match:
            return match.group(1).strip().rstrip(".,;")
        # Match known filenames present in DB
        known = set()
        for value in self.db.scalars(
            select(Deposit.source_file).where(Deposit.source_file.is_not(None)).distinct()
        ).all():
            if value:
                known.add(value)
        for value in self.db.scalars(
            select(Expense.source_file).where(Expense.source_file.is_not(None)).distinct()
        ).all():
            if value:
                known.add(value)
        lowered = question.lower()
        for name in sorted(known, key=len, reverse=True):
            if name.lower() in lowered:
                return name
        return None

    def _extract_needs_review(self, text: str) -> bool | None:
        if any(
            phrase in text
            for phrase in (
                "incomplete import",
                "needs review",
                "missing date",
                "missing amount",
                "incomplete transaction",
            )
        ):
            return True
        return None

    def _extract_rental_income(self, text: str) -> bool | None:
        if "rental income" in text or "rent income" in text:
            return True
        return None

    def _extract_paid_by_resident(self, text: str) -> bool | None:
        if "he/she paid" in text or "he she paid" in text or "resident paid" in text:
            return True
        return None

    def _extract_paid_by_owner(self, text: str) -> bool | None:
        if "owner paid" in text and "company" not in text:
            return True
        return None

    def _extract_paid_by_company(self, text: str) -> bool | None:
        if "mip paid" in text or "company paid" in text or "paid by company" in text:
            return True
        return None

    def _extract_ledger_column(self, text: str) -> str | None:
        for column, keywords in LEDGER_COLUMN_KEYWORDS.items():
            if any(keyword in text for keyword in keywords):
                return column
        return None

    def _extract_compare_periods(self, text: str, year: int) -> tuple[PeriodRange, PeriodRange]:
        parts = re.split(r"\bvs\b|\bversus\b", text)
        if len(parts) < 2:
            raise HTTPException(status_code=400, detail="Could not parse comparison periods")

        def period_from_fragment(fragment: str) -> PeriodRange:
            month = self._extract_month(fragment)
            if not month:
                raise HTTPException(status_code=400, detail="Could not parse comparison month")
            start = date(year, month, 1)
            if month == 12:
                end = date(year, 12, 31)
            else:
                end = date(year, month + 1, 1) - timedelta(days=1)
            return PeriodRange(date_from=start, date_to=end)

        return period_from_fragment(parts[0]), period_from_fragment(parts[1])
