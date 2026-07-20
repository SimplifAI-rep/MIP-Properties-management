export type TransactionsTypeFilter = 'all' | 'deposit' | 'expense';

export type TransactionsFilterState = {
  propertyId?: string;
  clientPropId?: string;
  ownerId?: string;
  dateFrom?: string;
  dateTo?: string;
  typeFilter?: TransactionsTypeFilter;
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
