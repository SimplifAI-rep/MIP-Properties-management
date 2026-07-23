from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class OwnerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    contact_email: str | None = None
    contact_phone: str | None = None


class OwnerSummary(OwnerRead):
    property_count: int = 0
    deposit_count: int = 0
    total_deposits: Decimal = Decimal("0")
    expense_count: int = 0
    total_expenses: Decimal = Decimal("0")


class OwnerPropertySummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    client_prop_id: str
    name: str
    address: str | None = None
    city: str | None = None
    status: str
    deposit_count: int = 0
    total_deposits: Decimal = Decimal("0")
    expense_count: int = 0
    total_expenses: Decimal = Decimal("0")


class OwnerDetail(OwnerSummary):
    properties: list[OwnerPropertySummary] = Field(default_factory=list)


class BankAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    bank_name: str
    account_number: str
    currency: str
    label: str | None = None
    property_id: UUID | None = None


class DepositRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    property_id: UUID
    client_prop_id: str
    property_name: str
    owner_name: str
    bank_account_id: UUID | None = None
    account_number: str | None = None
    transaction_date: date | None = None
    amount: Decimal
    currency: str
    reference: str | None = None
    description: str | None = None
    source: str
    is_rental_income: bool = False
    receipt_ref: str | None = None
    source_file: str | None = None
    balance_after: Decimal | None = None
    needs_review: bool = False
    review_reasons: str | None = None


class PropertyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    client_prop_id: str
    name: str
    address: str | None = None
    city: str | None = None
    status: str
    owner_id: UUID
    owner_name: str
    deposit_count: int = 0
    total_deposits: Decimal = Decimal("0")
    # Company-float totals (same rules as Transactions Net)
    total_incoming: Decimal = Decimal("0")
    total_outgoing: Decimal = Decimal("0")
    net_balance: Decimal = Decimal("0")


class PropertyDetail(PropertyRead):
    owner: OwnerRead
    bank_accounts: list[BankAccountRead] = Field(default_factory=list)
    recent_deposits: list[DepositRead] = Field(default_factory=list)


class DepositListResponse(BaseModel):
    items: list[DepositRead]
    total: int
    page: int
    page_size: int


class DepositSummary(BaseModel):
    total_amount: Decimal
    deposit_count: int
    property_count: int
    missing_deposit_count: int


class DepositGap(BaseModel):
    property_id: UUID
    property_name: str
    owner_name: str
    expected_amount: Decimal
    due_day: int
    period_start: date
    period_end: date
    status: str


class DepositCreate(BaseModel):
    property_id: UUID
    bank_account_id: UUID | None = None
    transaction_date: date
    amount: Decimal = Field(gt=0)
    currency: str = "ILS"
    reference: str | None = None
    description: str | None = None


class DepositUpdate(BaseModel):
    property_id: UUID | None = None
    bank_account_id: UUID | None = None
    transaction_date: date | None = None
    amount: Decimal | None = Field(default=None, ge=0)
    currency: str | None = None
    reference: str | None = None
    description: str | None = None
    is_rental_income: bool | None = None


class ImportResultRead(BaseModel):
    filename: str
    row_count: int
    imported_count: int
    skipped_count: int
    error_count: int
    errors: list[dict]
    import_batch_id: str | None = None


class ClientDataImportCounts(BaseModel):
    owners: int = 0
    properties: int = 0
    bank_accounts: int = 0
    expenses: int = 0
    deposits: int = 0


class ClientDataImportResponse(BaseModel):
    reset: bool = False
    files_used: list[str] = Field(default_factory=list)
    owners_created: int = 0
    properties_created: int = 0
    bank_accounts_created: int = 0
    expenses_created: int = 0
    expenses_skipped: int = 0
    deposits_created: int = 0
    deposits_skipped: int = 0
    rows_seen: int = 0
    rows_skipped_empty: int = 0
    skipped_row_count: int = 0
    skip_report_id: str | None = None
    skip_report_url: str | None = None
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    database_counts: ClientDataImportCounts = Field(default_factory=ClientDataImportCounts)


class ClientDataStatusResponse(BaseModel):
    database_counts: ClientDataImportCounts
    expected_files: list[str] = Field(default_factory=list)


class ClientDataImportJobAccepted(BaseModel):
    job_id: str
    status: str
    message: str = "Import queued"


class ClientDataImportJobStatus(BaseModel):
    job_id: str
    status: str
    message: str = ""
    error: str | None = None
    reset: bool = False
    files_used: list[str] = Field(default_factory=list)
    result: ClientDataImportResponse | None = None
    created_at: str | None = None
    updated_at: str | None = None


class HealthResponse(BaseModel):
    status: str
    timestamp: datetime


class PeriodRange(BaseModel):
    date_from: date | None = None
    date_to: date | None = None


class DepositQueryIntent(BaseModel):
    query_type: str
    domain: str = "deposits"
    property_id: UUID | None = None
    property_name: str | None = None
    client_prop_id: str | None = None
    owner_id: UUID | None = None
    owner_name: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    period_a: PeriodRange | None = None
    period_b: PeriodRange | None = None
    group_by: str | None = None
    year: int | None = None
    month: int | None = None
    min_amount: Decimal | None = None
    max_amount: Decimal | None = None
    category: str | None = None
    source: str | None = None
    payment_method: str | None = None
    search_text: str | None = None
    source_file: str | None = None
    needs_review: bool | None = None
    is_rental_income: bool | None = None
    paid_by_resident: bool | None = None
    paid_by_owner: bool | None = None
    paid_by_company: bool | None = None
    ledger_column: str | None = None


class AIQueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class AIQueryResponse(BaseModel):
    answer: str
    data: list[dict]
    query_used: DepositQueryIntent
    parser: str = "rules"


class ExpenseRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    property_id: UUID
    client_prop_id: str
    property_name: str
    owner_name: str
    transaction_date: date | None = None
    amount: Decimal
    currency: str
    category: str
    source: str
    payment_method: str
    vendor_name: str | None = None
    reference: str | None = None
    description: str | None = None
    notes: str | None = None
    receipt_ref: str | None = None
    source_file: str | None = None
    balance_after: Decimal | None = None
    reconciled: bool = False
    paid_by_resident: bool = False
    paid_by_company: bool = False
    paid_by_owner: bool = False
    ledger_column: str | None = None
    needs_review: bool = False
    review_reasons: str | None = None


class ExpenseCreate(BaseModel):
    property_id: UUID
    transaction_date: date
    amount: Decimal = Field(gt=0)
    currency: str = "ILS"
    category: str
    source: str
    payment_method: str
    vendor_name: str | None = None
    reference: str | None = None
    description: str | None = None


class ExpenseUpdate(BaseModel):
    property_id: UUID | None = None
    transaction_date: date | None = None
    amount: Decimal | None = Field(default=None, ge=0)
    currency: str | None = None
    category: str | None = None
    source: str | None = None
    payment_method: str | None = None
    vendor_name: str | None = None
    reference: str | None = None
    description: str | None = None
    notes: str | None = None


class ExpenseListResponse(BaseModel):
    items: list[ExpenseRead]
    total: int
    page: int
    page_size: int


class ExpenseCategoryTotal(BaseModel):
    category: str
    total_amount: Decimal
    expense_count: int


class ExpenseSummary(BaseModel):
    total_amount: Decimal
    expense_count: int
    property_count: int
    by_category: list[ExpenseCategoryTotal] = Field(default_factory=list)


class FieldWarning(BaseModel):
    field: str
    message: str
    severity: Literal["error", "warning"] = "warning"


class TransactionDraft(BaseModel):
    row_number: int | None = None
    transaction_type: Literal["deposit", "expense"]
    property_id: UUID | None = None
    client_prop_id: str | None = None
    property_name: str | None = None
    owner_id: UUID | None = None
    owner_name: str | None = None
    bank_account_id: UUID | None = None
    account_number: str | None = None
    transaction_date: date | None = None
    amount: Decimal | None = None
    currency: str = "ILS"
    category: str | None = None
    source: str | None = None
    payment_method: str | None = None
    vendor_name: str | None = None
    reference: str | None = None
    description: str | None = None
    match_confidence: Literal["high", "medium", "low", "none"] | None = None
    status: Literal["ready", "needs_review", "error"] = "needs_review"
    warnings: list[FieldWarning] = Field(default_factory=list)
    # Statement uploads: add creates a row; ignore skips. Duplicates default to ignore.
    user_action: Literal["add", "ignore"] = "add"
    is_duplicate: bool = False
    duplicate_match_id: UUID | None = None
    duplicate_match_kind: Literal["deposit", "expense"] | None = None
    duplicate_summary: str | None = None
    needs_review: bool = False
    review_reasons: str | None = None
    import_key: str | None = None


class UploadAnalyzeResponse(BaseModel):
    upload_id: UUID
    filename: str
    mime_type: str | None = None
    property_id: UUID | None = None
    owner_id: UUID | None = None
    client_prop_id: str | None = None
    property_name: str | None = None
    owner_name: str | None = None
    transaction_type: Literal["deposit", "expense"]
    parser: str
    message: str | None = None
    match_confidence: Literal["high", "medium", "low", "none"] | None = None
    drafts: list[TransactionDraft]
    ready_count: int = 0
    needs_review_count: int = 0
    error_count: int = 0


class UploadConfirmRequest(BaseModel):
    drafts: list[TransactionDraft]


class UploadConfirmResponse(BaseModel):
    upload_id: UUID
    imported_deposit_count: int
    imported_expense_count: int
    skipped_count: int
    errors: list[str] = Field(default_factory=list)


class AlertRead(BaseModel):
    id: str
    alert_type: Literal[
        "missing_deposit",
        "upload_pending",
        "duplicate_deposit",
        "incomplete_import",
    ]
    severity: Literal["error", "warning", "info"]
    title: str
    message: str
    property_id: UUID | None = None
    property_name: str | None = None
    owner_name: str | None = None
    upload_id: UUID | None = None
    transaction_type: Literal["deposit", "expense"] | None = None
    expense_id: UUID | None = None
    deposit_id: UUID | None = None
    transaction_date: date | None = None
    amount: Decimal | None = None
    section: str | None = None
    notes: str | None = None
    review_reasons: str | None = None
    created_at: datetime | None = None
    gap: DepositGap | None = None
    drafts: list[TransactionDraft] = Field(default_factory=list)


class AlertListResponse(BaseModel):
    items: list[AlertRead]
    total: int
    error_count: int = 0
    warning_count: int = 0


class AlertSummary(BaseModel):
    open_count: int
    error_count: int = 0
    warning_count: int = 0


class FixIncompletePayload(BaseModel):
    transaction_type: Literal["deposit", "expense"]
    id: UUID
    transaction_date: date | None = None
    amount: Decimal | None = Field(default=None, ge=0)


class AlertResolveRequest(BaseModel):
    action: Literal["add_deposit", "confirm_upload", "fix_incomplete"]
    deposit: DepositCreate | None = None
    drafts: list[TransactionDraft] | None = None
    fix_incomplete: FixIncompletePayload | None = None

