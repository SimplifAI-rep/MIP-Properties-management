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
  propertyIds?: string[];
  clientPropIds?: string[];
  ownerIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  /** Legacy single type from older deep links. Prefer `kinds`. */
  typeFilter?: TransactionsTypeFilter;
  kinds?: TransactionsTypeKind[];
  sections?: string[];
  sources?: string[];
  sourceFiles?: string[];
  alertFilters?: TransactionsAlertFilter[];
  showUpload?: boolean;
  showForm?: boolean;
  highlightId?: string;
  highlightKind?: string;
  /** @deprecated Prefer propertyIds — still accepted by parseTransactionsLocationState. */
  propertyId?: string;
  /** @deprecated Prefer clientPropIds. */
  clientPropId?: string;
  /** @deprecated Prefer ownerIds. */
  ownerId?: string;
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
    propertyIds: [propertyId],
    clientPropIds: clientPropId ? [clientPropId] : undefined,
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
    ownerIds: [ownerId],
    ...(period
      ? {
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        }
      : {}),
    ...(typeFilter ? { typeFilter } : {}),
  };
}

/** Normalize router location.state into Transactions filter fields. */
export function parseTransactionsLocationState(
  state: unknown,
): TransactionsFilterState | null {
  if (!state || typeof state !== 'object') return null;
  const raw = state as TransactionsFilterState;

  const propertyIds =
    raw.propertyIds && raw.propertyIds.length > 0
      ? raw.propertyIds
      : raw.propertyId
        ? [raw.propertyId]
        : undefined;
  const clientPropIds =
    raw.clientPropIds && raw.clientPropIds.length > 0
      ? raw.clientPropIds
      : raw.clientPropId
        ? [raw.clientPropId]
        : undefined;
  const ownerIds =
    raw.ownerIds && raw.ownerIds.length > 0
      ? raw.ownerIds
      : raw.ownerId
        ? [raw.ownerId]
        : undefined;

  return {
    propertyIds,
    clientPropIds,
    ownerIds,
    dateFrom: raw.dateFrom,
    dateTo: raw.dateTo,
    typeFilter: raw.typeFilter,
    kinds: raw.kinds,
    sections: raw.sections,
    sources: raw.sources,
    sourceFiles: raw.sourceFiles,
    alertFilters: raw.alertFilters,
    showUpload: raw.showUpload,
    showForm: raw.showForm,
    highlightId: raw.highlightId,
    highlightKind: raw.highlightKind,
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

  const propertyIds = [
    ...new Set(
      [
        ...(intent.property_ids ?? []),
        ...(intent.property_id ? [intent.property_id] : []),
      ].filter(Boolean),
    ),
  ];
  const clientPropIds = [
    ...new Set(
      [
        ...(intent.client_prop_ids ?? []),
        ...(intent.client_prop_id ? [intent.client_prop_id] : []),
      ].filter(Boolean),
    ),
  ];
  const ownerIds = [
    ...new Set(
      [
        ...(intent.owner_ids ?? []),
        ...(intent.owner_id ? [intent.owner_id] : []),
      ].filter(Boolean),
    ),
  ];

  return {
    propertyIds: propertyIds.length ? propertyIds : undefined,
    clientPropIds: clientPropIds.length ? clientPropIds : undefined,
    ownerIds: ownerIds.length ? ownerIds : undefined,
    dateFrom: intent.date_from ?? undefined,
    dateTo: intent.date_to ?? undefined,
    kinds,
    ...(sections ? { sections } : {}),
    ...(sources ? { sources } : {}),
    ...(sourceFiles ? { sourceFiles } : {}),
    ...(alertFilters.length ? { alertFilters } : {}),
  };
}
