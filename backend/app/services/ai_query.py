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
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.deposit import Deposit
from app.models.owner import Owner
from app.models.property import Property
from app.schemas import AIQueryResponse, DepositQueryIntent, PeriodRange
from app.services.deposit_query import find_deposit_gaps, list_deposits

logger = logging.getLogger(__name__)

ALLOWED_QUERY_TYPES = {"list", "sum", "count", "gap_analysis", "compare_periods"}
OUT_OF_SCOPE_KEYWORDS = (
    "expense",
    "electricity",
    "credit card",
    "invoice",
    "receipt",
    "whatsapp",
    "standing order",
    "utility bill",
    "maintenance cost",
)
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
                detail="This question is outside MVP scope. Only deposit and income queries are supported.",
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
        logger.info("ai_query query_type=%s parser=%s", intent.query_type, parser)

        return AIQueryResponse(
            answer=answer,
            data=data,
            query_used=intent,
            parser=parser,
        )

    def _is_out_of_scope(self, question: str) -> bool:
        lowered = question.lower()
        if any(keyword in lowered for keyword in OUT_OF_SCOPE_KEYWORDS):
            return True
        if "expenses" in lowered and "deposit" not in lowered:
            return True
        return False

    def build_system_prompt(self) -> str:
        return (
            "You translate natural-language questions about property bank deposits into JSON intent objects. "
            "Return ONLY valid JSON matching this schema:\n"
            "{"
            '"query_type": "list|sum|count|gap_analysis|compare_periods", '
            '"property_name": string|null, "owner_name": string|null, '
            '"date_from": "YYYY-MM-DD"|null, "date_to": "YYYY-MM-DD"|null, '
            '"year": number|null, "month": number|null, '
            '"min_amount": number|null, "max_amount": number|null, '
            '"group_by": "property|owner|month"|null, '
            '"period_a": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null, '
            '"period_b": {"date_from":"YYYY-MM-DD","date_to":"YYYY-MM-DD"}|null'
            "}\n"
            "Never generate SQL. Only deposit/income questions are in scope."
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
        year = self._extract_year(lowered) or date.today().year
        month = self._extract_month(lowered)
        property_name = self._extract_property_name(lowered)
        owner_name = self._extract_owner_name(lowered)
        date_from, date_to = self._extract_date_range(lowered, year)
        min_amount, max_amount = self._extract_amount_bounds(lowered)

        if any(word in lowered for word in ("gap", "missing", "no deposit", "had no deposit")):
            return DepositQueryIntent(
                query_type="gap_analysis",
                year=year,
                month=month,
                date_from=date_from,
                date_to=date_to,
            )

        if "compare" in lowered and (" vs " in lowered or " versus " in lowered):
            period_a, period_b = self._extract_compare_periods(lowered, year)
            return DepositQueryIntent(
                query_type="compare_periods",
                property_name=property_name,
                owner_name=owner_name,
                period_a=period_a,
                period_b=period_b,
            )

        if lowered.startswith("how many") or "how many" in lowered or lowered.startswith("count"):
            date_from, date_to = date_from, date_to
            if "last 30 days" in lowered:
                date_to = date.today()
                date_from = date_to - timedelta(days=30)
            return DepositQueryIntent(
                query_type="count",
                property_name=property_name,
                owner_name=owner_name,
                date_from=date_from,
                date_to=date_to,
                year=year if not date_from else None,
                min_amount=min_amount,
                max_amount=max_amount,
            )

        if "total" in lowered or "sum" in lowered:
            group_by = None
            if "per owner" in lowered or "by owner" in lowered:
                group_by = "owner"
            elif "per property" in lowered or "by property" in lowered:
                group_by = "property"
            if "this year" in lowered:
                date_from = date(year, 1, 1)
                date_to = date(year, 12, 31)
            return DepositQueryIntent(
                query_type="sum",
                property_name=property_name,
                owner_name=owner_name,
                date_from=date_from,
                date_to=date_to,
                group_by=group_by,
                year=year if not date_from else None,
                min_amount=min_amount,
                max_amount=max_amount,
            )

        return DepositQueryIntent(
            query_type="list",
            property_name=property_name,
            owner_name=owner_name,
            date_from=date_from,
            date_to=date_to,
            year=year if not date_from else None,
            month=month,
            min_amount=min_amount,
            max_amount=max_amount,
        )

    def _validate_intent(self, intent: DepositQueryIntent) -> DepositQueryIntent:
        if intent.query_type not in ALLOWED_QUERY_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported query_type: {intent.query_type}")
        if intent.group_by and intent.group_by not in {"property", "owner", "month"}:
            raise HTTPException(status_code=400, detail=f"Unsupported group_by: {intent.group_by}")
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
        if intent.query_type == "list":
            msg = f"Found {len(data)} deposit(s) matching your query."
            if intent.min_amount is not None:
                msg += f" Filtered to amounts >= {intent.min_amount}."
            if intent.max_amount is not None:
                msg += f" Filtered to amounts <= {intent.max_amount}."
            return msg
        if intent.query_type == "count":
            count = data[0]["deposit_count"] if data else 0
            return f"There are {count} deposit(s) matching your query."
        if intent.query_type == "sum":
            if intent.group_by:
                return f"Totals grouped by {intent.group_by}: {len(data)} group(s) found."
            total = data[0]["total_amount"] if data else "0"
            count = data[0].get("deposit_count", 0) if data else 0
            return f"Total deposits: {total} ILS across {count} transaction(s)."
        if intent.query_type == "gap_analysis":
            if not data:
                return "No missing expected deposits were found for the requested period."
            names = ", ".join(item["property_name"] for item in data)
            return f"Missing expected deposits for: {names}."
        if intent.query_type == "compare_periods":
            if len(data) == 2:
                a, b = data[0], data[1]
                return (
                    f"Period A total: {a['total_amount']} ILS ({a['deposit_count']} deposits). "
                    f"Period B total: {b['total_amount']} ILS ({b['deposit_count']} deposits)."
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
