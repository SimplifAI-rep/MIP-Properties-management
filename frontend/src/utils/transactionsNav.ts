import type { DepositQueryIntent } from '../types';

export type TransactionsTypeFilter = 'all' | 'deposit' | 'expense';
export type TransactionsTypeKind =
  | 'deposit'
  | 'expense'
  | 'rental_income'
  | 'he_she_paid'
  | 'owner_paid'
  | 'bank_statement'
  | 'nearly_cc';
export type TransactionsAlertFilter = 'incomplete_import';

export type TransactionsFilterState = {
  propertyId?: string;
  clientPropId?: string;
  ownerId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Legacy single type from dashboard/property links. */
  typeFilter?: TransactionsTypeFilter;
  kinds?: TransactionsTypeKind[];
  sections?: string[];
  sources?: string[];
  sourceFiles?: string[];
  alertFilters?: TransactionsAlertFilter[];
};

export type PeriodDateRange = {
  dateFrom: string;
  dateTo: string;
};

export function propertyTransactionsState(
  propertyId: string,
  clientPropId?: string | null,
  period?: PeriodDateRange | null,
  typeFilter?: TransactionsTypeFilter,
): TransactionsFilterState {
  return {
    propertyId,
    clientPropId: clientPropId ?? undefined,
    ...(period
      ? {
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        }
      : {}),
    ...(typeFilter ? { typeFilter } : {}),
  };
}

export function ownerTransactionsState(
  ownerId: string,
  period?: PeriodDateRange | null,
  typeFilter?: TransactionsTypeFilter,
): TransactionsFilterState {
  return {
    ownerId,
    ...(period
      ? {
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        }
      : {}),
    ...(typeFilter ? { typeFilter } : {}),
  };
}

/** Map an AI query intent into Transactions page filter state. */
export function aiIntentToTransactionsState(
  intent: DepositQueryIntent,
): TransactionsFilterState {
  const kinds: TransactionsTypeKind[] = [];
  const domain = intent.domain ?? 'deposits';

  if (intent.is_rental_income) {
    kinds.push('rental_income');
  } else if (intent.paid_by_resident) {
    kinds.push('he_she_paid');
  } else if (intent.paid_by_owner) {
    kinds.push('owner_paid');
  } else if (domain === 'deposits') {
    kinds.push('deposit');
  } else if (domain === 'expenses') {
    kinds.push('expense');
  } else {
    kinds.push('deposit', 'expense');
  }

  const alertFilters: TransactionsAlertFilter[] = [];
  if (intent.needs_review) {
    alertFilters.push('incomplete_import');
  }

  const sections = intent.category ? [intent.category] : undefined;
  const sources = intent.source ? [intent.source] : undefined;
  const sourceFiles = intent.source_file ? [intent.source_file] : undefined;

  return {
    propertyId: intent.property_id ?? undefined,
    clientPropId: intent.client_prop_id ?? undefined,
    ownerId: intent.owner_id ?? undefined,
    dateFrom: intent.date_from ?? undefined,
    dateTo: intent.date_to ?? undefined,
    kinds,
    ...(sections ? { sections } : {}),
    ...(sources ? { sources } : {}),
    ...(sourceFiles ? { sourceFiles } : {}),
    ...(alertFilters.length ? { alertFilters } : {}),
  };
}
