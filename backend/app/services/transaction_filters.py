"""Shared deposit/expense query filters and company-float rules.

Company float (Excel Amount / Inflow):
- Deposits count unless ``is_rental_income``
- Expenses count unless ``paid_by_resident`` or ``paid_by_owner``
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import ColumnElement, func, or_
from sqlalchemy.sql import Select

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property

SourceFileMatch = Literal["exact", "contains"]


def deposit_company_float_clause() -> ColumnElement[bool]:
    return Deposit.is_rental_income.is_(False)


def expense_company_float_clauses() -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    return (
        Expense.paid_by_resident.is_(False),
        Expense.paid_by_owner.is_(False),
    )


def deposit_counts_in_company_float(deposit: Deposit) -> bool:
    return not bool(deposit.is_rental_income)


def expense_counts_in_company_float(expense: Expense) -> bool:
    return not bool(expense.paid_by_resident) and not bool(expense.paid_by_owner)


def deposit_float_filter_clauses(
    *,
    is_rental_income: bool | None = None,
    include_all: bool = False,
) -> list[ColumnElement[bool]]:
    """Summary/aggregate float defaults. Explicit ``is_rental_income`` wins."""
    if is_rental_income is not None:
        return [Deposit.is_rental_income.is_(is_rental_income)]
    if not include_all:
        return [deposit_company_float_clause()]
    return []


def expense_float_filter_clauses(
    *,
    paid_by_resident: bool | None = None,
    paid_by_owner: bool | None = None,
    paid_by_company: bool | None = None,
    include_all: bool = False,
) -> list[ColumnElement[bool]]:
    """Summary/aggregate float defaults. Explicit payer flags win."""
    explicit_payer = (
        paid_by_resident is not None
        or paid_by_owner is not None
        or paid_by_company is not None
    )
    clauses: list[ColumnElement[bool]] = []
    if explicit_payer:
        if paid_by_resident is not None:
            clauses.append(Expense.paid_by_resident.is_(paid_by_resident))
        if paid_by_owner is not None:
            clauses.append(Expense.paid_by_owner.is_(paid_by_owner))
        if paid_by_company is not None:
            clauses.append(Expense.paid_by_company.is_(paid_by_company))
        return clauses
    if not include_all:
        clauses.extend(expense_company_float_clauses())
    return clauses


def merge_unique_ids(
    single: UUID | None,
    many: list[UUID] | None,
) -> list[UUID]:
    values = list(many or [])
    if single and single not in values:
        values.append(single)
    return values


def normalize_client_prop_codes(
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = None,
) -> list[str]:
    codes = [
        value.strip().upper()
        for value in (client_prop_ids or [])
        if value and value.strip()
    ]
    if client_prop_id and client_prop_id.strip():
        codes.append(client_prop_id.strip().upper())
    seen: set[str] = set()
    return [value for value in codes if not (value in seen or seen.add(value))]


def property_scope_clauses(
    model: type[Deposit] | type[Expense],
    *,
    property_id: UUID | None = None,
    property_ids: list[UUID] | None = None,
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = None,
    owner_id: UUID | None = None,
    owner_ids: list[UUID] | None = None,
    property_status: str | None = None,
) -> tuple[list[ColumnElement[bool]], bool]:
    """Return (clauses, needs_property_join).

    Client Prop ID filters apply only when no property UUID filter is set
    (same precedence as list_deposits / list_expenses).
    """
    clauses: list[ColumnElement[bool]] = []
    prop_ids = merge_unique_ids(property_id, property_ids)
    if len(prop_ids) == 1:
        clauses.append(model.property_id == prop_ids[0])
    elif len(prop_ids) > 1:
        clauses.append(model.property_id.in_(prop_ids))

    needs_join = False
    prop_codes = normalize_client_prop_codes(client_prop_id, client_prop_ids)
    if prop_codes and not prop_ids:
        needs_join = True
        if len(prop_codes) == 1:
            clauses.append(func.upper(Property.client_prop_id) == prop_codes[0])
        else:
            clauses.append(func.upper(Property.client_prop_id).in_(prop_codes))

    own_ids = merge_unique_ids(owner_id, owner_ids)
    if own_ids:
        needs_join = True
        if len(own_ids) == 1:
            clauses.append(Property.owner_id == own_ids[0])
        else:
            clauses.append(Property.owner_id.in_(own_ids))

    status = (property_status or "").strip().lower()
    if status in {"active", "inactive"}:
        needs_join = True
        clauses.append(Property.status == status)

    return clauses, needs_join


def common_transaction_clauses(
    model: type[Deposit] | type[Expense],
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    source_file_match: SourceFileMatch = "exact",
    needs_review: bool | None = None,
) -> list[ColumnElement[bool]]:
    clauses: list[ColumnElement[bool]] = []
    if date_from:
        clauses.append(model.transaction_date >= date_from)
    if date_to:
        clauses.append(model.transaction_date <= date_to)
    if min_amount is not None:
        clauses.append(model.amount >= min_amount)
    if max_amount is not None:
        clauses.append(model.amount <= max_amount)
    if source_file and source_file.strip():
        cleaned = source_file.strip()
        if source_file_match == "contains":
            clauses.append(model.source_file.ilike(f"%{cleaned}%"))
        else:
            clauses.append(model.source_file == cleaned)
    if needs_review is not None:
        clauses.append(model.needs_review.is_(needs_review))
    return clauses


def apply_clauses(stmt: Select[Any], clauses: list[ColumnElement[bool]]) -> Select[Any]:
    if not clauses:
        return stmt
    return stmt.where(*clauses)


def apply_property_scope(
    stmt: Select[Any],
    model: type[Deposit] | type[Expense],
    *,
    property_id: UUID | None = None,
    property_ids: list[UUID] | None = None,
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = None,
    owner_id: UUID | None = None,
    owner_ids: list[UUID] | None = None,
    property_status: str | None = None,
) -> Select[Any]:
    clauses, _ = property_scope_clauses(
        model,
        property_id=property_id,
        property_ids=property_ids,
        client_prop_id=client_prop_id,
        client_prop_ids=client_prop_ids,
        owner_id=owner_id,
        owner_ids=owner_ids,
        property_status=property_status,
    )
    return apply_clauses(stmt, clauses)


def apply_common_transaction_filters(
    stmt: Select[Any],
    model: type[Deposit] | type[Expense],
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    source_file_match: SourceFileMatch = "exact",
    needs_review: bool | None = None,
) -> Select[Any]:
    return apply_clauses(
        stmt,
        common_transaction_clauses(
            model,
            date_from=date_from,
            date_to=date_to,
            min_amount=min_amount,
            max_amount=max_amount,
            source_file=source_file,
            source_file_match=source_file_match,
            needs_review=needs_review,
        ),
    )


def apply_deposit_list_filters(
    stmt: Select[Any],
    *,
    property_id: UUID | None = None,
    property_ids: list[UUID] | None = None,
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = None,
    owner_id: UUID | None = None,
    owner_ids: list[UUID] | None = None,
    property_status: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    is_rental_income: bool | None = None,
    source: str | None = None,
    source_file_match: SourceFileMatch = "exact",
    apply_company_float_default: bool = False,
) -> Select[Any]:
    stmt = apply_property_scope(
        stmt,
        Deposit,
        property_id=property_id,
        property_ids=property_ids,
        client_prop_id=client_prop_id,
        client_prop_ids=client_prop_ids,
        owner_id=owner_id,
        owner_ids=owner_ids,
        property_status=property_status,
    )
    stmt = apply_common_transaction_filters(
        stmt,
        Deposit,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        source_file_match=source_file_match,
        needs_review=needs_review,
    )
    float_clauses = deposit_float_filter_clauses(
        is_rental_income=is_rental_income,
        include_all=not apply_company_float_default,
    )
    # When list mode (no float default), only filter if explicitly requested.
    if apply_company_float_default or is_rental_income is not None:
        stmt = apply_clauses(stmt, float_clauses)
    if source:
        stmt = stmt.where(Deposit.source == source)
    return stmt


def apply_expense_list_filters(
    stmt: Select[Any],
    *,
    property_id: UUID | None = None,
    property_ids: list[UUID] | None = None,
    client_prop_id: str | None = None,
    client_prop_ids: list[str] | None = None,
    owner_id: UUID | None = None,
    owner_ids: list[UUID] | None = None,
    property_status: str | None = None,
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    search_text: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    paid_by_resident: bool | None = None,
    paid_by_owner: bool | None = None,
    paid_by_company: bool | None = None,
    ledger_column: str | None = None,
    source_file_match: SourceFileMatch = "exact",
    apply_company_float_default: bool = False,
) -> Select[Any]:
    stmt = apply_property_scope(
        stmt,
        Expense,
        property_id=property_id,
        property_ids=property_ids,
        client_prop_id=client_prop_id,
        client_prop_ids=client_prop_ids,
        owner_id=owner_id,
        owner_ids=owner_ids,
        property_status=property_status,
    )
    stmt = apply_common_transaction_filters(
        stmt,
        Expense,
        date_from=date_from,
        date_to=date_to,
        min_amount=min_amount,
        max_amount=max_amount,
        source_file=source_file,
        source_file_match=source_file_match,
        needs_review=needs_review,
    )
    if category:
        stmt = stmt.where(Expense.category == category)
    if source:
        stmt = stmt.where(Expense.source == source)
    if payment_method:
        stmt = stmt.where(Expense.payment_method == payment_method)
    if search_text:
        pattern = f"%{search_text}%"
        stmt = stmt.where(
            or_(
                Expense.description.ilike(pattern),
                Expense.vendor_name.ilike(pattern),
            )
        )
    if apply_company_float_default or (
        paid_by_resident is not None
        or paid_by_owner is not None
        or paid_by_company is not None
    ):
        stmt = apply_clauses(
            stmt,
            expense_float_filter_clauses(
                paid_by_resident=paid_by_resident,
                paid_by_owner=paid_by_owner,
                paid_by_company=paid_by_company,
                include_all=not apply_company_float_default,
            ),
        )
    if ledger_column:
        stmt = stmt.where(Expense.ledger_column == ledger_column)
    return stmt


def collect_deposit_summary_filters(
    *,
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    property_status: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    is_rental_income: bool | None = None,
    include_all: bool = False,
) -> tuple[list[ColumnElement[bool]], bool]:
    """Return (filters, needs_property_join) for deposit summary aggregates."""
    filters = deposit_float_filter_clauses(
        is_rental_income=is_rental_income,
        include_all=include_all,
    )
    scope, needs_join = property_scope_clauses(
        Deposit,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        property_status=property_status,
    )
    filters.extend(scope)
    filters.extend(
        common_transaction_clauses(
            Deposit,
            date_from=date_from,
            date_to=date_to,
            min_amount=min_amount,
            max_amount=max_amount,
            source_file=source_file,
            needs_review=needs_review,
        )
    )
    return filters, needs_join


def collect_expense_summary_filters(
    *,
    property_id: UUID | None = None,
    client_prop_id: str | None = None,
    owner_id: UUID | None = None,
    property_status: str | None = None,
    category: str | None = None,
    source: str | None = None,
    payment_method: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    min_amount: Decimal | None = None,
    max_amount: Decimal | None = None,
    source_file: str | None = None,
    needs_review: bool | None = None,
    paid_by_resident: bool | None = None,
    paid_by_owner: bool | None = None,
    paid_by_company: bool | None = None,
    include_all: bool = False,
) -> tuple[list[ColumnElement[bool]], bool]:
    """Return (filters, needs_property_join) for expense summary aggregates."""
    filters = expense_float_filter_clauses(
        paid_by_resident=paid_by_resident,
        paid_by_owner=paid_by_owner,
        paid_by_company=paid_by_company,
        include_all=include_all,
    )
    scope, needs_join = property_scope_clauses(
        Expense,
        property_id=property_id,
        client_prop_id=client_prop_id,
        owner_id=owner_id,
        property_status=property_status,
    )
    filters.extend(scope)
    filters.extend(
        common_transaction_clauses(
            Expense,
            date_from=date_from,
            date_to=date_to,
            min_amount=min_amount,
            max_amount=max_amount,
            source_file=source_file,
            needs_review=needs_review,
        )
    )
    if category:
        filters.append(Expense.category == category)
    if source:
        filters.append(Expense.source == source)
    if payment_method:
        filters.append(Expense.payment_method == payment_method)
    return filters, needs_join
