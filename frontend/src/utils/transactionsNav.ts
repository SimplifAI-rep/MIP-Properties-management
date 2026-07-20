export type TransactionsFilterState = {
  propertyId?: string;
  clientPropId?: string;
  ownerId?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type PeriodDateRange = {
  dateFrom: string;
  dateTo: string;
};

export function propertyTransactionsState(
  propertyId: string,
  clientPropId?: string | null,
  period?: PeriodDateRange | null,
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
  };
}

export function ownerTransactionsState(
  ownerId: string,
  period?: PeriodDateRange | null,
): TransactionsFilterState {
  return {
    ownerId,
    ...(period
      ? {
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
        }
      : {}),
  };
}
