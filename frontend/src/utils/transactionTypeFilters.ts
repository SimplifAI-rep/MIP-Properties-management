import type { Transaction } from '../types';

/** Filters that match Excel money lanes + Deposit/Expense. */
export type TypeFilterKind =
  | 'deposit'
  | 'expense'
  | 'rental_income'
  | 'he_she_paid'
  | 'owner_paid'
  | 'bank_statement'
  | 'nearly_cc'
  | 'created_from_verification';

export type AlertFilterKind = 'incomplete_import';
export type PropertyStatusFilter = 'active' | 'inactive';

/** Default Type filter: company-float lanes plus rental so a new rental row is visible. */
export const DEFAULT_TYPE_KINDS: TypeFilterKind[] = [
  'deposit',
  'expense',
  'rental_income',
];

export const TYPE_FILTER_OPTIONS: { value: TypeFilterKind; label: string }[] = [
  { value: 'deposit', label: 'Deposit (Inflow)' },
  { value: 'expense', label: 'Expense (Amount)' },
  { value: 'rental_income', label: 'Rental income' },
  { value: 'he_she_paid', label: 'He/She paid' },
  { value: 'owner_paid', label: 'Owner paid' },
  { value: 'bank_statement', label: 'Bank statement' },
  { value: 'nearly_cc', label: 'Nearly CC' },
  { value: 'created_from_verification', label: 'Created from verification' },
];

export const PROPERTY_STATUS_OPTIONS: {
  value: PropertyStatusFilter;
  label: string;
}[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

export const ALERT_FILTER_OPTIONS: { value: AlertFilterKind; label: string }[] = [
  { value: 'incomplete_import', label: 'Incomplete import' },
];

export function isDefaultTypeFilter(kinds: TypeFilterKind[]): boolean {
  return (
    kinds.length === DEFAULT_TYPE_KINDS.length &&
    DEFAULT_TYPE_KINDS.every((kind) => kinds.includes(kind))
  );
}

export function rowTypeTags(row: Transaction): TypeFilterKind[] {
  const tags: TypeFilterKind[] = [];
  if (row.kind === 'deposit') {
    tags.push(row.is_rental_income ? 'rental_income' : 'deposit');
  } else if (row.paid_by_resident) {
    tags.push('he_she_paid');
  } else if (row.paid_by_owner) {
    tags.push('owner_paid');
  } else {
    tags.push('expense');
  }
  if (row.from_bank_statement) tags.push('bank_statement');
  if (row.ledger_column === 'nearly_cc') tags.push('nearly_cc');
  if (
    (row.review_reasons || '')
      .split(',')
      .map((part) => part.trim())
      .includes('created_from_verification')
  ) {
    tags.push('created_from_verification');
  }
  return tags;
}

export function includeDepositsFromFilters(
  kinds: TypeFilterKind[],
  alertFilters: AlertFilterKind[],
): boolean {
  return (
    kinds.length === 0 ||
    kinds.includes('deposit') ||
    kinds.includes('rental_income') ||
    kinds.includes('bank_statement') ||
    kinds.includes('created_from_verification') ||
    alertFilters.includes('incomplete_import')
  );
}

export function includeExpensesFromFilters(
  kinds: TypeFilterKind[],
  alertFilters: AlertFilterKind[],
): boolean {
  return (
    kinds.length === 0 ||
    kinds.includes('expense') ||
    kinds.includes('he_she_paid') ||
    kinds.includes('owner_paid') ||
    kinds.includes('bank_statement') ||
    kinds.includes('nearly_cc') ||
    kinds.includes('created_from_verification') ||
    alertFilters.includes('incomplete_import')
  );
}

export function depositTypeApiFilter(kinds: TypeFilterKind[]): boolean | undefined {
  if (kinds.length === 1 && kinds[0] === 'deposit') return false;
  if (kinds.length === 1 && kinds[0] === 'rental_income') return true;
  return undefined;
}

export function expenseResidentApiFilter(kinds: TypeFilterKind[]): boolean | undefined {
  if (kinds.length === 1 && kinds[0] === 'he_she_paid') return true;
  if (kinds.length === 1 && kinds[0] === 'expense') return false;
  return undefined;
}

export function expenseOwnerApiFilter(kinds: TypeFilterKind[]): boolean | undefined {
  if (kinds.length === 1 && kinds[0] === 'owner_paid') return true;
  if (kinds.length === 1 && kinds[0] === 'expense') return false;
  return undefined;
}

export function applyClientTxnFilters(
  rows: Transaction[],
  opts: {
    kinds: TypeFilterKind[];
    alertFilters: AlertFilterKind[];
    sections: string[];
    sources: string[];
    sourceFiles: string[];
  },
): Transaction[] {
  let merged = rows;
  if (opts.kinds.length > 0) {
    const kindSet = new Set(opts.kinds);
    merged = merged.filter((row) => rowTypeTags(row).some((tag) => kindSet.has(tag)));
  }
  if (opts.alertFilters.includes('incomplete_import')) {
    merged = merged.filter((row) => Boolean(row.needs_review));
  }
  if (opts.sections.length > 1) {
    const set = new Set(opts.sections.map((value) => value.toLowerCase()));
    merged = merged.filter((row) => set.has(row.section.toLowerCase()));
  }
  if (opts.sources.length > 1) {
    const sourceSet = new Set(opts.sources);
    merged = merged.filter((row) => {
      if (row.kind !== 'expense') return true;
      return row.source ? sourceSet.has(row.source) : false;
    });
  }
  if (opts.sourceFiles.length > 1) {
    const fileSet = new Set(opts.sourceFiles);
    merged = merged.filter((row) => Boolean(row.source_file && fileSet.has(row.source_file)));
  }
  return merged;
}
