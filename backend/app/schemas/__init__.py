from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class OwnerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    contact_email: str | None = None
    contact_phone: str | None = None


class BankAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    bank_name: str
    account_number: str
    currency: str


class DepositRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    property_id: UUID
    property_name: str
    owner_name: str
    bank_account_id: UUID
    account_number: str
    transaction_date: date
    amount: Decimal
    currency: str
    reference: str | None = None
    description: str | None = None
    source: str


class PropertyRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    address: str | None = None
    status: str
    owner_id: UUID
    owner_name: str
    deposit_count: int = 0
    total_deposits: Decimal = Decimal("0")


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


class ImportResultRead(BaseModel):
    filename: str
    row_count: int
    imported_count: int
    skipped_count: int
    error_count: int
    errors: list[dict]
    import_batch_id: str | None = None


class HealthResponse(BaseModel):
    status: str
    timestamp: datetime


class PeriodRange(BaseModel):
    date_from: date | None = None
    date_to: date | None = None


class DepositQueryIntent(BaseModel):
    query_type: str
    property_id: UUID | None = None
    property_name: str | None = None
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


class AIQueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class AIQueryResponse(BaseModel):
    answer: str
    data: list[dict]
    query_used: DepositQueryIntent
    parser: str = "rules"

