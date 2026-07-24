import type { Deposit, Expense } from '../types';

export type TransactionKind = 'deposit' | 'expense';

export interface UnifiedTransaction {
  id: string;
  kind: TransactionKind;
  property_id: string;
  transaction_date: string | null;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  amount: string;
  currency: string;
  /** Excel "Section" (expense category / deposit account cue). */
  section: string;
  /** Excel "Notes". */
  notes: string | null;
  /** Excel "Company" when present. */
  company: string | null;
  payment_method?: string | null;
  source?: string | null;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
  is_rental_income?: boolean;
  from_bank_statement?: boolean;
  needs_review?: boolean;
  review_reasons?: string | null;
}

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUploadReceiptRef(ref: string | null | undefined): ref is string {
  return Boolean(ref && UPLOAD_ID_RE.test(ref));
}

function label(value: string) {
  return value.replace(/_/g, ' ');
}

export function expenseNotes(expense: Expense): string | null {
  const desc = expense.description?.trim() || null;
  const section = expense.category?.trim() || '';
  if (!desc) return null;
  // Import stores description as "Section | Notes" — show Notes only when possible.
  if (section && desc.toLowerCase().startsWith(section.toLowerCase())) {
    const rest = desc.slice(section.length).replace(/^\s*\|\s*/, '').trim();
    return rest || null;
  }
  return desc;
}

export function depositToUnified(deposit: Deposit): UnifiedTransaction {
  return {
    id: deposit.id,
    kind: 'deposit',
    property_id: deposit.property_id,
    transaction_date: deposit.transaction_date,
    client_prop_id: deposit.client_prop_id,
    property_name: deposit.property_name,
    owner_name: deposit.owner_name,
    amount: deposit.amount,
    currency: deposit.currency,
    section: deposit.is_rental_income
      ? 'Rental income'
      : label(deposit.source || 'Inflow'),
    notes: deposit.description,
    company: null,
    source: deposit.source,
    receipt_ref: deposit.receipt_ref ?? null,
    source_file: deposit.source_file ?? null,
    balance_after: deposit.balance_after ?? null,
    is_rental_income: Boolean(deposit.is_rental_income),
    from_bank_statement: deposit.source === 'bank_statement',
    needs_review: Boolean(deposit.needs_review),
    review_reasons: deposit.review_reasons ?? null,
  };
}

export function expenseToUnified(expense: Expense): UnifiedTransaction {
  return {
    id: expense.id,
    kind: 'expense',
    property_id: expense.property_id,
    transaction_date: expense.transaction_date,
    client_prop_id: expense.client_prop_id,
    property_name: expense.property_name,
    owner_name: expense.owner_name,
    amount: expense.amount,
    currency: expense.currency,
    section: expense.category || 'other',
    notes: expenseNotes(expense),
    company: expense.vendor_name,
    payment_method: expense.payment_method,
    source: expense.source,
    receipt_ref: expense.receipt_ref ?? null,
    source_file: expense.source_file ?? null,
    balance_after: expense.balance_after ?? null,
    paid_by_resident: Boolean(expense.paid_by_resident),
    paid_by_company: Boolean(expense.paid_by_company),
    paid_by_owner: Boolean(expense.paid_by_owner),
    ledger_column: expense.ledger_column ?? null,
    from_bank_statement: expense.source === 'bank_statement',
    needs_review: Boolean(expense.needs_review),
    review_reasons: expense.review_reasons ?? null,
  };
}

function asString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  return String(value);
}

function asNullableString(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

function asBool(value: unknown): boolean {
  return Boolean(value);
}

/** Map AI / API list rows (normalized or raw deposit/expense dumps) into UnifiedTransaction. */
export function recordToUnified(
  row: Record<string, unknown>,
  fallbackKind?: TransactionKind,
): UnifiedTransaction {
  const explicitKind = row.kind === 'deposit' || row.kind === 'expense' ? row.kind : null;
  const kind: TransactionKind =
    explicitKind ??
    fallbackKind ??
    (row.category != null || row.paid_by_resident != null || row.vendor_name != null
      ? 'expense'
      : 'deposit');

  if (kind === 'deposit' && row.section == null && row.client_prop_id != null) {
    return depositToUnified(row as unknown as Deposit);
  }
  if (kind === 'expense' && row.category != null && row.section == null) {
    return expenseToUnified(row as unknown as Expense);
  }

  const source = asNullableString(row.source);
  const section =
    asString(row.section) ||
    (kind === 'expense'
      ? asString(row.category, 'other')
      : asBool(row.is_rental_income)
        ? 'Rental income'
        : label(source || 'Inflow'));

  const notes =
    asNullableString(row.notes) ??
    asNullableString(row.description);

  return {
    id: asString(row.id),
    kind,
    property_id: asString(row.property_id),
    transaction_date: asNullableString(row.transaction_date),
    client_prop_id: asString(row.client_prop_id),
    property_name: asString(row.property_name),
    owner_name: asString(row.owner_name),
    amount: asString(row.amount, '0'),
    currency: asString(row.currency, 'ILS'),
    section,
    notes,
    company: asNullableString(row.company) ?? asNullableString(row.vendor_name),
    payment_method: asNullableString(row.payment_method),
    source,
    receipt_ref: asNullableString(row.receipt_ref),
    source_file: asNullableString(row.source_file),
    balance_after: asNullableString(row.balance_after),
    paid_by_resident: asBool(row.paid_by_resident),
    paid_by_company: asBool(row.paid_by_company),
    paid_by_owner: asBool(row.paid_by_owner),
    ledger_column: asNullableString(row.ledger_column),
    is_rental_income: asBool(row.is_rental_income),
    from_bank_statement:
      asBool(row.from_bank_statement) || source === 'bank_statement',
    needs_review: asBool(row.needs_review),
    review_reasons: asNullableString(row.review_reasons),
  };
}

export function looksLikeTransactionList(data: Record<string, unknown>[]): boolean {
  if (data.length === 0) return false;
  const sample = data[0];
  if (sample == null || typeof sample !== 'object') return false;
  const hasId = sample.id != null;
  const hasAmount = sample.amount != null;
  const hasTxnShape =
    'transaction_date' in sample ||
    'client_prop_id' in sample ||
    sample.kind === 'deposit' ||
    sample.kind === 'expense';
  const isAggregate =
    ('total_amount' in sample || 'deposit_count' in sample || 'expense_count' in sample) &&
    !('transaction_date' in sample) &&
    sample.kind == null;
  return hasId && hasAmount && hasTxnShape && !isAggregate;
}

export function transactionRowClassName(row: UnifiedTransaction): string {
  if (row.paid_by_resident) return 'row-resident-paid';
  if (row.paid_by_owner) return 'row-owner-paid';
  if (row.paid_by_company) return 'row-mip-paid';
  if (row.ledger_column === 'nearly_cc') return 'row-nearly-cc';
  if (row.ledger_column === 'cash') return 'row-cash-paid';
  if (row.ledger_column === 'other') return 'row-other-paid';
  if (row.is_rental_income) return 'row-rental-income';
  if (row.kind === 'deposit') return 'row-deposit';
  return 'row-expense';
}

export function transactionAmountClassName(row: UnifiedTransaction): string {
  if (row.paid_by_resident) return 'amount-resident-paid';
  if (row.paid_by_owner) return 'amount-owner-paid';
  if (row.paid_by_company) return 'amount-mip-paid';
  if (row.ledger_column === 'nearly_cc') return 'amount-nearly-cc';
  if (row.ledger_column === 'cash') return 'amount-cash-paid';
  if (row.ledger_column === 'other') return 'amount-other-paid';
  if (row.is_rental_income) return 'amount-rental-income';
  if (row.kind === 'deposit') return 'amount-deposit';
  return 'amount-expense';
}

export function formatTransactionFeedback(row: UnifiedTransaction): string {
  const lines = [
    'Feedback about this transaction:',
    '',
    '',
    '',
    '--- Transaction ---',
    `Type: ${row.kind === 'deposit' ? 'Deposit' : 'Expense'}`,
    `ID: ${row.id}`,
    `Prop ID: ${row.client_prop_id}`,
    `Property: ${row.property_name}`,
    `Owner: ${row.owner_name}`,
    `Date: ${row.transaction_date ?? 'Missing date'}`,
    `Section: ${row.section}`,
    `Notes: ${row.notes || '—'}`,
    `Amount: ${row.amount} ${row.currency}`,
    `Company: ${row.company || '—'}`,
  ];
  if (row.kind === 'expense') {
    if (row.payment_method) lines.push(`Method: ${row.payment_method}`);
    if (row.source) lines.push(`Source: ${row.source}`);
    if (row.paid_by_resident) lines.push('Flag: He/She paid');
    if (row.paid_by_owner) lines.push('Flag: Owner paid');
    if (row.paid_by_company) lines.push('Flag: MIP paid');
    if (row.ledger_column) lines.push(`Ledger column: ${row.ledger_column}`);
  } else {
    if (row.is_rental_income) lines.push('Flag: Rental income');
    if (row.source) lines.push(`Source: ${row.source}`);
  }
  if (row.needs_review) {
    lines.push(`Needs review: yes (${row.review_reasons || 'unspecified'})`);
  }
  if (row.source_file) lines.push(`Source file: ${row.source_file}`);
  lines.push('-------------------');
  return lines.join('\n');
}
