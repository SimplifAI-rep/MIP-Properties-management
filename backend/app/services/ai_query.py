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
from app.models.expense import EXPENSE_CATEGORIES, Expense
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import AIQueryResponse, DepositQueryIntent, PeriodRange
from app.services.deposit_query import find_deposit_gaps, list_deposits
from app.services.expense_query import list_expenses

logger = logging.getLogger(__name__)

ALLOWED_QUERY_TYPES = {"list", "sum", "count", "gap_analysis", "compare_periods"}
ALLOWED_DOMAINS = {"deposits", "expenses"}
DEPOSIT_GROUP_BY = {"property", "owner", "month"}
EXPENSE_GROUP_BY = {"property", "owner", "category"}
OUT_OF_SCOPE_KEYWORDS = (
    "whatsapp",
    "ocr",
    "upload receipt",
    "email attachment",
    "pdf statement",
    "parse invoice",
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

    def query(self, question: str) -> AIQueryResponse:
        if self._is_out_of_scope(question):
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
                intent = self._parse_with_llm(question)
                parser = "llm"
            except Exception:
                logger.exception("LLM parsing failed; falling back to rules")
                intent = self._parse_with_rules(question)
        else:
            intent = self._parse_with_rules(question)

        intent = self._validate_intent(intent)
        intent = self._resolve_names(intent)
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

    def _is_out_of_scope(self, question: str) -> bool:
        lowered = question.lower()
        return any(keyword in lowered for keyword in OUT_OF_SCOPE_KEYWORDS)

    def _detect_domain(self, text: str) -> str:
        has_expense = any(signal in text for signal in EXPENSE_SIGNALS)
        has_deposit = any(signal in text for signal in DEPOSIT_SIGNALS)
        if has_expense and not has_deposit:
            return "expenses"
        if has_deposit and not has_expense:
            return "deposits"
        if has_expense:
            return "expenses"
        return "deposits"

    def build_system_prompt(self) -> str:
        return (
            "You translate natural-language questions about property finances into JSON intent objects. "
            "Return ONLY valid JSON matching this schema:\n"
            "{"
            '"domain": "deposits|expenses", '
            '"query_type": "list|sum|count|gap_analysis|compare_periods", '
            '"property_name": string|null, "owner_name": string|null, '
            '"date_from": "YYYY-MM-DD"|null, "date_to": "YYYY-MM-DD"|null, '
            '"year": number|null, "month": number|null, '
            '"min_amount": number|null, "max_amount": number|null, '
            '"group_by": "property|owner|month|category"|null, '
            '"category": string|null, "source": string|null, "payment_method": string|null, '
            '"search_text": string|null, '
            '"period_a": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null, '
            '"period_b": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null'
            "}\n"
            "Use domain=expenses for utility bills, maintenance, insurance, tax, and other costs. "
            "Use domain=deposits for owner deposits and income. "
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
        owner_name = self._extract_owner_name(lowered)
        date_from, date_to = self._extract_date_range(lowered, year)
        min_amount, max_amount = self._extract_amount_bounds(lowered)
        category = None
        search_text = None
        source = None
        if domain == "expenses":
            search_text = self._extract_expense_search_text(lowered)
            if not search_text:
                category = self._extract_expense_category(lowered)
            source = self._extract_expense_source(lowered)

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
            )

        if "compare" in lowered and (" vs " in lowered or " versus " in lowered):
            period_a, period_b = self._extract_compare_periods(lowered, year)
            return DepositQueryIntent(
                domain=domain,
                query_type="compare_periods",
                property_name=property_name,
                owner_name=owner_name,
                period_a=period_a,
                period_b=period_b,
                category=category,
                source=source,
                search_text=search_text,
            )

        if lowered.startswith("how many") or "how many" in lowered or lowered.startswith("count"):
            return DepositQueryIntent(
                domain=domain,
                query_type="count",
                property_name=property_name,
                owner_name=owner_name,
                date_from=date_from,
                date_to=date_to,
                year=year if not date_from else None,
                min_amount=min_amount,
                max_amount=max_amount,
                category=category,
                source=source,
                search_text=search_text,
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
                date_from = date(year, 1, 1)
                date_to = date(year, 12, 31)
            return DepositQueryIntent(
                domain=domain,
                query_type="sum",
                property_name=property_name,
                owner_name=owner_name,
                date_from=date_from,
                date_to=date_to,
                group_by=group_by,
                year=year if not date_from else None,
                min_amount=min_amount,
                max_amount=max_amount,
                category=category,
                source=source,
                search_text=search_text,
            )

        return DepositQueryIntent(
            domain=domain,
            query_type="list",
            property_name=property_name,
            owner_name=owner_name,
            date_from=date_from,
            date_to=date_to,
            year=year if not date_from else None,
            month=month,
            min_amount=min_amount,
            max_amount=max_amount,
            category=category,
            source=source,
            search_text=search_text,
        )

    def _validate_intent(self, intent: DepositQueryIntent) -> DepositQueryIntent:
        if intent.domain not in ALLOWED_DOMAINS:
            raise HTTPException(status_code=400, detail=f"Unsupported domain: {intent.domain}")
        if intent.query_type not in ALLOWED_QUERY_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported query_type: {intent.query_type}")
        if intent.query_type == "gap_analysis" and intent.domain != "deposits":
            raise HTTPException(
                status_code=400,
                detail="gap_analysis is only supported for deposit queries.",
            )
        allowed_group_by = EXPENSE_GROUP_BY if intent.domain == "expenses" else DEPOSIT_GROUP_BY
        if intent.group_by and intent.group_by not in allowed_group_by:
            raise HTTPException(status_code=400, detail=f"Unsupported group_by: {intent.group_by}")
        if intent.category and intent.category not in EXPENSE_CATEGORIES:
            raise HTTPException(status_code=400, detail=f"Unsupported category: {intent.category}")
        return intent

    def _resolve_names(self, intent: DepositQueryIntent) -> DepositQueryIntent:
        updates: dict[str, Any] = {}
        if intent.property_name and not intent.property_id:
            prop = self.db.scalar(
                select(Property).where(Property.name.ilike(f"%{intent.property_name.strip()}%"))
            )
            if prop:
                updates["property_id"] = prop.id
        if intent.owner_name and not intent.owner_id:
            owner = self.db.scalar(
                select(Owner).where(Owner.name.ilike(f"%{intent.owner_name.strip()}%"))
            )
            if owner:
                updates["owner_id"] = owner.id
        if updates:
            return intent.model_copy(update=updates)
        return intent

    def _execute_intent(self, intent: DepositQueryIntent) -> list[dict]:
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
            owner_id=intent.owner_id,
            category=intent.category,
            source=intent.source,
            payment_method=intent.payment_method,
            search_text=intent.search_text,
            date_from=date_from,
            date_to=date_to,
            min_amount=intent.min_amount,
            max_amount=intent.max_amount,
            page=1,
            page_size=200,
        )
        return [item.model_dump(mode="json") for item in items]

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
            owner_id=intent.owner_id,
            date_from=date_from,
            date_to=date_to,
            min_amount=intent.min_amount,
            max_amount=intent.max_amount,
            page=1,
            page_size=200,
        )
        return [item.model_dump(mode="json") for item in items]

    def _execute_sum(self, intent: DepositQueryIntent) -> list[dict]:
        date_from, date_to = self._intent_dates(intent)
        if intent.group_by == "owner":
            stmt = (
                select(Owner.name, func.coalesce(func.sum(Deposit.amount), 0), func.count(Deposit.id))
                .join(Property, Property.owner_id == Owner.id)
                .join(Deposit, Deposit.property_id == Property.id)
            )
            stmt = self._apply_deposit_filters(
                stmt, date_from, date_to,
                min_amount=intent.min_amount, max_amount=intent.max_amount,
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
                stmt, date_from, date_to, intent.property_id, intent.owner_id,
                intent.min_amount, intent.max_amount,
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
            stmt, date_from, date_to, intent.property_id, intent.owner_id,
            intent.min_amount, intent.max_amount,
        )
        total = self.db.scalar(stmt)

        count_stmt = (
            select(func.count())
            .select_from(Deposit)
            .join(Property, Deposit.property_id == Property.id)
        )
        count_stmt = self._apply_deposit_filters(
            count_stmt, date_from, date_to, intent.property_id, intent.owner_id,
            intent.min_amount, intent.max_amount,
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
            count_stmt, date_from, date_to, intent.property_id, intent.owner_id,
            intent.min_amount, intent.max_amount,
        )
        count = self.db.scalar(count_stmt)
        return [{"deposit_count": count or 0}]

    def _execute_gap_analysis(self, intent: DepositQueryIntent) -> list[dict]:
        if intent.year and intent.month:
            gaps = find_deposit_gaps(self.db, year=intent.year, month=intent.month)
        else:
            date_from, date_to = self._intent_dates(intent)
            gaps = find_deposit_gaps(self.db, date_from=date_from, date_to=date_to)
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
        is_expense = intent.domain == "expenses"
        item_label = "expense" if is_expense else "deposit"
        count_key = "expense_count" if is_expense else "deposit_count"

        if intent.query_type == "list":
            msg = f"Found {len(data)} {item_label}(s) matching your query."
            if intent.category:
                msg += f" Category: {intent.category}."
            if intent.search_text:
                msg += f' Matching "{intent.search_text}".'
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
    ):
        if date_from:
            stmt = stmt.where(Deposit.transaction_date >= date_from)
        if date_to:
            stmt = stmt.where(Deposit.transaction_date <= date_to)
        if property_id:
            stmt = stmt.where(Deposit.property_id == property_id)
        if owner_id:
            stmt = stmt.where(Property.owner_id == owner_id)
        if min_amount is not None:
            stmt = stmt.where(Deposit.amount >= min_amount)
        if max_amount is not None:
            stmt = stmt.where(Deposit.amount <= max_amount)
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
        if intent.property_id:
            stmt = stmt.where(Expense.property_id == intent.property_id)
        if intent.owner_id:
            stmt = stmt.where(Property.owner_id == intent.owner_id)
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
        return stmt

    def _extract_year(self, text: str) -> int | None:
        match = re.search(r"\b(20\d{2})\b", text)
        return int(match.group(1)) if match else None

    def _extract_month(self, text: str) -> int | None:
        for name, number in MONTHS.items():
            if name in text:
                return number
        return None

    def _extract_property_name(self, text: str) -> str | None:
        for prop in self.db.scalars(select(Property)).all():
            if prop.name.lower() in text:
                return prop.name
        return None

    def _extract_owner_name(self, text: str) -> str | None:
        if "per owner" in text or "by owner" in text:
            return None
        for owner in self.db.scalars(select(Owner)).all():
            if owner.name.lower() in text:
                return owner.name
        return None

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
