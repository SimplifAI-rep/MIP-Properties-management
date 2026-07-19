export interface Owner {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface OwnerSummary extends Owner {
  property_count: number;
  deposit_count: number;
  total_deposits: string;
  expense_count: number;
  total_expenses: string;
}

export interface OwnerPropertySummary {
  id: string;
  client_prop_id: string;
  name: string;
  address: string | null;
  city: string | null;
  status: string;
  deposit_count: number;
  total_deposits: string;
  expense_count: number;
  total_expenses: string;
}

export interface OwnerDetail extends OwnerSummary {
  properties: OwnerPropertySummary[];
}

export interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  currency: string;
  label?: string | null;
  property_id?: string | null;
}

export interface Deposit {
  id: string;
  property_id: string;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  bank_account_id: string | null;
  account_number: string | null;
  transaction_date: string;
  amount: string;
  currency: string;
  reference: string | null;
  description: string | null;
  source: string;
  is_rental_income?: boolean;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
}

export interface Property {
  id: string;
  client_prop_id: string;
  name: string;
  address: string | null;
  city: string | null;
  status: string;
  owner_id: string;
  owner_name: string;
  deposit_count: number;
  total_deposits: string;
}

export interface PropertyDetail extends Property {
  owner: Owner;
  bank_accounts: BankAccount[];
  recent_deposits: Deposit[];
}

export interface DepositListResponse {
  items: Deposit[];
  total: number;
  page: number;
  page_size: number;
}

export interface DepositSummary {
  total_amount: string;
  deposit_count: number;
  property_count: number;
  missing_deposit_count: number;
}

export interface DepositGap {
  property_id: string;
  property_name: string;
  owner_name: string;
  expected_amount: string;
  due_day: number;
  period_start: string;
  period_end: string;
  status: string;
}

export interface DepositQueryIntent {
  query_type: string;
  domain?: string;
  property_id: string | null;
  property_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  date_from: string | null;
  date_to: string | null;
  group_by: string | null;
  year: number | null;
  month: number | null;
  category?: string | null;
  source?: string | null;
}

export interface AIQueryResponse {
  answer: string;
  data: Record<string, unknown>[];
  query_used: DepositQueryIntent;
  parser: string;
}

export interface DepositFilters {
  property_id?: string;
  client_prop_id?: string;
  owner_id?: string;
  date_from?: string;
  date_to?: string;
  min_amount?: string;
  max_amount?: string;
  page?: number;
  page_size?: number;
}

export interface Expense {
  id: string;
  property_id: string;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  transaction_date: string;
  amount: string;
  currency: string;
  category: string;
  source: string;
  payment_method: string;
  vendor_name: string | null;
  reference: string | null;
  description: string | null;
  notes?: string | null;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  reconciled?: boolean;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
}

export interface ExpenseListResponse {
  items: Expense[];
  total: number;
  page: number;
  page_size: number;
}

export interface ExpenseCategoryTotal {
  category: string;
  total_amount: string;
  expense_count: number;
}

export interface ExpenseSummary {
  total_amount: string;
  expense_count: number;
  property_count: number;
  by_category: ExpenseCategoryTotal[];
}

export interface ExpenseFilters {
  property_id?: string;
  client_prop_id?: string;
  owner_id?: string;
  category?: string;
  source?: string;
  payment_method?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
}

export interface ExpenseCreate {
  property_id: string;
  transaction_date: string;
  amount: string;
  currency?: string;
  category: string;
  source: string;
  payment_method: string;
  vendor_name?: string;
  reference?: string;
  description?: string;
}

export interface FieldWarning {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface TransactionDraft {
  row_number?: number | null;
  transaction_type: 'deposit' | 'expense';
  property_id?: string | null;
  client_prop_id?: string | null;
  property_name?: string | null;
  owner_id?: string | null;
  owner_name?: string | null;
  bank_account_id?: string | null;
  account_number?: string | null;
  transaction_date?: string | null;
  amount?: string | null;
  currency?: string;
  category?: string | null;
  source?: string | null;
  payment_method?: string | null;
  vendor_name?: string | null;
  reference?: string | null;
  description?: string | null;
  match_confidence?: 'high' | 'medium' | 'low' | 'none' | null;
  status: 'ready' | 'needs_review' | 'error';
  warnings: FieldWarning[];
}

export interface UploadAnalyzeResponse {
  upload_id: string;
  filename: string;
  mime_type?: string | null;
  property_id?: string | null;
  owner_id?: string | null;
  client_prop_id?: string | null;
  property_name?: string | null;
  owner_name?: string | null;
  transaction_type: 'deposit' | 'expense';
  parser: string;
  message?: string | null;
  match_confidence?: 'high' | 'medium' | 'low' | 'none' | null;
  drafts: TransactionDraft[];
  ready_count: number;
  needs_review_count: number;
  error_count: number;
  preview_url?: string | null;
}

export interface UploadConfirmResponse {
  upload_id: string;
  imported_deposit_count: number;
  imported_expense_count: number;
  skipped_count: number;
  errors: string[];
}

export interface ClientDataImportCounts {
  owners: number;
  properties: number;
  bank_accounts: number;
  expenses: number;
  deposits: number;
}

export interface ClientDataStatusResponse {
  database_counts: ClientDataImportCounts;
  expected_files: string[];
}

export interface ClientDataImportResponse {
  reset: boolean;
  files_used: string[];
  owners_created: number;
  properties_created: number;
  bank_accounts_created: number;
  expenses_created: number;
  expenses_skipped: number;
  deposits_created: number;
  deposits_skipped: number;
  rows_seen: number;
  rows_skipped_empty: number;
  skipped_row_count: number;
  skip_report_id?: string | null;
  skip_report_url?: string | null;
  warnings: string[];
  errors: string[];
  database_counts: ClientDataImportCounts;
}

export interface DepositCreate {
  property_id: string;
  bank_account_id: string;
  transaction_date: string;
  amount: string;
  currency?: string;
  reference?: string;
  description?: string;
}

export interface AlertItem {
  id: string;
  alert_type: 'missing_deposit' | 'upload_pending' | 'duplicate_deposit';
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  property_id?: string | null;
  property_name?: string | null;
  owner_name?: string | null;
  upload_id?: string | null;
  transaction_type?: 'deposit' | 'expense' | null;
  created_at?: string | null;
  gap?: DepositGap | null;
  drafts: TransactionDraft[];
}

export interface AlertListResponse {
  items: AlertItem[];
  total: number;
  error_count: number;
  warning_count: number;
}

export interface AlertSummary {
  open_count: number;
  error_count: number;
  warning_count: number;
}

export interface AlertResolveRequest {
  action: 'add_deposit' | 'confirm_upload';
  deposit?: DepositCreate;
  drafts?: TransactionDraft[];
}
