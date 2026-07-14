"""Verify imported DB rows against client Excel source files."""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import openpyxl
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property
from app.services.client_import import (
    BANK_FILE,
    CLIENT_LIST_FILE,
    CREDIT_CARD_FILES,
    MANAGEMENT_FILE,
    META_SHEETS,
    normalize_prop_key,
)


def _parse_amount(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        amount = Decimal(str(value).replace(",", "").replace("₪", "").strip())
    except (InvalidOperation, ValueError, AttributeError):
        return None
    if amount == 0:
        return None
    return abs(amount).quantize(Decimal("0.01"))


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "")).date()
    except ValueError:
        pass
    for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%Y-%m-%d", "%d.%m.%y", "%d/%m/%y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _detect_header(values: list[Any]) -> dict[str, int] | None:
    """Match ClientDataImportService._detect_ledger_header exactly."""
    normalized = []
    for v in values:
        if v is None:
            normalized.append("")
        else:
            normalized.append(re.sub(r"\s+", " ", str(v).strip().lower()))

    joined = " | ".join(normalized)
    if "date" not in joined:
        return None
    if "amount" not in joined and "inflow" not in joined:
        return None

    mapping: dict[str, int] = {}
    for idx, label in enumerate(normalized):
        if not label:
            continue
        if "prop" in label and "id" in label:
            mapping["prop_id"] = idx
        elif label == "date":
            # Prefer the first Date column (ledger); ignore later task-tracker Date cols
            if "date" not in mapping:
                mapping["date"] = idx
        elif label in {"section"}:
            mapping["section"] = idx
        elif label in {"notes", "note"}:
            mapping["notes"] = idx
        elif label == "type":
            mapping["type"] = idx
        elif label == "amount":
            mapping["amount"] = idx
        elif label == "inflow":
            mapping["inflow"] = idx
        elif (
            "he/she" in label
            or label in {"he/she paid", "she paid", "he paid"}
            or label.endswith(" she paid")
            or label.endswith(" he paid")
        ):
            mapping["he_she_paid"] = idx
        elif "אהרון" in label or "שילם" in label:
            mapping["owner_paid"] = idx
        elif label == "mip":
            mapping["mip"] = idx
        elif "nealy" in label or "nearly" in label:
            mapping["nearly_cc"] = idx
        elif label == "cash":
            mapping["cash"] = idx
        elif label == "other":
            mapping["other"] = idx
        elif "rental" in label or label == "rent":
            mapping["rental_income"] = idx
        elif label in {"method"}:
            mapping["method"] = idx
        elif "reconcil" in label:
            mapping["reconciled"] = idx
        elif label in {"company"}:
            mapping["company"] = idx
        elif "reciept" in label or "receipt" in label:
            mapping["receipt"] = idx

    if "date" in mapping and ("amount" in mapping or "inflow" in mapping):
        return mapping
    return None


def count_management_rows(path: Path) -> dict[str, int]:
    wb = openpyxl.load_workbook(path, data_only=True)
    expenses = 0
    deposits = 0
    resident_paid = 0
    owner_paid = 0
    paid_by_company = 0
    nearly_cc_paid = 0
    cash_paid = 0
    other_paid = 0
    rental_income = 0
    sheets_parsed = 0

    for sheet_name in wb.sheetnames:
        lower = sheet_name.strip().lower()
        # Skip meta sheets except Buffer (company float ledger)
        if lower in META_SHEETS and lower != "buffer":
            continue

        ws = wb[sheet_name]
        header = None
        for row in ws.iter_rows(values_only=True):
            values = list(row)
            if header is None:
                detected = _detect_header(values)
                if detected:
                    header = detected
                continue
            if not any(v is not None and str(v).strip() for v in values):
                continue

            def col(name: str) -> Any:
                idx = header.get(name)
                if idx is None or idx >= len(values):
                    return None
                return values[idx]

            tx_date = _parse_date(col("date"))
            amount = _parse_amount(col("amount"))
            inflow = _parse_amount(col("inflow"))
            resident = _parse_amount(col("he_she_paid"))
            owner = _parse_amount(col("owner_paid"))
            mip = _parse_amount(col("mip"))
            nearly_cc = _parse_amount(col("nearly_cc"))
            cash = _parse_amount(col("cash"))
            other = _parse_amount(col("other"))
            rental = _parse_amount(col("rental_income"))
            if tx_date is None:
                continue
            if amount is not None:
                expenses += 1
            if resident is not None:
                expenses += 1
                resident_paid += 1
            if owner is not None:
                expenses += 1
                owner_paid += 1
            if mip is not None:
                expenses += 1
                paid_by_company += 1
            if nearly_cc is not None:
                expenses += 1
                nearly_cc_paid += 1
            if cash is not None:
                expenses += 1
                cash_paid += 1
            if other is not None:
                expenses += 1
                other_paid += 1
            if inflow is not None:
                deposits += 1
            if rental is not None:
                deposits += 1
                rental_income += 1
        if header is not None:
            sheets_parsed += 1

    return {
        "mgmt_expense_rows": expenses,
        "mgmt_deposit_rows": deposits,
        "mgmt_resident_paid_rows": resident_paid,
        "mgmt_owner_paid_rows": owner_paid,
        "mgmt_mip_paid_rows": paid_by_company,
        "mgmt_nearly_cc_rows": nearly_cc_paid,
        "mgmt_cash_rows": cash_paid,
        "mgmt_other_rows": other_paid,
        "mgmt_rental_income_rows": rental_income,
        "sheets_parsed": sheets_parsed,
    }


def count_bank_rows(path: Path) -> dict[str, int]:
    if not path.exists():
        return {"bank_debit_rows": 0, "bank_credit_rows": 0}
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    header_row = None
    headers: list[str] = []
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        vals = [str(v).strip() if v is not None else "" for v in row]
        if "תאריך" in vals and ("בחובה" in vals or "בזכות" in vals):
            header_row = i
            headers = vals
            break
    if header_row is None:
        return {"bank_debit_rows": 0, "bank_credit_rows": 0}

    col = {name: idx for idx, name in enumerate(headers) if name}
    debits = 0
    credits = 0
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        if i <= header_row:
            continue
        values = list(row)
        date_idx = col.get("תאריך")
        if date_idx is None or date_idx >= len(values) or _parse_date(values[date_idx]) is None:
            continue
        debit_idx = col.get("בחובה")
        credit_idx = col.get("בזכות")
        if debit_idx is not None and debit_idx < len(values) and _parse_amount(values[debit_idx]):
            debits += 1
        if credit_idx is not None and credit_idx < len(values) and _parse_amount(values[credit_idx]):
            credits += 1
    return {"bank_debit_rows": debits, "bank_credit_rows": credits}


def count_cc_rows(data_dir: Path) -> dict[str, int]:
    total = 0
    credits = 0
    for name in CREDIT_CARD_FILES:
        path = data_dir / name
        if not path.exists():
            continue
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb[wb.sheetnames[0]]
        header_row = None
        headers: list[str] = []
        for i, row in enumerate(ws.iter_rows(values_only=True), 1):
            vals = [str(v).strip() if v is not None else "" for v in row]
            if "תאריך העסקה" in vals and "סכום חיוב" in vals:
                header_row = i
                headers = vals
                break
        if header_row is None:
            continue
        col = {name: idx for idx, name in enumerate(headers) if name}
        for i, row in enumerate(ws.iter_rows(values_only=True), 1):
            if i <= header_row:
                continue
            values = list(row)
            if any(v is not None and "סה" in str(v) for v in values[:5]):
                continue
            date_idx = col.get("תאריך העסקה")
            charge_idx = col.get("סכום חיוב")
            merchant_idx = col.get("שם בית העסק")
            if date_idx is None or charge_idx is None:
                continue
            if date_idx >= len(values) or _parse_date(values[date_idx]) is None:
                continue
            if merchant_idx is not None and merchant_idx < len(values):
                if values[merchant_idx] is None:
                    continue
            try:
                charge = Decimal(str(values[charge_idx]))
            except Exception:
                continue
            if charge < 0:
                credits += 1
            elif charge > 0:
                total += 1
    return {"cc_expense_rows": total, "cc_credit_rows": credits}


def count_client_list_properties(path: Path) -> int:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["current clients"]
    keys: set[str] = set()
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        if i == 1:
            continue
        key = normalize_prop_key(row[0] if row else None)
        if key:
            keys.add(key)
    return len(keys)


def verify_against_excel(db: Session, data_dir: Path) -> dict[str, Any]:
    mgmt = count_management_rows(data_dir / MANAGEMENT_FILE)
    bank = count_bank_rows(data_dir / BANK_FILE)
    cc = count_cc_rows(data_dir)
    client_props = count_client_list_properties(data_dir / CLIENT_LIST_FILE)

    expected_expenses = (
        mgmt["mgmt_expense_rows"] + bank["bank_debit_rows"] + cc["cc_expense_rows"]
    )
    expected_deposits = (
        mgmt["mgmt_deposit_rows"] + bank["bank_credit_rows"] + cc["cc_credit_rows"]
    )

    db_expenses = db.scalar(select(func.count()).select_from(Expense)) or 0
    db_deposits = db.scalar(select(func.count()).select_from(Deposit)) or 0
    db_props = db.scalar(select(func.count()).select_from(Property)) or 0
    db_owners = db.scalar(select(func.count()).select_from(Owner)) or 0

    ledger_expenses = (
        db.scalar(
            select(func.count()).select_from(Expense).where(Expense.source == "management_ledger")
        )
        or 0
    )
    # management_ledger + credit_card method mapped sources also count; count by import_key prefix
    mgmt_exp_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.import_key.like("mgmt:%"))
        )
        or 0
    )
    mgmt_dep_db = (
        db.scalar(
            select(func.count())
            .select_from(Deposit)
            .where(Deposit.import_key.like("mgmt:%"))
        )
        or 0
    )

    mgmt_resident_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.paid_by_resident.is_(True))
        )
        or 0
    )

    mgmt_rental_db = (
        db.scalar(
            select(func.count())
            .select_from(Deposit)
            .where(Deposit.is_rental_income.is_(True))
        )
        or 0
    )

    mgmt_mip_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.paid_by_company.is_(True))
        )
        or 0
    )

    mgmt_owner_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.paid_by_owner.is_(True))
        )
        or 0
    )

    mgmt_nearly_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.ledger_column == "nearly_cc")
        )
        or 0
    )
    mgmt_cash_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.ledger_column == "cash")
        )
        or 0
    )
    mgmt_other_db = (
        db.scalar(
            select(func.count())
            .select_from(Expense)
            .where(Expense.ledger_column == "other")
        )
        or 0
    )

    mismatches: list[str] = []
    if mgmt_exp_db != mgmt["mgmt_expense_rows"]:
        mismatches.append(
            f"Management expenses: excel={mgmt['mgmt_expense_rows']} db={mgmt_exp_db}"
        )
    if mgmt_dep_db != mgmt["mgmt_deposit_rows"]:
        mismatches.append(
            f"Management deposits: excel={mgmt['mgmt_deposit_rows']} db={mgmt_dep_db}"
        )
    if mgmt_resident_db != mgmt["mgmt_resident_paid_rows"]:
        mismatches.append(
            f"Resident-paid expenses: excel={mgmt['mgmt_resident_paid_rows']} db={mgmt_resident_db}"
        )
    if mgmt_owner_db != mgmt["mgmt_owner_paid_rows"]:
        mismatches.append(
            f"Owner-paid expenses: excel={mgmt['mgmt_owner_paid_rows']} db={mgmt_owner_db}"
        )
    if mgmt_mip_db != mgmt["mgmt_mip_paid_rows"]:
        mismatches.append(
            f"MIP-paid expenses: excel={mgmt['mgmt_mip_paid_rows']} db={mgmt_mip_db}"
        )
    if mgmt_nearly_db != mgmt["mgmt_nearly_cc_rows"]:
        mismatches.append(
            f"Nearly CC expenses: excel={mgmt['mgmt_nearly_cc_rows']} db={mgmt_nearly_db}"
        )
    if mgmt_cash_db != mgmt["mgmt_cash_rows"]:
        mismatches.append(
            f"Cash expenses: excel={mgmt['mgmt_cash_rows']} db={mgmt_cash_db}"
        )
    if mgmt_other_db != mgmt["mgmt_other_rows"]:
        mismatches.append(
            f"Other-column expenses: excel={mgmt['mgmt_other_rows']} db={mgmt_other_db}"
        )
    if mgmt_rental_db != mgmt["mgmt_rental_income_rows"]:
        mismatches.append(
            f"Rental income: excel={mgmt['mgmt_rental_income_rows']} db={mgmt_rental_db}"
        )

    # Properties: at least current client list + BUFFER
    if db_props < client_props + 1:
        mismatches.append(
            f"Properties: expected at least {client_props + 1} (clients+BUFFER), db={db_props}"
        )

    ok = len(mismatches) == 0
    return {
        "ok": ok,
        "mismatches": mismatches,
        "excel": {
            "current_client_properties": client_props,
            **mgmt,
            **bank,
            **cc,
            "expected_expenses_total": expected_expenses,
            "expected_deposits_total": expected_deposits,
        },
        "database": {
            "owners": db_owners,
            "properties": db_props,
            "expenses": db_expenses,
            "deposits": db_deposits,
            "mgmt_expenses": mgmt_exp_db,
            "mgmt_deposits": mgmt_dep_db,
            "resident_paid_expenses": mgmt_resident_db,
            "owner_paid_expenses": mgmt_owner_db,
            "mip_paid_expenses": mgmt_mip_db,
            "nearly_cc_expenses": mgmt_nearly_db,
            "cash_expenses": mgmt_cash_db,
            "other_column_expenses": mgmt_other_db,
            "rental_income_deposits": mgmt_rental_db,
            "ledger_source_expenses": ledger_expenses,
        },
    }
