"""Normalize DepositRead / ExpenseRead into the shared TransactionRead view model."""

from __future__ import annotations

from typing import Any

from app.schemas import TransactionRead


def _expense_notes(item: dict[str, Any]) -> str | None:
    notes = item.get("notes")
    if notes is not None and str(notes).strip():
        return str(notes).strip()
    desc = (item.get("description") or "").strip()
    section = str(item.get("category") or "").strip()
    if not desc:
        return None
    if section and desc.lower().startswith(section.lower()):
        rest = desc[len(section) :].lstrip(" |").strip()
        return rest or None
    return desc or None


def deposit_dict_to_transaction(item: dict[str, Any]) -> dict[str, Any]:
    source = item.get("source")
    if item.get("is_rental_income"):
        section = "Rental income"
    else:
        section = str(source or "Inflow").replace("_", " ")
    return TransactionRead(
        kind="deposit",
        id=item["id"],
        property_id=item["property_id"],
        transaction_date=item.get("transaction_date"),
        amount=item["amount"],
        currency=item.get("currency") or "ILS",
        client_prop_id=item.get("client_prop_id") or "",
        property_name=item.get("property_name") or "",
        owner_name=item.get("owner_name") or "",
        section=section,
        notes=item.get("description") or item.get("notes"),
        company=None,
        payment_method=None,
        source=source,
        receipt_ref=item.get("receipt_ref"),
        source_file=item.get("source_file"),
        balance_after=item.get("balance_after"),
        needs_review=bool(item.get("needs_review")),
        review_reasons=item.get("review_reasons"),
        is_rental_income=bool(item.get("is_rental_income")),
        paid_by_resident=None,
        paid_by_owner=None,
        paid_by_company=None,
        ledger_column=None,
        from_bank_statement=source == "bank_statement",
    ).model_dump(mode="json")


def expense_dict_to_transaction(item: dict[str, Any]) -> dict[str, Any]:
    source = item.get("source")
    section = item.get("category") or "other"
    return TransactionRead(
        kind="expense",
        id=item["id"],
        property_id=item["property_id"],
        transaction_date=item.get("transaction_date"),
        amount=item["amount"],
        currency=item.get("currency") or "ILS",
        client_prop_id=item.get("client_prop_id") or "",
        property_name=item.get("property_name") or "",
        owner_name=item.get("owner_name") or "",
        section=str(section),
        notes=_expense_notes(item),
        company=item.get("vendor_name") or item.get("company"),
        payment_method=item.get("payment_method"),
        source=source,
        receipt_ref=item.get("receipt_ref"),
        source_file=item.get("source_file"),
        balance_after=item.get("balance_after"),
        needs_review=bool(item.get("needs_review")),
        review_reasons=item.get("review_reasons"),
        is_rental_income=None,
        paid_by_resident=bool(item.get("paid_by_resident")),
        paid_by_owner=bool(item.get("paid_by_owner")),
        paid_by_company=bool(item.get("paid_by_company")),
        ledger_column=item.get("ledger_column"),
        from_bank_statement=source == "bank_statement",
    ).model_dump(mode="json")


def normalize_transaction_row(kind: str, item: dict[str, Any]) -> dict[str, Any]:
    if kind == "expense":
        return expense_dict_to_transaction(item)
    return deposit_dict_to_transaction(item)
