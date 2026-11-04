"""Import client Excel workbooks into SimplifAI.

Supported sources (data/ClientData):
- client list to print.xlsx  → owners + properties
- Management expenses sheet.xlsx → per-property expenses + inflows (deposits)
- Bank Account example.xlsx → company bank statement rows
- credit card 1/2 example.xlsx → credit-card expenses

Designed for idempotent re-runs via import_key on deposits/expenses.
"""

from __future__ import annotations

import gc
import logging
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import openpyxl
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import PROJECT_ROOT, get_settings
from app.models.bank_account import BankAccount
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.owner import Owner
from app.models.property import Property

logger = logging.getLogger(__name__)

CLIENT_DATA_DIR = PROJECT_ROOT / "data" / "ClientData"
CLIENT_LIST_FILE = "client list to print.xlsx"
PAST_CLIENT_LIST_FILE = "past client list.xlsx"
MANAGEMENT_FILE = "Management expenses sheet.xlsx"
BANK_FILE = "Bank Account example.xlsx"
CREDIT_CARD_FILES = ("credit card 1 example.xlsx", "credit card 2 example.xlsx")

# Cap detailed skip rows kept in memory (report still built from what we keep).
MAX_SKIPPED_ROW_DETAILS = 2500
MAX_WARNING_MESSAGES = 200
COMMIT_EVERY_N_ROWS = 150

ProgressCallback = Callable[[str], None]

META_SHEETS = {
    "prop id",
    "dashboard",
    "buffer",
    "oldbuffer",
    "expenses",
    "bills",
    "clients",
    "convert clients",
}

# Tabs that mix several properties on one sheet (per-row Prop ID, no sheet default).
COMBINED_SHEET_NAMES = {
    "801-618- 619",
    "801-618-619",
}

BUFFER_PROP_ID = "BUFFER"
BUFFER_OWNER_NAME = "BUFFER"
SHARED_PROP_PREFIX = "SHARED-"
COMPANY_OWNER_NAME = "My Israel Property (MIP)"
PAST_CLIENTS_OWNER_NAME = "PAST CLIENTS"
COMPANY_ACCOUNT_NUMBER = "MIP-LEUMI-OPS"
COMPANY_CC_ACCOUNT_PREFIX = "MIP-LEUMI-CC-"
_COMBINED_PROP_SPLIT = re.compile(r"[\/+]")


def split_combined_prop_keys(raw: Any) -> list[str]:
    """Split a combined Excel Prop ID such as '618/619/801' or '618+801'."""
    if raw is None:
        return []
    text = str(raw).strip()
    if not text:
        return []
    keys: list[str] = []
    seen: set[str] = set()
    for part in _COMBINED_PROP_SPLIT.split(text):
        key = normalize_prop_key(part)
        if key and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def is_combined_prop_id(raw: Any) -> bool:
    if raw is None:
        return False
    text = str(raw).strip()
    if "/" not in text and "+" not in text:
        return False
    return len(split_combined_prop_keys(text)) >= 2


def owner_shared_client_prop_id(owner_name: str) -> str:
    """Stable per-owner Prop ID for money split across that owner's properties."""
    slug = re.sub(r"[^A-Za-z0-9]+", "", owner_name).upper() or "OWNER"
    return f"{SHARED_PROP_PREFIX}{slug[:40]}"


def looks_like_shared_prop(*values: Any) -> bool:
    for value in values:
        text = str(value or "").lower()
        if "shared" in text or "shered" in text:
            return True
    return False


def unique_listed_prefix_match(key: str, listed_ids: Iterable[str]) -> str | None:
    """Map a truncated ledger code onto a unique listed Final # (1008BEL → 1008BELL)."""
    if not key:
        return None
    matches = sorted({cid for cid in listed_ids if cid.startswith(key) and cid != key})
    if len(matches) == 1:
        return matches[0]
    return None


def unique_listed_stem_match(key: str, listed_ids: Iterable[str]) -> str | None:
    """Map an extended ledger tab onto a unique listed Final # (707SETH → 707).

    The extra suffix must be letters only so 7071 does not steal listed 707,
    and H111 does not match 111.
    """
    if not key:
        return None
    matches: list[str] = []
    for cid in listed_ids:
        if not cid or cid == key or not key.startswith(cid):
            continue
        rest = key[len(cid) :]
        if rest.isalpha():
            matches.append(cid)
    if not matches:
        return None
    matches = sorted(set(matches), key=len, reverse=True)
    longest = len(matches[0])
    top = [cid for cid in matches if len(cid) == longest]
    if len(top) == 1:
        return top[0]
    return None


def unique_listed_alias_match(key: str, listed_ids: Iterable[str]) -> str | None:
    return unique_listed_prefix_match(key, listed_ids) or unique_listed_stem_match(
        key, listed_ids
    )


def parse_active_flag(raw: Any) -> bool | None:
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    if text in {"yes", "y", "true", "1", "active"}:
        return True
    if text in {"no", "n", "false", "0", "inactive"}:
        return False
    return None


def client_list_sheet_key(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip().lower()


def pick_client_list_main_sheet(sheet_names: list[str]) -> str | None:
    for name in sheet_names:
        key = client_list_sheet_key(name)
        if key in {"all clients", "current clients"}:
            return name
    return sheet_names[0] if sheet_names else None


def detect_client_list_header(values: list[Any]) -> dict[str, int] | None:
    """Map named client-list columns (Final #, Active, …) to indexes."""
    labels: list[str] = []
    for value in values:
        if value is None:
            labels.append("")
        else:
            labels.append(re.sub(r"\s+", " ", str(value).strip().lower()))
    mapping: dict[str, int] = {}
    for idx, label in enumerate(labels):
        if not label:
            continue
        if "final" in label:
            mapping["final_id"] = idx
        elif "hidden" in label and "sheet" in label:
            mapping["sheet_id"] = idx
        elif (
            ("property" in label and "number" in label)
            or ("property" in label and "#" in label)
            or label in {"#", "prop id", "property #"}
        ):
            mapping.setdefault("prop_number", idx)
        elif "owner" in label:
            mapping.setdefault("owner_name", idx)
        elif label in {"last name", "last"} or (
            label == "name" and "last_name" not in mapping and "first" not in label
        ):
            mapping["last_name"] = idx
        elif "first" in label:
            mapping["first_name"] = idx
        elif "שם" in label:
            mapping["hebrew"] = idx
        elif "address" in label:
            mapping["address"] = idx
        elif label == "city":
            mapping["city"] = idx
        elif label == "active":
            mapping["active"] = idx
    if "final_id" in mapping or "prop_number" in mapping or "sheet_id" in mapping:
        return mapping
    return None


def detect_past_client_list_header(values: list[Any]) -> dict[str, int] | None:
    """Require Hidden Sheet plus Property # or Owner(s).

    Title/subtitle rows mention “hidden sheets” in one cell and must not match.
    """
    mapping = detect_client_list_header(values)
    if not mapping or "sheet_id" not in mapping:
        return None
    if "prop_number" not in mapping and "owner_name" not in mapping:
        return None
    nonempty = sum(1 for value in values if value is not None and str(value).strip())
    if nonempty < 2:
        return None
    return mapping


def iter_past_client_list_data_rows(ws):
    header: dict[str, int] | None = None
    for row in ws.iter_rows(values_only=True):
        values = list(row)
        if header is None:
            detected = detect_past_client_list_header(values)
            if detected:
                header = detected
            continue
        yield header, values


def past_client_owner_label(raw: Any) -> str | None:
    text = excel_cell_label(raw)
    if not text:
        return None
    if text.strip().lower() in {"not found", "unknown", "none", "n/a"}:
        return None
    return text.strip()


def looks_like_prop_id(key: str) -> bool:
    """True for ledger-style codes (H111, 22, TS225, 1008BELL), not notes."""
    if not key or len(key) > 24:
        return False
    return bool(re.fullmatch(r"[A-Z]{0,10}\d{1,8}[A-Z]{0,16}", key))


CLIENT_LIST_POSITIONAL_HEADER: dict[str, int] = {
    "prop_number": 0,
    "last_name": 1,
    "first_name": 2,
    "hebrew": 3,
    "address": 4,
    "city": 5,
}


def merge_client_list_header(values: list[Any] | None) -> dict[str, int]:
    header = dict(CLIENT_LIST_POSITIONAL_HEADER)
    detected = detect_client_list_header(values or [])
    if detected:
        header.update(detected)
    return header


def client_list_col(row_values: list[Any], header: dict[str, int], key: str) -> Any:
    idx = header.get(key)
    if idx is None or idx >= len(row_values):
        return None
    return row_values[idx]


def iter_client_list_data_rows(ws):
    """Yield (header, row_values) for client-list data rows, skipping the header."""
    header: dict[str, int] | None = None
    for i, row in enumerate(ws.iter_rows(values_only=True), 1):
        values = list(row)
        if header is None:
            detected = detect_client_list_header(values)
            if detected:
                header = merge_client_list_header(values)
                continue
            header = dict(CLIENT_LIST_POSITIONAL_HEADER)
            if i == 1:
                continue
        yield header, values


def sheet_uses_row_prop_ids(sheet_name: str) -> bool:
    """True for owner-label / combined tabs (e.g. Silver ex) rather than a single Prop ID."""
    if sheet_name.strip() in COMBINED_SHEET_NAMES:
        return True
    canonical = normalize_prop_key(sheet_name)
    if not canonical:
        return True
    return not re.search(r"\d", canonical)


@dataclass
class SkippedRow:
    source_file: str
    sheet: str
    row_number: int
    reason: str
    prop_id: str | None = None
    transaction_date: str | None = None
    amount: str | None = None
    inflow: str | None = None
    section: str | None = None
    notes: str | None = None
    details: str | None = None
    import_key: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_file": self.source_file,
            "sheet": self.sheet,
            "row_number": self.row_number,
            "reason": self.reason,
            "prop_id": self.prop_id,
            "transaction_date": self.transaction_date,
            "amount": self.amount,
            "inflow": self.inflow,
            "section": self.section,
            "notes": self.notes,
            "details": self.details,
            "import_key": self.import_key,
        }


@dataclass
class ImportStats:
    owners_created: int = 0
    properties_created: int = 0
    expenses_created: int = 0
    expenses_skipped: int = 0
    deposits_created: int = 0
    deposits_skipped: int = 0
    bank_accounts_created: int = 0
    rows_seen: int = 0
    rows_skipped_empty: int = 0
    needs_review_created: int = 0
    properties_marked_active: int = 0
    properties_marked_inactive: int = 0
    properties_active: int = 0
    properties_inactive: int = 0
    properties_active_ids: list[str] = field(default_factory=list)
    properties_inactive_ids: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    sheet_counts: dict[str, dict[str, int]] = field(default_factory=dict)
    skipped_rows: list[SkippedRow] = field(default_factory=list)
    skipped_rows_omitted: int = 0
    skip_reason_counts: dict[str, int] = field(default_factory=dict)
    incomplete_reason_counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "owners_created": self.owners_created,
            "properties_created": self.properties_created,
            "expenses_created": self.expenses_created,
            "expenses_skipped": self.expenses_skipped,
            "deposits_created": self.deposits_created,
            "deposits_skipped": self.deposits_skipped,
            "bank_accounts_created": self.bank_accounts_created,
            "rows_seen": self.rows_seen,
            "rows_skipped_empty": self.rows_skipped_empty,
            "needs_review_created": self.needs_review_created,
            "properties_marked_active": self.properties_marked_active,
            "properties_marked_inactive": self.properties_marked_inactive,
            "properties_active": self.properties_active,
            "properties_inactive": self.properties_inactive,
            "properties_active_ids": list(self.properties_active_ids),
            "properties_inactive_ids": list(self.properties_inactive_ids),
            "skipped_row_count": len(self.skipped_rows) + self.skipped_rows_omitted,
            "skip_reason_counts": dict(self.skip_reason_counts),
            "incomplete_reason_counts": dict(self.incomplete_reason_counts),
            "warnings": self.warnings,
            "errors": self.errors,
            "sheet_counts": self.sheet_counts,
        }


def excel_cell_label(raw: Any) -> str | None:
    """String form of an Excel cell; whole numbers drop the trailing .0."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return str(raw)
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        if raw.is_integer():
            return str(int(raw))
        return format(raw, "g")
    return _optional_str(raw)


def normalize_prop_key(raw: Any) -> str:
    """Normalize client property codes for matching.

    Examples:
      "5 or 05 ex" -> "5"
      "05 ex" -> "5"
      "C4or c4 EX" -> "C4"
      "C6 or 06 ex" -> "C6"
      "N160" -> "N160"
      "p14" -> "P14"
    """
    if raw is None:
        return ""
    if isinstance(raw, bool):
        return ""
    if isinstance(raw, int):
        text = str(raw)
    elif isinstance(raw, float):
        text = str(int(raw)) if raw.is_integer() else format(raw, "g")
    else:
        text = str(raw).strip()
    if not text:
        return ""
    if re.fullmatch(r"\d+\.0+", text):
        text = str(int(float(text)))

    # "C4or c4 EX" (missing space before or)
    text = re.sub(r"(?i)([A-Za-z0-9])or\s+", r"\1 or ", text)
    primary = re.split(r"(?i)\s+or\s+", text, maxsplit=1)[0].strip()
    primary = re.sub(r"(?i)\s*ex\s*$", "", primary).strip()
    primary = re.sub(r"\s+", "", primary).upper()
    primary = primary.replace('"', "").replace("'", "")

    if primary.isdigit():
        return str(int(primary))
    # C06 -> C6 if trailing digits have leading zeros
    m = re.match(r"^([A-Z]+)0*(\d+)$", primary)
    if m:
        return f"{m.group(1)}{int(m.group(2))}"
    return primary


def prop_key_aliases(raw: Any) -> set[str]:
    """All normalized keys that should resolve to the same property."""
    if raw is None:
        return set()
    text = str(raw).strip()
    if not text:
        return set()

    text = re.sub(r"(?i)([A-Za-z0-9])or\s+", r"\1 or ", text)
    parts = re.split(r"(?i)\s+or\s+", text)
    aliases: set[str] = set()
    for part in parts:
        key = normalize_prop_key(part)
        if key:
            aliases.add(key)
        # also keep EX form stripped already by normalize
        bare = re.sub(r"(?i)\s*ex\s*$", "", part.strip())
        bare_key = normalize_prop_key(bare)
        if bare_key:
            aliases.add(bare_key)
    return aliases


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_date(value: Any) -> date | None:
    """Parse a ledger date; reject Excel serial leftovers (year before 2000)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        # Bare Excel serial numbers (e.g. 28 → 1900-01-28) are not real transaction dates.
        return None
    else:
        text = str(value).strip()
        if not text or text.lower() in {"none", "nan", "nat"}:
            return None
        parsed = None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "")).date()
        except ValueError:
            pass
        if parsed is None:
            for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%Y-%m-%d", "%d.%m.%y", "%d/%m/%y"):
                try:
                    parsed = datetime.strptime(text, fmt).date()
                    break
                except ValueError:
                    continue
        if parsed is None:
            return None

    # Excel often turns day-only / serial cells into January 1900.
    if parsed.year < 2000:
        return None
    return parsed


def _parse_amount(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        amount = value
    else:
        text = str(value).strip().replace(",", "").replace("₪", "").replace("NIS", "")
        if not text or text.lower() in {"none", "nan"}:
            return None
        try:
            amount = Decimal(text)
        except (InvalidOperation, ValueError):
            return None
    if amount == 0:
        return None
    return abs(amount).quantize(Decimal("0.01"))


def _mgmt_import_key(
    *,
    sheet_slug: str,
    kind: str,
    date_key: str,
    amount: Decimal | str,
    prop_id: str,
    row_number: int,
    section: str | None = None,
    extra: str | None = None,
    include_section: bool = True,
) -> str:
    """Stable per-Excel-row key so same-day/same-amount ledger lines all import."""
    parts = ["mgmt", sheet_slug, kind, date_key, str(amount)]
    if extra:
        parts.append(extra)
    parts.append(prop_id)
    if include_section and section is not None:
        parts.append(section[:40])
    parts.append(f"r{row_number}")
    return ":".join(parts)


def _map_payment(method: Any) -> tuple[str, str, str | None]:
    """Return (source, payment_method, extra_reference)."""
    if method is None:
        return "management_ledger", "company_account", None
    text = str(method).strip()
    if not text:
        return "management_ledger", "company_account", None

    lower = text.lower()
    if lower in {"cc", "credit", "credit card", "mastercard"}:
        return "credit_card", "credit_card", None
    if lower in {"transfer", "bank transfer", "העברה"}:
        return "management_ledger", "bank_transfer", None
    if lower in {"cash", "מזומן"}:
        return "management_ledger", "cash", None
    if lower in {"deposit", "deposit "}:
        return "manual_owner", "bank_transfer", None
    if "buffer" in lower:
        return "management_ledger", "company_account", "from_buffer"
    # Numeric bank refs used as method in the ledger
    if re.fullmatch(r"\d{4,}", text):
        return "management_ledger", "bank_transfer", text
    return "management_ledger", "company_account", text


def _owner_display_name(last_name: Any, first_name: Any, hebrew: Any) -> str:
    last = _optional_str(last_name) or ""
    first = _optional_str(first_name) or ""
    heb = _optional_str(hebrew)
    english = " ".join(p for p in (first, last) if p).strip()
    if english and heb:
        return f"{english} ({heb})"
    return english or heb or "Unknown owner"


def _is_truthy_reconciled(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    return text in {"y", "yes", "true", "1", "v", "✓"}


class ClientDataImportService:
    def __init__(
        self,
        db: Session,
        data_dir: Path | None = None,
        progress: ProgressCallback | None = None,
    ):
        self.db = db
        self.data_dir = data_dir or CLIENT_DATA_DIR
        self.settings = get_settings()
        self.stats = ImportStats()
        self.progress = progress
        # alias_key -> client_prop_id (canonical)
        self.alias_to_prop: dict[str, str] = {}
        # client_prop_id -> Property
        self.properties_by_id: dict[str, Property] = {}
        self.existing_expense_keys: set[str] = set()
        self.existing_deposit_keys: set[str] = set()
        # Prop IDs from the client list marked Active / current — source of truth for active status.
        self.current_client_ids: set[str] = set()
        # Prop IDs seen on current or past client lists (not UI-created extras).
        self.listed_client_ids: set[str] = set()
        # owner UUID string → listed shared property client_prop_id (e.g. SHAREDSILVER)
        self.owner_shared_prop_ids: dict[str, str] = {}
        # owner UUID string → client-list shared row (created only if combined ledger rows exist)
        self.listed_shared_rows: dict[str, dict[str, Any]] = {}
        self.owners_by_name: dict[str, Owner] = {}

    def _report(self, message: str) -> None:
        if self.progress:
            self.progress(message)

    def _open_workbook(self, path: Path):
        # read_only keeps peak RAM much lower on large management ledgers
        return openpyxl.load_workbook(path, read_only=True, data_only=True)

    def _checkpoint(self) -> None:
        """Commit and release ORM identity map to limit memory growth."""
        self.db.commit()
        self.db.expire_all()
        gc.collect()

    def import_all(
        self,
        *,
        include_bank: bool = True,
        include_credit_cards: bool = True,
        include_management: bool = True,
    ) -> ImportStats:
        self._load_existing_keys()
        self._ensure_company_owner_and_buffer()
        self._report("Importing client list…")
        self._import_client_list()
        self._checkpoint()
        self._report("Importing past client list…")
        self._import_past_client_list()
        self._checkpoint()
        if include_management:
            self._report("Importing management ledger…")
            self._import_management_workbook()
            self._checkpoint()
        if include_bank:
            self._report("Importing bank statement…")
            self._import_bank_statement()
            self._checkpoint()
        if include_credit_cards:
            self._report("Importing credit cards…")
            self._import_credit_cards()
            self._checkpoint()
        self._apply_property_active_status()
        self.db.commit()
        return self.stats

    def _apply_property_active_status(self) -> None:
        """Mark current-client properties active; listed past clients inactive.

        BUFFER / Awaiting return stay active. Owner-shared buckets follow the
        owner. Properties created in the app (not on the client list) keep
        the status they already have.
        """
        active_ids: list[str] = []
        inactive_ids: list[str] = []
        from app.services.holding import AWAITING_RETURN_PROP_ID, BUFFER_PROP_ID as HOLDING_BUFFER

        holding_ids = {HOLDING_BUFFER, AWAITING_RETURN_PROP_ID}
        properties = list(self.db.scalars(select(Property).order_by(Property.client_prop_id)).all())
        owner_has_current = {
            prop.owner_id
            for prop in properties
            if prop.client_prop_id in self.current_client_ids
        }
        for prop in properties:
            previous = (prop.status or "").strip().lower()
            if prop.client_prop_id in holding_ids:
                next_status = "active"
            elif prop.client_prop_id in self.current_client_ids:
                next_status = "active"
            elif (prop.client_prop_id or "").startswith(SHARED_PROP_PREFIX):
                next_status = "active" if prop.owner_id in owner_has_current else "inactive"
            elif prop.client_prop_id in self.listed_client_ids:
                next_status = "inactive"
            else:
                next_status = previous or "inactive"
            if previous != next_status:
                if next_status == "active":
                    self.stats.properties_marked_active += 1
                else:
                    self.stats.properties_marked_inactive += 1
            prop.status = next_status
            if next_status == "active":
                active_ids.append(prop.client_prop_id)
            else:
                inactive_ids.append(prop.client_prop_id)
        self.stats.properties_active = len(active_ids)
        self.stats.properties_inactive = len(inactive_ids)
        self.stats.properties_active_ids = active_ids
        self.stats.properties_inactive_ids = inactive_ids

    def _load_existing_keys(self) -> None:
        self.existing_expense_keys = {
            k for k in self.db.scalars(select(Expense.import_key)).all() if k
        }
        self.existing_deposit_keys = {
            k for k in self.db.scalars(select(Deposit.import_key)).all() if k
        }
        for prop in self.db.scalars(select(Property)).all():
            self.properties_by_id[prop.client_prop_id] = prop
            self.alias_to_prop[normalize_prop_key(prop.client_prop_id)] = prop.client_prop_id

    def _record_skip(
        self,
        *,
        source_file: str,
        sheet: str,
        row_number: int,
        reason: str,
        prop_id: Any = None,
        transaction_date: Any = None,
        amount: Any = None,
        inflow: Any = None,
        section: Any = None,
        notes: Any = None,
        details: str | None = None,
        import_key: str | None = None,
    ) -> None:
        def _fmt(value: Any) -> str | None:
            if value is None:
                return None
            if isinstance(value, Decimal):
                return str(value)
            if isinstance(value, date):
                return value.isoformat()
            text = str(value).strip()
            return text or None

        if len(self.stats.skipped_rows) >= MAX_SKIPPED_ROW_DETAILS:
            self.stats.skipped_rows_omitted += 1
            self.stats.skip_reason_counts[reason] = (
                self.stats.skip_reason_counts.get(reason, 0) + 1
            )
            return

        self.stats.skip_reason_counts[reason] = (
            self.stats.skip_reason_counts.get(reason, 0) + 1
        )
        self.stats.skipped_rows.append(
            SkippedRow(
                source_file=source_file,
                sheet=sheet,
                row_number=row_number,
                reason=reason,
                prop_id=_fmt(prop_id),
                transaction_date=_fmt(transaction_date),
                amount=_fmt(amount),
                inflow=_fmt(inflow),
                section=_fmt(section),
                notes=_fmt(notes),
                details=details,
                import_key=import_key,
            )
        )

    def _import_incomplete_ledger_row(
        self,
        *,
        prop: Property,
        sheet_label: str,
        row_number: int,
        tx_date: date | None,
        amount: Decimal | None,
        inflow: Decimal | None,
        rental_income_amount: Decimal | None,
        section: str | None,
        notes: str | None,
        vendor: str | None,
        receipt: str | None,
        method: Any,
        reasons: list[str],
        counts: dict[str, int],
        resident_paid_amount: Decimal | None = None,
        owner_paid_amount: Decimal | None = None,
        mip_paid_amount: Decimal | None = None,
        nearly_cc_amount: Decimal | None = None,
        cash_amount: Decimal | None = None,
        other_amount: Decimal | None = None,
    ) -> None:
        """Import a row missing date and/or money as a needs_review transaction."""
        sheet_slug = re.sub(r"[^A-Za-z0-9]+", "", sheet_label).lower() or "sheet"
        reason_key = ",".join(reasons)
        date_key = tx_date.isoformat() if tx_date else "nodate"
        as_deposit = inflow is not None or rental_income_amount is not None
        source, payment_method, method_ref = _map_payment(method)
        desc_parts = [p for p in (section, notes) if p]
        description = " | ".join(desc_parts) if desc_parts else (section or "Incomplete import")
        category = (section or "incomplete_import")[:255]

        if as_deposit:
            store_amount = inflow if inflow is not None else (
                rental_income_amount if rental_income_amount is not None else Decimal("0")
            )
            is_rental = rental_income_amount is not None and inflow is None
            kind = "rental" if is_rental else "inflow"
            import_key = _mgmt_import_key(
                sheet_slug=sheet_slug,
                kind=f"incomplete:{kind}",
                date_key=date_key,
                amount=store_amount,
                prop_id=prop.client_prop_id,
                row_number=row_number,
                extra=reason_key,
                include_section=False,
            )
            if import_key in self.existing_deposit_keys:
                self.stats.deposits_skipped += 1
                self._record_skip(
                    source_file=MANAGEMENT_FILE,
                    sheet=sheet_label,
                    row_number=row_number,
                    reason="duplicate_deposit",
                    prop_id=prop.client_prop_id,
                    transaction_date=tx_date,
                    amount=store_amount,
                    inflow=inflow,
                    section=section,
                    notes=notes,
                    details="Duplicate incomplete deposit",
                    import_key=import_key,
                )
                counts["skipped"] = counts.get("skipped", 0) + 1
                return

            self.db.add(
                Deposit(
                    bank_account_id=None,
                    property_id=prop.id,
                    transaction_date=tx_date,
                    amount=store_amount,
                    currency=self.settings.default_currency,
                    reference=receipt or method_ref,
                    description=description if desc_parts else (
                        "Rental income" if is_rental else "Owner inflow / prepaid"
                    ),
                    source="rental_income" if is_rental else "management_ledger",
                    is_rental_income=is_rental,
                    import_key=import_key,
                    source_file=MANAGEMENT_FILE,
                    needs_review=True,
                    review_reasons=reason_key,
                )
            )
            self.existing_deposit_keys.add(import_key)
            self.stats.deposits_created += 1
            self.stats.needs_review_created += 1
            for reason in reasons:
                self.stats.incomplete_reason_counts[reason] = (
                    self.stats.incomplete_reason_counts.get(reason, 0) + 1
                )
            counts["deposits"] = counts.get("deposits", 0) + 1
            counts["needs_review"] = counts.get("needs_review", 0) + 1
            if is_rental:
                counts["rental_income"] = counts.get("rental_income", 0) + 1
        else:
            store_amount = next(
                (
                    v
                    for v in (
                        amount,
                        resident_paid_amount,
                        owner_paid_amount,
                        mip_paid_amount,
                        nearly_cc_amount,
                        cash_amount,
                        other_amount,
                    )
                    if v is not None
                ),
                Decimal("0"),
            )
            paid_by_resident = (
                resident_paid_amount is not None
                and amount is None
                and store_amount == resident_paid_amount
            )
            paid_by_owner = (
                owner_paid_amount is not None
                and amount is None
                and store_amount == owner_paid_amount
            )
            paid_by_company = (
                mip_paid_amount is not None
                and amount is None
                and store_amount == mip_paid_amount
            )
            ledger_column = None
            if amount is None and store_amount == nearly_cc_amount and nearly_cc_amount is not None:
                ledger_column = "nearly_cc"
                source, payment_method = "credit_card", "credit_card"
            elif amount is None and store_amount == cash_amount and cash_amount is not None:
                ledger_column = "cash"
                source, payment_method = "management_ledger", "cash"
            elif amount is None and store_amount == other_amount and other_amount is not None:
                ledger_column = "other"
                source, payment_method = "management_ledger", "company_account"
            if paid_by_resident or paid_by_owner:
                source, payment_method = "manual_owner", "owner_personal"
            elif paid_by_company:
                source, payment_method = "manual_company", "company_account"

            import_key = _mgmt_import_key(
                sheet_slug=sheet_slug,
                kind="incomplete:expense",
                date_key=date_key,
                amount=store_amount,
                prop_id=prop.client_prop_id,
                row_number=row_number,
                extra=reason_key,
                section=section or "other",
            )
            if import_key in self.existing_expense_keys:
                self.stats.expenses_skipped += 1
                self._record_skip(
                    source_file=MANAGEMENT_FILE,
                    sheet=sheet_label,
                    row_number=row_number,
                    reason="duplicate_expense",
                    prop_id=prop.client_prop_id,
                    transaction_date=tx_date,
                    amount=store_amount,
                    section=section,
                    notes=notes,
                    details="Duplicate incomplete expense",
                    import_key=import_key,
                )
                counts["skipped"] = counts.get("skipped", 0) + 1
                return

            self.db.add(
                Expense(
                    property_id=prop.id,
                    transaction_date=tx_date,
                    amount=store_amount,
                    currency=self.settings.default_currency,
                    category=category,
                    source=source,
                    payment_method=payment_method,
                    vendor_name=vendor,
                    reference=method_ref or receipt,
                    description=description,
                    notes=notes,
                    receipt_ref=receipt,
                    reconciled=False,
                    paid_by_resident=paid_by_resident,
                    paid_by_company=paid_by_company,
                    paid_by_owner=paid_by_owner,
                    ledger_column=ledger_column,
                    import_key=import_key,
                    source_file=MANAGEMENT_FILE,
                    needs_review=True,
                    review_reasons=reason_key,
                )
            )
            self.existing_expense_keys.add(import_key)
            self.stats.expenses_created += 1
            self.stats.needs_review_created += 1
            for reason in reasons:
                self.stats.incomplete_reason_counts[reason] = (
                    self.stats.incomplete_reason_counts.get(reason, 0) + 1
                )
            counts["expenses"] = counts.get("expenses", 0) + 1
            counts["needs_review"] = counts.get("needs_review", 0) + 1

    def _ensure_company_owner_and_buffer(self) -> None:
        from app.services.holding import (
            AWAITING_RETURN_PROP_ID,
            ensure_company_holdings,
        )

        buffer, awaiting = ensure_company_holdings(self.db)
        self.properties_by_id[BUFFER_PROP_ID] = buffer
        self.alias_to_prop[BUFFER_PROP_ID] = BUFFER_PROP_ID
        self.properties_by_id[AWAITING_RETURN_PROP_ID] = awaiting
        self.alias_to_prop[AWAITING_RETURN_PROP_ID] = AWAITING_RETURN_PROP_ID

        account = self.db.scalars(
            select(BankAccount).where(BankAccount.account_number == COMPANY_ACCOUNT_NUMBER)
        ).first()
        if not account:
            account = BankAccount(
                property_id=None,
                bank_name="Bank Leumi",
                account_number=COMPANY_ACCOUNT_NUMBER,
                currency=self.settings.default_currency,
                label="MIP operating account",
            )
            self.db.add(account)
            self.db.flush()
            self.stats.bank_accounts_created += 1

    def _register_aliases(self, canonical: str, raw: Any) -> None:
        for alias in prop_key_aliases(raw):
            self.alias_to_prop[alias] = canonical
        self.alias_to_prop[normalize_prop_key(canonical)] = canonical

    def _prefix_match_listed(self, key: str) -> str | None:
        matched = unique_listed_alias_match(key, self.listed_client_ids)
        if matched:
            self.alias_to_prop[key] = matched
        return matched

    def _resolve_property(self, raw: Any) -> Property | None:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None

        key = normalize_prop_key(text)
        if not key:
            return None
        # Slash/plus codes do not normalize to a single property
        if "/" in text or "+" in text:
            return None

        canonical = self.alias_to_prop.get(key)
        if not canonical:
            for alias in prop_key_aliases(text):
                canonical = self.alias_to_prop.get(alias)
                if canonical:
                    break
        if not canonical:
            canonical = self._prefix_match_listed(key)
        if not canonical:
            return None
        return self.properties_by_id.get(canonical)

    def _refresh_owners_by_name(self) -> None:
        self.owners_by_name = {owner.name: owner for owner in self.db.scalars(select(Owner)).all()}

    def _get_or_create_named_owner(self, name: str) -> Owner:
        owner = self.owners_by_name.get(name)
        if owner is None:
            owner = self.db.scalars(select(Owner).where(Owner.name == name)).first()
        if owner is None:
            owner = Owner(name=name)
            self.db.add(owner)
            self.db.flush()
            self.stats.owners_created += 1
        self.owners_by_name[name] = owner
        return owner

    def _ensure_past_clients_owner(self) -> Owner:
        existing = self.owners_by_name.get(PAST_CLIENTS_OWNER_NAME)
        if existing is not None:
            return existing
        owner = self.db.scalars(
            select(Owner).where(Owner.name == PAST_CLIENTS_OWNER_NAME)
        ).first()
        if owner is None:
            owner = Owner(name=PAST_CLIENTS_OWNER_NAME)
            self.db.add(owner)
            self.db.flush()
            self.stats.owners_created += 1
        self.owners_by_name[PAST_CLIENTS_OWNER_NAME] = owner
        return owner

    def _prop_key_is_known(self, key: str) -> bool:
        if not key:
            return False
        if key in self.properties_by_id or key in self.listed_client_ids:
            return True
        mapped = self.alias_to_prop.get(key)
        if mapped and (mapped in self.properties_by_id or mapped in self.listed_client_ids):
            return True
        return unique_listed_alias_match(key, self.listed_client_ids) is not None

    def _materialize_listed_shared_property(self, owner: Owner) -> Property | None:
        owner_key = str(owner.id)
        spec = self.listed_shared_rows.get(owner_key) or {}
        listed_key = self.owner_shared_prop_ids.get(owner_key) or spec.get("canonical")
        if not listed_key:
            return None
        existing = self.properties_by_id.get(listed_key)
        if existing is None:
            existing = self.db.scalars(
                select(Property).where(Property.client_prop_id == listed_key)
            ).first()
        if existing is not None:
            self.properties_by_id[existing.client_prop_id] = existing
            return existing
        status = spec.get("status") or "active"
        prop = Property(
            owner_id=owner.id,
            client_prop_id=listed_key,
            name=spec.get("name") or listed_key,
            status=status,
        )
        self.db.add(prop)
        self.db.flush()
        self.properties_by_id[listed_key] = prop
        self._register_aliases(listed_key, listed_key)
        for raw in spec.get("alias_raws") or []:
            self._register_aliases(listed_key, raw)
        self.listed_client_ids.add(listed_key)
        if status == "active":
            self.current_client_ids.add(listed_key)
        self.stats.properties_created += 1
        return prop

    def _get_or_create_owner_shared_property(self, owner: Owner) -> Property:
        listed = self._materialize_listed_shared_property(owner)
        if listed is not None:
            return listed
        for prop in list(self.properties_by_id.values()):
            if prop.owner_id != owner.id:
                continue
            if looks_like_shared_prop(prop.client_prop_id, prop.name):
                self.owner_shared_prop_ids[str(owner.id)] = prop.client_prop_id
                return prop

        key = owner_shared_client_prop_id(owner.name)
        existing = self.properties_by_id.get(key)
        if existing is None:
            existing = self.db.scalars(
                select(Property).where(Property.client_prop_id == key)
            ).first()
        if existing is not None:
            if existing.owner_id != owner.id:
                key = f"{key}-{str(owner.id).replace('-', '')[:8]}"[:50]
                existing = self.properties_by_id.get(key) or self.db.scalars(
                    select(Property).where(Property.client_prop_id == key)
                ).first()
            if existing is not None:
                self.properties_by_id[existing.client_prop_id] = existing
                self._register_aliases(existing.client_prop_id, existing.client_prop_id)
                return existing

        prop = Property(
            owner_id=owner.id,
            client_prop_id=key,
            name=f"{owner.name} — shared",
            status="active",
        )
        self.db.add(prop)
        self.db.flush()
        self.properties_by_id[key] = prop
        self._register_aliases(key, key)
        self.stats.properties_created += 1
        return prop

    def _resolve_combined_property(self, raw: Any) -> Property | None:
        """Map 618/619/801-style codes to that owner's shared property (BUFFER for MIP)."""
        buffer = self.properties_by_id.get(BUFFER_PROP_ID)
        keys = split_combined_prop_keys(raw)
        owners: dict[str, Owner] = {}
        for key in keys:
            prop = self._resolve_property(key)
            if prop is None:
                continue
            owner = self.db.get(Owner, prop.owner_id)
            if owner is None:
                continue
            owners[str(owner.id)] = owner
        if len(owners) != 1:
            return buffer
        owner = next(iter(owners.values()))
        if owner.name in {
            COMPANY_OWNER_NAME,
            PAST_CLIENTS_OWNER_NAME,
            BUFFER_OWNER_NAME,
        }:
            return buffer
        return self._get_or_create_owner_shared_property(owner)

    def _resolve_ledger_property(
        self,
        prop_raw: Any,
        default_prop_id: str | None,
    ) -> Property | None:
        if is_combined_prop_id(prop_raw):
            return self._resolve_combined_property(prop_raw)
        prop = self._resolve_property(prop_raw) if prop_raw is not None else None
        if prop is None and default_prop_id:
            prop = self.properties_by_id.get(default_prop_id)
        return prop

    def _import_client_list(self) -> None:
        path = self.data_dir / CLIENT_LIST_FILE
        if not path.exists():
            self.stats.errors.append(f"Missing client list: {path}")
            return

        wb = self._open_workbook(path)
        try:
            main_name = pick_client_list_main_sheet(list(wb.sheetnames))
            if main_name is None:
                self.stats.errors.append(f"Client list has no sheets: {path}")
                return
            current = wb[main_name]
            past_name = next(
                (n for n in wb.sheetnames if client_list_sheet_key(n).startswith("past")),
                None,
            )

            owners_by_name: dict[str, Owner] = {
                o.name: o for o in self.db.scalars(select(Owner)).all()
            }
            self.current_client_ids = set()

            def upsert_row(
                row_values: list[Any],
                header: dict[str, int],
                *,
                default_status: str,
            ) -> None:
                if not row_values:
                    return

                final_raw = client_list_col(row_values, header, "final_id")
                prop_number_raw = client_list_col(row_values, header, "prop_number")
                prop_raw = final_raw if excel_cell_label(final_raw) else prop_number_raw
                last_name = client_list_col(row_values, header, "last_name")
                first_name = client_list_col(row_values, header, "first_name")
                hebrew = client_list_col(row_values, header, "hebrew")
                address = client_list_col(row_values, header, "address")
                city = client_list_col(row_values, header, "city")

                if prop_raw is None:
                    return
                header_probe = str(prop_raw).strip().lower()
                if header_probe in {
                    "property number",
                    "property\nnumber",
                    "#",
                    "prop id",
                    "final #",
                    "final#",
                }:
                    return

                canonical = normalize_prop_key(prop_raw)
                if not canonical:
                    if len(self.stats.warnings) < MAX_WARNING_MESSAGES:
                        self.stats.warnings.append(
                            f"Skipped client row with empty prop id: {row_values[:3]}"
                        )
                    self._record_skip(
                        source_file=CLIENT_LIST_FILE,
                        sheet=default_status,
                        row_number=0,
                        reason="empty_prop_id",
                        details=str(row_values[:9]),
                    )
                    return

                status = default_status
                if "active" in header:
                    parsed_active = parse_active_flag(
                        client_list_col(row_values, header, "active")
                    )
                    if parsed_active is True:
                        status = "active"
                    elif parsed_active is False:
                        status = "inactive"

                owner_name = _owner_display_name(last_name, first_name, hebrew)
                owner = owners_by_name.get(owner_name)
                if not owner:
                    owner = Owner(name=owner_name)
                    self.db.add(owner)
                    self.db.flush()
                    owners_by_name[owner_name] = owner
                    self.stats.owners_created += 1

                existing = self.properties_by_id.get(canonical)
                if existing is None:
                    existing = self.db.scalars(
                        select(Property).where(Property.client_prop_id == canonical)
                    ).first()

                addr = _optional_str(address)
                city_s = _optional_str(city)
                label = excel_cell_label(final_raw) or excel_cell_label(prop_number_raw)
                display_name = f"{addr}" if addr else (label or f"Property {canonical}")
                if city_s and addr:
                    display_name = f"{addr}, {city_s}"

                if looks_like_shared_prop(final_raw, prop_number_raw, canonical, display_name):
                    # Remember the listed shared ID, but only create the property
                    # if a later ledger row actually splits across properties.
                    self.owner_shared_prop_ids[str(owner.id)] = canonical
                    self.listed_shared_rows[str(owner.id)] = {
                        "canonical": canonical,
                        "name": display_name,
                        "status": status,
                        "alias_raws": [
                            raw
                            for raw in (prop_raw, prop_number_raw, final_raw)
                            if raw is not None
                        ],
                    }
                    return

                if existing is None:
                    existing = Property(
                        owner_id=owner.id,
                        client_prop_id=canonical,
                        name=display_name,
                        address=addr,
                        city=city_s,
                        status=status,
                    )
                    self.db.add(existing)
                    self.db.flush()
                    self.stats.properties_created += 1
                else:
                    # Keep current list as source of truth when overlapping
                    if status == "active" or existing.status != "active":
                        existing.owner_id = owner.id
                        existing.name = display_name
                        existing.address = addr
                        existing.city = city_s
                        existing.status = status

                self.properties_by_id[canonical] = existing
                self._register_aliases(canonical, prop_raw)
                if prop_number_raw is not None and excel_cell_label(prop_number_raw):
                    self._register_aliases(canonical, prop_number_raw)
                if final_raw is not None and excel_cell_label(final_raw):
                    self._register_aliases(canonical, final_raw)
                self.listed_client_ids.add(canonical)
                if status == "active":
                    self.current_client_ids.add(canonical)

            def import_sheet(ws, *, default_status: str, skip_if_listed: bool) -> None:
                for header, values in iter_client_list_data_rows(ws):
                    if skip_if_listed:
                        probe = None
                        for key in ("final_id", "prop_number"):
                            idx = header.get(key)
                            if idx is not None and idx < len(values) and values[idx] is not None:
                                probe = values[idx]
                                break
                        if probe is None and values:
                            probe = values[0]
                        canonical = normalize_prop_key(probe)
                        mapped = self.alias_to_prop.get(canonical, canonical)
                        if canonical and mapped in self.properties_by_id:
                            self._register_aliases(mapped, probe)
                            self.listed_client_ids.add(mapped)
                            continue
                    upsert_row(values, header, default_status=default_status)

            import_sheet(current, default_status="active", skip_if_listed=False)

            if past_name:
                import_sheet(wb[past_name], default_status="inactive", skip_if_listed=True)

            self.db.flush()
        finally:
            wb.close()
            gc.collect()

    def _register_past_prop_aliases(
        self,
        canonical: str,
        *,
        prop_raw: Any,
        sheet_raw: Any,
        prop_number_raw: Any,
    ) -> None:
        self._register_aliases(canonical, prop_raw)
        if sheet_raw is not None and excel_cell_label(sheet_raw):
            self._register_aliases(canonical, sheet_raw)
        number_key = normalize_prop_key(prop_number_raw)
        if (
            number_key
            and not self._prop_key_is_known(number_key)
            and not is_combined_prop_id(prop_number_raw)
        ):
            self._register_aliases(canonical, prop_number_raw)

    def _import_past_client_list(self) -> None:
        path = self.data_dir / PAST_CLIENT_LIST_FILE
        if not path.exists():
            return

        self._refresh_owners_by_name()
        wb = self._open_workbook(path)
        try:
            for header, values in iter_past_client_list_data_rows(wb[wb.sheetnames[0]]):
                sheet_raw = client_list_col(values, header, "sheet_id")
                prop_number_raw = client_list_col(values, header, "prop_number")
                owner_raw = client_list_col(values, header, "owner_name")
                prop_raw = sheet_raw if excel_cell_label(sheet_raw) else prop_number_raw
                canonical = normalize_prop_key(prop_raw)
                if not canonical or not looks_like_prop_id(canonical):
                    continue
                if looks_like_shared_prop(sheet_raw, prop_number_raw, canonical):
                    continue
                if self._prop_key_is_known(canonical):
                    number_key = normalize_prop_key(prop_number_raw)
                    if (
                        number_key
                        and not self._prop_key_is_known(number_key)
                        and not is_combined_prop_id(prop_number_raw)
                    ):
                        mapped = self.alias_to_prop.get(canonical, canonical)
                        self._register_aliases(mapped, prop_number_raw)
                    continue

                owner_label = past_client_owner_label(owner_raw)
                if not owner_label:
                    # “Not found” / blank — leftover ledger tabs land on PAST CLIENTS later.
                    continue

                owner = self._get_or_create_named_owner(owner_label)
                sheet_label = excel_cell_label(sheet_raw) or canonical
                existing = self.properties_by_id.get(canonical) or self.db.scalars(
                    select(Property).where(Property.client_prop_id == canonical)
                ).first()
                if existing is None:
                    existing = Property(
                        owner_id=owner.id,
                        client_prop_id=canonical,
                        name=sheet_label,
                        status="inactive",
                    )
                    self.db.add(existing)
                    self.db.flush()
                    self.stats.properties_created += 1
                else:
                    existing.owner_id = owner.id
                    existing.name = sheet_label
                    existing.status = "inactive"

                self.properties_by_id[canonical] = existing
                self._register_past_prop_aliases(
                    canonical,
                    prop_raw=prop_raw,
                    sheet_raw=sheet_raw,
                    prop_number_raw=prop_number_raw,
                )
                self.listed_client_ids.add(canonical)
            self.db.flush()
        finally:
            wb.close()
            gc.collect()

    def _import_management_workbook(self) -> None:
        path = self.data_dir / MANAGEMENT_FILE
        if not path.exists():
            self.stats.errors.append(f"Missing management workbook: {path}")
            return

        wb = self._open_workbook(path)
        try:
            # Import Buffer sheet onto BUFFER property
            if "Buffer" in wb.sheetnames:
                self._import_ledger_sheet(wb["Buffer"], default_prop_id=BUFFER_PROP_ID, sheet_label="Buffer")

            for sheet_name in wb.sheetnames:
                if sheet_name.strip().lower() in META_SHEETS:
                    continue
                # Combined / owner-label sheets (Silver ex, 801-618-619) use per-row Prop ID
                if sheet_uses_row_prop_ids(sheet_name) and self._resolve_property(sheet_name) is None:
                    self._report(f"Importing sheet {sheet_name}…")
                    self._import_ledger_sheet(
                        wb[sheet_name], default_prop_id=None, sheet_label=sheet_name
                    )
                    self._checkpoint()
                    continue

                prop = self._resolve_property(sheet_name)
                if prop is None:
                    # Auto-create property from sheet name so we don't lose history
                    canonical = normalize_prop_key(sheet_name)
                    if not canonical:
                        self.stats.warnings.append(f"Skipping sheet with unusable name: {sheet_name!r}")
                        continue
                    past_owner = self._ensure_past_clients_owner()
                    prop = Property(
                        owner_id=past_owner.id,
                        client_prop_id=canonical,
                        name=f"Property {canonical} (from ledger)",
                        status="inactive",
                    )
                    self.db.add(prop)
                    self.db.flush()
                    self.properties_by_id[canonical] = prop
                    self._register_aliases(canonical, sheet_name)
                    self.stats.properties_created += 1
                    if len(self.stats.warnings) < MAX_WARNING_MESSAGES:
                        self.stats.warnings.append(
                            f"Created property {canonical} from sheet {sheet_name!r} (not in client list)"
                        )

                self._report(f"Importing sheet {sheet_name}…")
                self._import_ledger_sheet(
                    wb[sheet_name],
                    default_prop_id=prop.client_prop_id,
                    sheet_label=sheet_name,
                )
                self._checkpoint()

            self.db.flush()
        finally:
            wb.close()
            gc.collect()

    def _import_ledger_sheet(
        self,
        ws,
        *,
        default_prop_id: str | None,
        sheet_label: str,
    ) -> None:
        counts = {
            "expenses": 0,
            "deposits": 0,
            "skipped": 0,
            "seen": 0,
            "resident_paid": 0,
            "owner_paid": 0,
            "paid_by_company": 0,
            "nearly_cc": 0,
            "cash": 0,
            "other": 0,
            "rental_income": 0,
        }
        header_idx: dict[str, int] | None = None

        # read_only mode can under-report dimensions; clear so all rows stream
        reset_dims = getattr(ws, "reset_dimensions", None)
        if callable(reset_dims):
            reset_dims()

        for row_number, row in enumerate(ws.iter_rows(values_only=True), 1):
            values = list(row)
            if not any(v is not None and str(v).strip() != "" for v in values):
                continue

            if header_idx is None:
                mapped = self._detect_ledger_header(values)
                if mapped:
                    header_idx = mapped
                    continue
                # Some sheets may have title rows — keep scanning
                continue

            counts["seen"] += 1
            self.stats.rows_seen += 1
            if counts["seen"] % COMMIT_EVERY_N_ROWS == 0:
                self._checkpoint()

            def col(name: str) -> Any:
                idx = header_idx.get(name)  # type: ignore[union-attr]
                if idx is None or idx >= len(values):
                    return None
                return values[idx]

            prop_raw = col("prop_id")
            prop = self._resolve_ledger_property(prop_raw, default_prop_id)
            if prop is None:
                counts["skipped"] += 1
                self.stats.rows_skipped_empty += 1
                if len(self.stats.warnings) < 50:
                    self.stats.warnings.append(
                        f"{sheet_label} R{row_number}: could not resolve property {prop_raw!r}"
                    )
                self._record_skip(
                    source_file=MANAGEMENT_FILE,
                    sheet=sheet_label,
                    row_number=row_number,
                    reason="unresolved_property",
                    prop_id=prop_raw,
                    transaction_date=col("date"),
                    amount=col("amount"),
                    inflow=col("inflow"),
                    section=col("section") or col("type"),
                    notes=col("notes"),
                    details="Could not match Prop ID to a property",
                )
                continue

            tx_date = _parse_date(col("date"))
            amount = _parse_amount(col("amount"))
            inflow = _parse_amount(col("inflow"))
            resident_paid_amount = _parse_amount(col("he_she_paid"))
            owner_paid_amount = _parse_amount(col("owner_paid"))
            mip_paid_amount = _parse_amount(col("mip"))
            nearly_cc_amount = _parse_amount(col("nearly_cc"))
            cash_amount = _parse_amount(col("cash"))
            other_amount = _parse_amount(col("other"))
            rental_income_amount = _parse_amount(col("rental_income"))
            section = _optional_str(col("section")) or _optional_str(col("type")) or "other"
            notes = _optional_str(col("notes"))
            vendor = _optional_str(col("company"))
            receipt = _optional_str(col("receipt"))
            method = col("method")
            reconciled = _is_truthy_reconciled(col("reconciled"))

            if tx_date is None:
                # Starting balance / header-like rows stay skipped
                if section and "starting" in section.lower():
                    counts["skipped"] += 1
                    self._record_skip(
                        source_file=MANAGEMENT_FILE,
                        sheet=sheet_label,
                        row_number=row_number,
                        reason="starting_balance",
                        prop_id=prop.client_prop_id,
                        transaction_date=col("date"),
                        amount=amount,
                        inflow=inflow,
                        section=section,
                        notes=notes,
                        details="Starting-balance / opening row (intentionally skipped)",
                    )
                    continue

                reasons = ["missing_date"]
                has_money = any(
                    v is not None
                    for v in (
                        amount,
                        inflow,
                        resident_paid_amount,
                        owner_paid_amount,
                        mip_paid_amount,
                        nearly_cc_amount,
                        cash_amount,
                        other_amount,
                        rental_income_amount,
                    )
                )
                if not has_money:
                    reasons.append("no_money_columns")
                self._import_incomplete_ledger_row(
                    prop=prop,
                    sheet_label=sheet_label,
                    row_number=row_number,
                    tx_date=None,
                    amount=amount,
                    inflow=inflow,
                    rental_income_amount=rental_income_amount,
                    resident_paid_amount=resident_paid_amount,
                    owner_paid_amount=owner_paid_amount,
                    mip_paid_amount=mip_paid_amount,
                    nearly_cc_amount=nearly_cc_amount,
                    cash_amount=cash_amount,
                    other_amount=other_amount,
                    section=section,
                    notes=notes,
                    vendor=vendor,
                    receipt=receipt,
                    method=method,
                    reasons=reasons,
                    counts=counts,
                )
                continue

            # Any money column on the ledger row
            if (
                amount is None
                and inflow is None
                and resident_paid_amount is None
                and owner_paid_amount is None
                and mip_paid_amount is None
                and nearly_cc_amount is None
                and cash_amount is None
                and other_amount is None
                and rental_income_amount is None
            ):
                self._import_incomplete_ledger_row(
                    prop=prop,
                    sheet_label=sheet_label,
                    row_number=row_number,
                    tx_date=tx_date,
                    amount=None,
                    inflow=None,
                    rental_income_amount=None,
                    section=section,
                    notes=notes,
                    vendor=vendor,
                    receipt=receipt,
                    method=method,
                    reasons=["no_money_columns"],
                    counts=counts,
                )
                continue

            source, payment_method, method_ref = _map_payment(method)
            sheet_slug = re.sub(r"[^A-Za-z0-9]+", "", sheet_label).lower() or "sheet"
            desc_parts = [p for p in (section, notes) if p]
            description = " | ".join(desc_parts) if desc_parts else section

            def add_expense(
                *,
                key_kind: str,
                exp_amount: Decimal,
                exp_source: str,
                exp_method: str,
                paid_by_resident: bool = False,
                paid_by_company: bool = False,
                paid_by_owner: bool = False,
                ledger_column: str | None = None,
                count_key: str | None = None,
            ) -> None:
                date_key = tx_date.isoformat() if tx_date else "nodate"
                import_key = _mgmt_import_key(
                    sheet_slug=sheet_slug,
                    kind=key_kind,
                    date_key=date_key,
                    amount=exp_amount,
                    prop_id=prop.client_prop_id,
                    row_number=row_number,
                    section=section,
                )
                if import_key in self.existing_expense_keys:
                    self.stats.expenses_skipped += 1
                    self._record_skip(
                        source_file=MANAGEMENT_FILE,
                        sheet=sheet_label,
                        row_number=row_number,
                        reason="duplicate_expense",
                        prop_id=prop.client_prop_id,
                        transaction_date=tx_date,
                        amount=exp_amount,
                        section=section,
                        notes=notes,
                        details=f"Duplicate expense ({key_kind})",
                        import_key=import_key,
                    )
                    return
                self.db.add(
                    Expense(
                        property_id=prop.id,
                        transaction_date=tx_date,
                        amount=exp_amount,
                        currency=self.settings.default_currency,
                        category=section[:255],
                        source=exp_source,
                        payment_method=exp_method,
                        vendor_name=vendor,
                        reference=method_ref or receipt,
                        description=description,
                        notes=notes,
                        receipt_ref=receipt,
                        reconciled=reconciled,
                        paid_by_resident=paid_by_resident,
                        paid_by_company=paid_by_company,
                        paid_by_owner=paid_by_owner,
                        ledger_column=ledger_column,
                        import_key=import_key,
                        source_file=MANAGEMENT_FILE,
                    )
                )
                self.existing_expense_keys.add(import_key)
                self.stats.expenses_created += 1
                counts["expenses"] += 1
                if count_key:
                    counts[count_key] = counts.get(count_key, 0) + 1

            if amount is not None:
                add_expense(
                    key_kind="expense",
                    exp_amount=amount,
                    exp_source=source,
                    exp_method=payment_method,
                )

            # MIP column — paid by the company
            if mip_paid_amount is not None:
                add_expense(
                    key_kind="mip",
                    exp_amount=mip_paid_amount,
                    exp_source="manual_company",
                    exp_method="company_account",
                    paid_by_company=True,
                    count_key="paid_by_company",
                )

            # Resident-paid (He/She paid) — excluded from company totals
            if resident_paid_amount is not None:
                add_expense(
                    key_kind="resident",
                    exp_amount=resident_paid_amount,
                    exp_source="manual_owner",
                    exp_method="owner_personal",
                    paid_by_resident=True,
                    count_key="resident_paid",
                )

            # Owner-paid (e.g. "אהרון שילם") — excluded from company totals
            if owner_paid_amount is not None:
                add_expense(
                    key_kind="owner",
                    exp_amount=owner_paid_amount,
                    exp_source="manual_owner",
                    exp_method="owner_personal",
                    paid_by_owner=True,
                    ledger_column="owner_paid",
                    count_key="owner_paid",
                )

            # Nearly CC / Cash / Other — alternate payment lanes on some property sheets
            if nearly_cc_amount is not None:
                add_expense(
                    key_kind="nearlycc",
                    exp_amount=nearly_cc_amount,
                    exp_source="credit_card",
                    exp_method="credit_card",
                    ledger_column="nearly_cc",
                    count_key="nearly_cc",
                )

            if cash_amount is not None:
                add_expense(
                    key_kind="cash",
                    exp_amount=cash_amount,
                    exp_source="management_ledger",
                    exp_method="cash",
                    ledger_column="cash",
                    count_key="cash",
                )

            if other_amount is not None:
                add_expense(
                    key_kind="other",
                    exp_amount=other_amount,
                    exp_source="management_ledger",
                    exp_method="company_account",
                    ledger_column="other",
                    count_key="other",
                )

            if inflow is not None:
                import_key = _mgmt_import_key(
                    sheet_slug=sheet_slug,
                    kind="inflow",
                    date_key=tx_date.isoformat(),
                    amount=inflow,
                    prop_id=prop.client_prop_id,
                    row_number=row_number,
                    section=section,
                )
                if import_key not in self.existing_deposit_keys:
                    self.db.add(
                        Deposit(
                            bank_account_id=None,
                            property_id=prop.id,
                            transaction_date=tx_date,
                            amount=inflow,
                            currency=self.settings.default_currency,
                            reference=receipt or method_ref,
                            description=section if section else "Owner inflow / prepaid",
                            source="management_ledger",
                            is_rental_income=False,
                            import_key=import_key,
                            source_file=MANAGEMENT_FILE,
                        )
                    )
                    self.existing_deposit_keys.add(import_key)
                    self.stats.deposits_created += 1
                    counts["deposits"] += 1
                else:
                    self.stats.deposits_skipped += 1
                    self._record_skip(
                        source_file=MANAGEMENT_FILE,
                        sheet=sheet_label,
                        row_number=row_number,
                        reason="duplicate_deposit",
                        prop_id=prop.client_prop_id,
                        transaction_date=tx_date,
                        inflow=inflow,
                        section=section,
                        notes=notes,
                        details="Duplicate inflow deposit",
                        import_key=import_key,
                    )

            # Rental income — shown in UI, excluded from company float totals
            if rental_income_amount is not None:
                import_key = _mgmt_import_key(
                    sheet_slug=sheet_slug,
                    kind="rental",
                    date_key=tx_date.isoformat(),
                    amount=rental_income_amount,
                    prop_id=prop.client_prop_id,
                    row_number=row_number,
                    include_section=False,
                )
                if import_key not in self.existing_deposit_keys:
                    self.db.add(
                        Deposit(
                            bank_account_id=None,
                            property_id=prop.id,
                            transaction_date=tx_date,
                            amount=rental_income_amount,
                            currency=self.settings.default_currency,
                            reference=receipt or method_ref,
                            description=description if desc_parts else "Rental income",
                            source="rental_income",
                            is_rental_income=True,
                            import_key=import_key,
                            source_file=MANAGEMENT_FILE,
                        )
                    )
                    self.existing_deposit_keys.add(import_key)
                    self.stats.deposits_created += 1
                    counts["deposits"] += 1
                    counts["rental_income"] = counts.get("rental_income", 0) + 1
                else:
                    self.stats.deposits_skipped += 1
                    self._record_skip(
                        source_file=MANAGEMENT_FILE,
                        sheet=sheet_label,
                        row_number=row_number,
                        reason="duplicate_deposit",
                        prop_id=prop.client_prop_id,
                        transaction_date=tx_date,
                        amount=rental_income_amount,
                        section=section,
                        notes=notes,
                        details="Duplicate rental income deposit",
                        import_key=import_key,
                    )

        self.stats.sheet_counts[sheet_label] = counts

    def _detect_ledger_header(self, values: list[Any]) -> dict[str, int] | None:
        normalized = []
        for v in values:
            if v is None:
                normalized.append("")
            else:
                normalized.append(re.sub(r"\s+", " ", str(v).strip().lower()))

        joined = " | ".join(normalized)
        # Must look like a header row
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
                # Prefer the first Date column (ledger). Some sheets (e.g. TS 225)
                # repeat "Date" later for task tracking — do not overwrite.
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

    def _import_bank_statement(self) -> None:
        path = self.data_dir / BANK_FILE
        if not path.exists():
            self.stats.warnings.append(f"Bank statement file not found: {path.name}")
            return

        wb = openpyxl.load_workbook(path, data_only=True)
        try:
            ws = wb[wb.sheetnames[0]]
            account = self.db.scalars(
                select(BankAccount).where(BankAccount.account_number == COMPANY_ACCOUNT_NUMBER)
            ).first()
            buffer = self.properties_by_id[BUFFER_PROP_ID]

            header_row = None
            headers: list[str] = []
            for i, row in enumerate(ws.iter_rows(values_only=True), 1):
                vals = [str(v).strip() if v is not None else "" for v in row]
                if "תאריך" in vals and ("בחובה" in vals or "בזכות" in vals):
                    header_row = i
                    headers = vals
                    break

            if header_row is None:
                self.stats.errors.append("Could not find bank statement header row")
                return

            col = {name: idx for idx, name in enumerate(headers) if name}

            def get(row_vals: list[Any], name: str) -> Any:
                idx = col.get(name)
                if idx is None or idx >= len(row_vals):
                    return None
                return row_vals[idx]

            for row_number, row in enumerate(ws.iter_rows(values_only=True), 1):
                if row_number <= header_row:
                    continue
                values = list(row)
                tx_date = _parse_date(get(values, "תאריך"))
                if tx_date is None:
                    continue

                debit = _parse_amount(get(values, "בחובה"))
                credit = _parse_amount(get(values, "בזכות"))
                ref = _optional_str(get(values, "אסמכתא"))
                desc = _optional_str(get(values, "תיאור"))
                extended = _optional_str(get(values, "תאור מורחב"))
                full_desc = " | ".join(p for p in (desc, extended) if p)

                prop = self._guess_property_from_text(full_desc) or buffer

                if credit is not None:
                    import_key = f"bank:{COMPANY_ACCOUNT_NUMBER}:credit:{tx_date}:{credit}:{ref or ''}"
                    if import_key not in self.existing_deposit_keys:
                        self.db.add(
                            Deposit(
                                bank_account_id=account.id if account else None,
                                property_id=prop.id,
                                transaction_date=tx_date,
                                amount=credit,
                                currency=self.settings.default_currency,
                                reference=ref,
                                description=full_desc,
                                source="bank_statement",
                                import_key=import_key,
                                source_file=BANK_FILE,
                            )
                        )
                        self.existing_deposit_keys.add(import_key)
                        self.stats.deposits_created += 1
                    else:
                        self.stats.deposits_skipped += 1
                        self._record_skip(
                            source_file=BANK_FILE,
                            sheet=ws.title,
                            row_number=row_number,
                            reason="duplicate_deposit",
                            prop_id=prop.client_prop_id,
                            transaction_date=tx_date,
                            amount=credit,
                            notes=full_desc,
                            details="Duplicate bank credit",
                            import_key=import_key,
                        )

                if debit is not None:
                    import_key = f"bank:{COMPANY_ACCOUNT_NUMBER}:debit:{tx_date}:{debit}:{ref or ''}"
                    if import_key not in self.existing_expense_keys:
                        self.db.add(
                            Expense(
                                property_id=prop.id,
                                transaction_date=tx_date,
                                amount=debit,
                                currency=self.settings.default_currency,
                                category=desc or "bank_transfer",
                                source="bank_statement",
                                payment_method="bank_transfer",
                                vendor_name=None,
                                reference=ref,
                                description=full_desc,
                                receipt_ref=ref,
                                reconciled=False,
                                import_key=import_key,
                                source_file=BANK_FILE,
                            )
                        )
                        self.existing_expense_keys.add(import_key)
                        self.stats.expenses_created += 1
                    else:
                        self.stats.expenses_skipped += 1
                        self._record_skip(
                            source_file=BANK_FILE,
                            sheet=ws.title,
                            row_number=row_number,
                            reason="duplicate_expense",
                            prop_id=prop.client_prop_id,
                            transaction_date=tx_date,
                            amount=debit,
                            notes=full_desc,
                            details="Duplicate bank debit",
                            import_key=import_key,
                        )

            self.db.flush()
        finally:
            wb.close()
            gc.collect()

    def _guess_property_from_text(self, text: str | None) -> Property | None:
        if not text:
            return None
        # Match known addresses against property records
        lowered = text.lower()
        for prop in self.properties_by_id.values():
            if prop.client_prop_id == BUFFER_PROP_ID:
                continue
            if prop.address:
                addr = prop.address.strip()
                if addr and addr.lower() in lowered:
                    return prop
                # Hebrew street-number fragments often appear without city
                # e.g. address "צה\"ל 5" vs text containing צהל 5
                compact_addr = re.sub(r"\s+", "", addr).lower().replace('"', "")
                compact_text = re.sub(r"\s+", "", text).lower().replace('"', "")
                if compact_addr and compact_addr in compact_text:
                    return prop
        return None

    def _import_credit_cards(self) -> None:
        buffer = self.properties_by_id[BUFFER_PROP_ID]

        for filename in CREDIT_CARD_FILES:
            path = self.data_dir / filename
            if not path.exists():
                self.stats.warnings.append(f"Credit card file not found: {filename}")
                continue

            wb = openpyxl.load_workbook(path, data_only=True)
            try:
                ws = wb[wb.sheetnames[0]]

                card_last4 = "unknown"
                for row in ws.iter_rows(values_only=True, max_row=10):
                    for cell in row:
                        if cell is None:
                            continue
                        m = re.search(r"(\d{4})\s*$", str(cell))
                        if m and "מסטרקארד" in str(cell):
                            card_last4 = m.group(1)
                            break

                account_number = f"{COMPANY_CC_ACCOUNT_PREFIX}{card_last4}"
                account = self.db.scalars(
                    select(BankAccount).where(BankAccount.account_number == account_number)
                ).first()
                if not account:
                    account = BankAccount(
                        property_id=None,
                        bank_name="Bank Leumi Mastercard",
                        account_number=account_number,
                        currency=self.settings.default_currency,
                        label=f"Credit card ••{card_last4}",
                    )
                    self.db.add(account)
                    self.db.flush()
                    self.stats.bank_accounts_created += 1

                header_row = None
                headers: list[str] = []
                for i, row in enumerate(ws.iter_rows(values_only=True), 1):
                    vals = [str(v).strip() if v is not None else "" for v in row]
                    if "תאריך העסקה" in vals and "סכום חיוב" in vals:
                        header_row = i
                        headers = vals
                        break
                if header_row is None:
                    self.stats.errors.append(f"No credit-card header in {filename}")
                    continue

                col = {name: idx for idx, name in enumerate(headers) if name}

                def get(row_vals: list[Any], name: str) -> Any:
                    idx = col.get(name)
                    if idx is None or idx >= len(row_vals):
                        return None
                    return row_vals[idx]

                for row_number, row in enumerate(ws.iter_rows(values_only=True), 1):
                    if row_number <= header_row:
                        continue
                    values = list(row)
                    # Skip totals
                    if any(v is not None and "סה" in str(v) for v in values[:5]):
                        continue

                    tx_date = _parse_date(get(values, "תאריך העסקה"))
                    merchant = _optional_str(get(values, "שם בית העסק"))
                    charge = get(values, "סכום חיוב")
                    # Negative charge = fee credit/refund — skip or treat as deposit
                    if charge is None:
                        continue
                    try:
                        charge_dec = Decimal(str(charge))
                    except (InvalidOperation, ValueError):
                        continue

                    if tx_date is None or merchant is None:
                        continue

                    if charge_dec < 0:
                        # Card credit / fee waiver
                        amount = abs(charge_dec).quantize(Decimal("0.01"))
                        import_key = f"cc:{card_last4}:credit:{tx_date}:{amount}:{merchant}"
                        if import_key not in self.existing_deposit_keys:
                            self.db.add(
                                Deposit(
                                    bank_account_id=account.id,
                                    property_id=buffer.id,
                                    transaction_date=tx_date,
                                    amount=amount,
                                    currency=self.settings.default_currency,
                                    reference=None,
                                    description=merchant,
                                    source="credit_card",
                                    import_key=import_key,
                                    source_file=filename,
                                )
                            )
                            self.existing_deposit_keys.add(import_key)
                            self.stats.deposits_created += 1
                        else:
                            self.stats.deposits_skipped += 1
                            self._record_skip(
                                source_file=filename,
                                sheet=ws.title,
                                row_number=row_number,
                                reason="duplicate_deposit",
                                transaction_date=tx_date,
                                amount=amount,
                                notes=merchant,
                                details="Duplicate credit-card credit",
                                import_key=import_key,
                            )
                        continue

                    amount = charge_dec.quantize(Decimal("0.01"))
                    if amount <= 0:
                        continue
                    import_key = f"cc:{card_last4}:expense:{tx_date}:{amount}:{merchant}"
                    if import_key not in self.existing_expense_keys:
                        self.db.add(
                            Expense(
                                property_id=buffer.id,
                                transaction_date=tx_date,
                                amount=amount,
                                currency=self.settings.default_currency,
                                category=merchant[:255],
                                source="credit_card",
                                payment_method="credit_card",
                                vendor_name=merchant,
                                description=merchant,
                                card_last4=None if card_last4 == "unknown" else card_last4,
                                import_key=import_key,
                                source_file=filename,
                            )
                        )
                        self.existing_expense_keys.add(import_key)
                        self.stats.expenses_created += 1
                    else:
                        self.stats.expenses_skipped += 1
                        self._record_skip(
                            source_file=filename,
                            sheet=ws.title,
                            row_number=row_number,
                            reason="duplicate_expense",
                            transaction_date=tx_date,
                            amount=amount,
                            notes=merchant,
                            details="Duplicate credit-card expense",
                            import_key=import_key,
                        )
            finally:
                wb.close()
                gc.collect()

        self.db.flush()


def import_client_data(
    db: Session,
    data_dir: Path | None = None,
    progress: ProgressCallback | None = None,
    *,
    include_bank: bool = True,
    include_credit_cards: bool = True,
    include_management: bool = True,
) -> ImportStats:
    service = ClientDataImportService(db, data_dir=data_dir, progress=progress)
    return service.import_all(
        include_bank=include_bank,
        include_credit_cards=include_credit_cards,
        include_management=include_management,
    )


def build_skip_report_excel(stats: ImportStats) -> bytes:
    """Build a detailed Excel workbook of skipped import rows."""
    from collections import Counter
    from io import BytesIO

    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()

    # Summary sheet
    summary = wb.active
    summary.title = "Summary"
    summary.append(["Metric", "Value"])
    summary["A1"].font = Font(bold=True)
    summary["B1"].font = Font(bold=True)
    summary_rows = [
        ("rows_seen", stats.rows_seen),
        ("skipped_rows_detailed", len(stats.skipped_rows)),
        ("rows_skipped_empty", stats.rows_skipped_empty),
        ("needs_review_created", stats.needs_review_created),
        ("expenses_created", stats.expenses_created),
        ("expenses_skipped_duplicates", stats.expenses_skipped),
        ("deposits_created", stats.deposits_created),
        ("deposits_skipped_duplicates", stats.deposits_skipped),
        ("owners_created", stats.owners_created),
        ("properties_created", stats.properties_created),
        ("properties_active", stats.properties_active),
        ("properties_inactive", stats.properties_inactive),
        ("properties_marked_active", stats.properties_marked_active),
        ("properties_marked_inactive", stats.properties_marked_inactive),
        ("warnings", len(stats.warnings)),
        ("errors", len(stats.errors)),
    ]
    for key, value in summary_rows:
        summary.append([key, value])

    summary.append([])
    summary.append(["Skip reason", "Count"])
    summary[f"A{summary.max_row}"].font = Font(bold=True)
    summary[f"B{summary.max_row}"].font = Font(bold=True)
    reason_counts = Counter(row.reason for row in stats.skipped_rows)
    for reason, count in sorted(reason_counts.items(), key=lambda item: (-item[1], item[0])):
        summary.append([reason, count])

    summary.append([])
    summary.append(["Sheet", "Skipped count"])
    summary[f"A{summary.max_row}"].font = Font(bold=True)
    summary[f"B{summary.max_row}"].font = Font(bold=True)
    sheet_counts = Counter(row.sheet for row in stats.skipped_rows)
    for sheet_name, count in sorted(sheet_counts.items(), key=lambda item: (-item[1], item[0])):
        summary.append([sheet_name, count])

    # Detail sheet
    detail = wb.create_sheet("Skipped rows")
    headers = [
        "source_file",
        "sheet",
        "row_number",
        "reason",
        "prop_id",
        "transaction_date",
        "amount",
        "inflow",
        "section",
        "notes",
        "details",
        "import_key",
    ]
    detail.append(headers)
    for cell in detail[1]:
        cell.font = Font(bold=True)

    for row in stats.skipped_rows:
        data = row.to_dict()
        detail.append([data.get(h) for h in headers])

    # Property active/inactive status (from current client list sync)
    status_sheet = wb.create_sheet("Property status")
    status_sheet.append(["Prop ID", "Status"])
    status_sheet["A1"].font = Font(bold=True)
    status_sheet["B1"].font = Font(bold=True)
    status_sheet.append(["properties_active", stats.properties_active])
    status_sheet.append(["properties_inactive", stats.properties_inactive])
    status_sheet.append(["properties_marked_active_this_import", stats.properties_marked_active])
    status_sheet.append(
        ["properties_marked_inactive_this_import", stats.properties_marked_inactive]
    )
    status_sheet.append([])
    status_sheet.append(["Prop ID", "Status"])
    status_sheet[f"A{status_sheet.max_row}"].font = Font(bold=True)
    status_sheet[f"B{status_sheet.max_row}"].font = Font(bold=True)
    for prop_id in stats.properties_active_ids:
        status_sheet.append([prop_id, "active"])
    for prop_id in stats.properties_inactive_ids:
        status_sheet.append([prop_id, "inactive"])

    # Reason legend
    legend = wb.create_sheet("Reason legend")
    legend.append(["reason", "meaning"])
    legend["A1"].font = Font(bold=True)
    legend["B1"].font = Font(bold=True)
    for reason, meaning in [
        ("unresolved_property", "Prop ID on the row could not be matched to a property"),
        ("missing_date", "Row has no usable transaction date"),
        ("starting_balance", "Starting-balance / opening row (intentionally skipped)"),
        ("no_money_columns", "Date present but no Amount/Inflow/paid amounts"),
        ("empty_prop_id", "Client-list row without a property number"),
        ("duplicate_expense", "Expense already exists (same import_key)"),
        ("duplicate_deposit", "Deposit already exists (same import_key)"),
    ]:
        legend.append([reason, meaning])

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
