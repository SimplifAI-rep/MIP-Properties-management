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
  /** Company-float balance (Inflow − Expenses), summed across properties. */
  balance: string;
  /** Inactive only when every linked property is inactive. */
  status?: 'active' | 'inactive';
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
  balance: string;
}

export interface OwnerDetail extends OwnerSummary {
  properties: OwnerPropertySummary[];
  recent_deposits: Deposit[];
  recent_expenses: Expense[];
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
  transaction_date: string | null;
  amount: string;
  currency: string;
  reference: string | null;
  description: string | null;
  source: string;
  is_rental_income?: boolean;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  needs_review?: boolean;
  review_reasons?: string | null;
  transaction_ref?: string | null;
  bank_verified_at?: string | null;
  bank_asmachta?: string | null;
  bank_reconcile_exclude?: boolean;
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
  total_incoming?: string;
  total_outgoing?: string;
  net_balance?: string;
}

export interface PropertyDetail extends Property {
  owner: Owner;
  bank_accounts: BankAccount[];
  recent_deposits: Deposit[];
  recent_expenses?: Expense[];
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

export interface PeriodPropertyFloat {
  property_id: string;
  deposit_total: string;
  expense_total: string;
  deposit_count: number;
  expense_count: number;
}

export interface PeriodFloatResponse {
  properties: PeriodPropertyFloat[];
}

export interface DepositQueryIntent {
  query_type: string;
  domain?: string;
  property_id?: string | null;
  property_ids?: string[];
  property_name?: string | null;
  client_prop_id?: string | null;
  client_prop_ids?: string[];
  owner_id?: string | null;
  owner_ids?: string[];
  owner_name?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  group_by?: string | null;
  year?: number | null;
  month?: number | null;
  min_amount?: string | null;
  max_amount?: string | null;
  category?: string | null;
  source?: string | null;
  payment_method?: string | null;
  search_text?: string | null;
  source_file?: string | null;
  needs_review?: boolean | null;
  is_rental_income?: boolean | null;
  paid_by_resident?: boolean | null;
  paid_by_owner?: boolean | null;
  paid_by_company?: boolean | null;
  ledger_column?: string | null;
}

export interface AIQueryFilters {
  owner_ids?: string[];
  property_ids?: string[];
  client_prop_ids?: string[];
  date_from?: string | null;
  date_to?: string | null;
  min_amount?: string | null;
  max_amount?: string | null;
}

export interface AIQueryRequest {
  question?: string;
  filters?: AIQueryFilters | null;
}

export interface AIQueryResponse {
  answer: string;
  data: Record<string, unknown>[];
  query_used: DepositQueryIntent;
  parser: string;
}

export interface DepositFilters {
  property_id?: string;
  property_ids?: string[];
  client_prop_id?: string;
  client_prop_ids?: string[];
  owner_id?: string;
  owner_ids?: string[];
  property_status?: 'active' | 'inactive';
  date_from?: string;
  date_to?: string;
  min_amount?: string;
  max_amount?: string;
  source_file?: string;
  needs_review?: boolean;
  is_rental_income?: boolean;
  include_running_balance?: boolean;
  page?: number;
  page_size?: number;
}

export interface Expense {
  id: string;
  property_id: string;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  transaction_date: string | null;
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
  needs_review?: boolean;
  review_reasons?: string | null;
  transaction_ref?: string | null;
  bank_verified_at?: string | null;
  bank_asmachta?: string | null;
  bank_reconcile_exclude?: boolean;
  cc_verified_at?: string | null;
  cc_bank_confirmed_at?: string | null;
  cc_settlement_group_id?: string | null;
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
  property_ids?: string[];
  client_prop_id?: string;
  client_prop_ids?: string[];
  owner_id?: string;
  owner_ids?: string[];
  property_status?: 'active' | 'inactive';
  category?: string;
  source?: string;
  payment_method?: string;
  date_from?: string;
  date_to?: string;
  min_amount?: string;
  max_amount?: string;
  source_file?: string;
  needs_review?: boolean;
  paid_by_resident?: boolean;
  paid_by_owner?: boolean;
  paid_by_company?: boolean;
  include_running_balance?: boolean;
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

export interface ExpenseUpdate {
  property_id?: string;
  transaction_date?: string | null;
  amount?: string;
  currency?: string;
  category?: string;
  source?: string;
  payment_method?: string;
  vendor_name?: string | null;
  reference?: string | null;
  description?: string | null;
  notes?: string | null;
}

export interface DepositUpdate {
  property_id?: string;
  bank_account_id?: string | null;
  transaction_date?: string | null;
  amount?: string;
  currency?: string;
  reference?: string | null;
  description?: string | null;
  is_rental_income?: boolean;
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
  user_action?: 'add' | 'ignore';
  is_duplicate?: boolean;
  duplicate_match_id?: string | null;
  duplicate_match_kind?: 'deposit' | 'expense' | null;
  duplicate_summary?: string | null;
  needs_review?: boolean;
  review_reasons?: string | null;
  import_key?: string | null;
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
  properties_active?: number;
  properties_inactive?: number;
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
  needs_review_created?: number;
  properties_marked_active?: number;
  properties_marked_inactive?: number;
  properties_active?: number;
  properties_inactive?: number;
  properties_active_ids?: string[];
  properties_inactive_ids?: string[];
  skipped_row_count: number;
  skip_reason_counts?: Record<string, number>;
  incomplete_reason_counts?: Record<string, number>;
  skip_report_id?: string | null;
  skip_report_url?: string | null;
  warnings: string[];
  errors: string[];
  database_counts: ClientDataImportCounts;
}

export interface ClientDataImportJobAccepted {
  job_id: string;
  status: string;
  message: string;
}

export interface ClientDataImportJobStatus {
  job_id: string;
  status: string;
  message: string;
  error?: string | null;
  reset: boolean;
  files_used: string[];
  result?: ClientDataImportResponse | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface DepositCreate {
  property_id: string;
  bank_account_id?: string;
  transaction_date: string;
  amount: string;
  currency?: string;
  reference?: string;
  description?: string;
  source?: string;
  is_rental_income?: boolean;
  /** UI-only helpers mapped into description/reference on save */
  category?: string;
  payment_method?: string;
  vendor_name?: string;
}

export interface AlertItem {
  id: string;
  alert_type:
    | 'missing_deposit'
    | 'upload_pending'
    | 'duplicate_deposit'
    | 'incomplete_import'
    | 'low_balance'
    | 'bank_unmatched'
    | 'app_unmatched'
    | 'bank_gap'
    | 'cc_unmatched'
    | 'cc_app_unmatched';
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  property_id?: string | null;
  property_name?: string | null;
  owner_name?: string | null;
  upload_id?: string | null;
  transaction_type?: 'deposit' | 'expense' | null;
  expense_id?: string | null;
  deposit_id?: string | null;
  transaction_date?: string | null;
  amount?: string | null;
  threshold_amount?: string | null;
  section?: string | null;
  notes?: string | null;
  review_reasons?: string | null;
  created_at?: string | null;
  gap?: DepositGap | null;
  drafts: TransactionDraft[];
  reconcile_session_id?: string | null;
  link_path?: string | null;
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

export interface AlertRule {
  id: string;
  rule_type: 'low_balance';
  name: string;
  enabled: boolean;
  severity: 'error' | 'warning' | 'info';
  scope_type: 'global' | 'property';
  property_id?: string | null;
  property_name?: string | null;
  client_prop_id?: string | null;
  threshold_amount: string;
  currency: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AlertRuleCreate {
  rule_type?: 'low_balance';
  name: string;
  enabled?: boolean;
  severity?: 'error' | 'warning' | 'info';
  scope_type: 'global' | 'property';
  property_id?: string | null;
  threshold_amount: string;
  currency?: string;
}

export interface AlertRuleUpdate {
  name?: string;
  enabled?: boolean;
  severity?: 'error' | 'warning' | 'info';
  threshold_amount?: string;
  currency?: string;
}

export interface FixIncompletePayload {
  transaction_type: 'deposit' | 'expense';
  id: string;
  transaction_date?: string | null;
  amount?: string | null;
}

export interface AlertResolveRequest {
  action: 'add_deposit' | 'confirm_upload' | 'fix_incomplete';
  deposit?: DepositCreate;
  drafts?: TransactionDraft[];
  fix_incomplete?: FixIncompletePayload;
}

export interface FixIncompleteResponse {
  transaction_type: 'deposit' | 'expense';
  id: string;
  needs_review: boolean;
  transaction_date: string | null;
  amount: string;
}

export type { TransactionKind, UnifiedTransaction } from './transaction';


export interface CompanyBankSettings {
  bank_account_id?: string | null;
  bank_account_label?: string | null;
  account_number?: string | null;
  opening_balance: string | null;
  opening_balance_as_of: string | null;
  last_verification_date: string | null;
  gap_tolerance_amount: string;
  unverified_count: number;
}

export interface CompanyBankSettingsUpdate {
  bank_account_id?: string | null;
  opening_balance?: string | null;
  opening_balance_as_of?: string | null;
  last_verification_date?: string | null;
  gap_tolerance_amount?: string | null;
  clear_opening_balance?: boolean;
  clear_opening_balance_as_of?: boolean;
  clear_last_verification_date?: boolean;
}

export interface BankCutoverRequest {
  opening_balance: string;
  as_of_date: string;
  gap_tolerance_amount?: string | null;
  bank_account_id?: string | null;
}

export interface BankCutoverResponse {
  settings: CompanyBankSettings;
  deposits_marked: number;
  expenses_marked: number;
}

export interface BankBalanceParseResponse {
  bank_balance: string;
  statement_start_date: string | null;
  statement_end_date: string | null;
  movement_row_count: number;
}

export interface BankGapResponse {
  opening_balance: string | null;
  opening_balance_as_of: string | null;
  last_verification_date: string | null;
  gap_tolerance_amount: string;
  after_date: string | null;
  date_to: string | null;
  bank_balance: string | null;
  all_scoped_net: string;
  verified_net: string;
  all_scoped_deposits: string;
  all_scoped_expenses: string;
  gap_all_scoped: string | null;
  gap_verified: string | null;
  within_tolerance_verified: boolean | null;
}

export interface BankReconcileAction {
  action:
    | 'confirm_match'
    | 'confirm_settlement'
    | 'ignore_bank'
    | 'ignore_app'
    | 'add_from_bank';
  fingerprint?: string;
  kind?: 'deposit' | 'expense';
  tx_id?: string;
  reason?: string;
  property_id?: string;
  member_ids?: string[];
}

export interface BankReconcileLine {
  fingerprint: string;
  row_number: number;
  transaction_date: string | null;
  side: 'debit' | 'credit';
  amount: string;
  asmachta: string | null;
  description: string | null;
  status: string;
  proposed_kind?: string | null;
  proposed_tx_id?: string | null;
  proposed_tx_ref?: string | null;
  proposed_summary?: string | null;
  proposed_member_ids?: string[] | null;
  proposed_group_total?: string | null;
  proposed_window_start?: string | null;
  proposed_window_end?: string | null;
  settlement_group_id?: string | null;
  match_confidence?: string | null;
  ignore_reason?: string | null;
}

export interface BankReconcileAppRow {
  kind: 'deposit' | 'expense';
  id: string;
  transaction_ref?: string | null;
  transaction_date: string | null;
  amount: string;
  description?: string | null;
  status: string;
  ignore_reason?: string | null;
}

export interface BankReconcileSession {
  id: string;
  status: string;
  filename: string | null;
  bank_account_id?: string | null;
  bank_balance: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  opening_balance: string | null;
  after_date: string | null;
  gap_tolerance_amount: string;
  verified_net: string;
  all_scoped_net: string;
  gap_verified: string | null;
  within_tolerance_verified: boolean | null;
  counts: Record<string, number>;
  can_complete: boolean;
  has_cc_deduction?: boolean;
  cc_deduction_count?: number;
  lines: BankReconcileLine[];
  unmatched_app: BankReconcileAppRow[];
  able_txs?: Record<string, unknown>[];
  not_in_excel_txs?: Record<string, unknown>[];
}

export interface CcReconcileAction {
  action: 'confirm_match' | 'ignore_cc' | 'ignore_app' | 'add_from_cc';
  fingerprint?: string;
  tx_id?: string;
  reason?: string;
  property_id?: string;
}

export interface CcReconcileLine {
  fingerprint: string;
  row_number?: number;
  transaction_date: string | null;
  amount: string;
  merchant?: string | null;
  details?: string | null;
  status: string;
  proposed_tx_id?: string | null;
  proposed_tx_ref?: string | null;
  proposed_summary?: string | null;
  match_confidence?: string | null;
  ignore_reason?: string | null;
}

export interface CcReconcileSession {
  id: string;
  status: string;
  filename: string | null;
  card_last4: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  counts: Record<string, number>;
  can_complete: boolean;
  lines: CcReconcileLine[];
  unmatched_app: BankReconcileAppRow[];
  able_txs?: Record<string, unknown>[];
  not_in_excel_txs?: Record<string, unknown>[];
}

export interface VerificationBankGroup {
  id: string;
  kind: 'bank';
  status: 'verified' | 'unverified';
  title: string;
  date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  after_date: string | null;
  session_id: string | null;
  filename: string | null;
  bank_account_id?: string | null;
  transaction_count: number;
  settlement_count: number;
  has_cc_deduction?: boolean;
  cc_deduction_count?: number;
}

export interface VerificationCcHistoryGroup {
  id: string;
  kind: 'cc';
  status: 'verified';
  title: string;
  date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  session_id: string | null;
  filename: string | null;
  card_last4: string | null;
  transaction_count: number;
}

export interface VerificationOperatingAccount {
  id: string;
  label: string;
  account_number: string;
  opening_balance: string | null;
  last_verification_date: string | null;
  unverified_count: number;
  open_session_id: string | null;
}

export interface VerificationCreditCard {
  card_last4: string;
  label: string;
  bank_account_id: string | null;
  open_session_id: string | null;
  pending_count: number;
  last_verification_date: string | null;
}

export interface VerificationWorkspace {
  last_verification_date: string | null;
  last_cc_verification_date?: string | null;
  bank_groups: VerificationBankGroup[];
  cc_history?: VerificationCcHistoryGroup[];
  cc_active_session_id?: string | null;
  cc_active_session_ids?: string[];
  operating_accounts?: VerificationOperatingAccount[];
  credit_cards?: VerificationCreditCard[];
  cc_pool: {
    pending_count: number;
    cc_verified_count: number;
  };
}

export interface VerificationTransactionsResponse {
  items: Record<string, unknown>[];
  total: number;
}
