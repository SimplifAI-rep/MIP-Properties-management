import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export type TxnSharedFilters = {
  property_id?: string;
  client_prop_id?: string;
  owner_id?: string;
  date_from?: string;
  date_to?: string;
};

export type TxnListFilters = TxnSharedFilters & {
  source_file?: string;
  needs_review?: boolean;
};

/** Build the shared filter object used in Transactions query keys. */
export function buildTxnSharedFilters(partial: TxnSharedFilters = {}): TxnSharedFilters {
  return {
    property_id: partial.property_id,
    client_prop_id: partial.client_prop_id,
    owner_id: partial.owner_id,
    date_from: partial.date_from,
    date_to: partial.date_to,
  };
}

export function buildTxnListFilters(partial: TxnListFilters = {}): TxnListFilters {
  return {
    ...buildTxnSharedFilters(partial),
    source_file: partial.source_file,
    needs_review: partial.needs_review,
  };
}

export const DEFAULT_TXN_SHARED_FILTERS = buildTxnSharedFilters();
export const DEFAULT_TXN_LIST_FILTERS = buildTxnListFilters();

/**
 * Warm React Query cache for the default Transactions view so navigation
 * feels instant. Safe to call on every app shell mount (deduped by query keys).
 */
export function prefetchTransactionsData(queryClient: QueryClient): void {
  void queryClient.prefetchQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  void queryClient.prefetchQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  void queryClient.prefetchQuery({
    queryKey: ['deposits', DEFAULT_TXN_LIST_FILTERS, undefined],
    queryFn: () =>
      api.getAllDeposits({
        ...DEFAULT_TXN_LIST_FILTERS,
        is_rental_income: undefined,
      }),
  });
  void queryClient.prefetchQuery({
    queryKey: [
      'expenses',
      DEFAULT_TXN_LIST_FILTERS,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    queryFn: () =>
      api.getAllExpenses({
        ...DEFAULT_TXN_LIST_FILTERS,
        category: undefined,
        source: undefined,
        paid_by_resident: undefined,
        paid_by_owner: undefined,
      }),
  });
  void queryClient.prefetchQuery({
    queryKey: ['deposit-summary', DEFAULT_TXN_SHARED_FILTERS, undefined],
    queryFn: () =>
      api.getDepositSummary({
        ...DEFAULT_TXN_SHARED_FILTERS,
        source_file: undefined,
        include_all: false,
      }),
  });
  void queryClient.prefetchQuery({
    queryKey: ['expense-summary', DEFAULT_TXN_SHARED_FILTERS, undefined, undefined, undefined],
    queryFn: () =>
      api.getExpenseSummary({
        ...DEFAULT_TXN_SHARED_FILTERS,
        category: undefined,
        source: undefined,
        source_file: undefined,
        include_all: false,
      }),
  });
}
