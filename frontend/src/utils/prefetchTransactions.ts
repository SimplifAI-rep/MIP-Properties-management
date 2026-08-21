import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

type TxnSharedFilters = {
  property_id?: string;
  property_ids?: string[];
  client_prop_id?: string;
  client_prop_ids?: string[];
  owner_id?: string;
  owner_ids?: string[];
  property_status?: 'active' | 'inactive';
  date_from?: string;
  date_to?: string;
};

type TxnListFilters = TxnSharedFilters & {
  source_file?: string;
  needs_review?: boolean;
};

/** Build the shared filter object used in Transactions query keys. */
export function buildTxnSharedFilters(partial: TxnSharedFilters = {}): TxnSharedFilters {
  return {
    property_id: partial.property_id,
    property_ids: partial.property_ids,
    client_prop_id: partial.client_prop_id,
    client_prop_ids: partial.client_prop_ids,
    owner_id: partial.owner_id,
    owner_ids: partial.owner_ids,
    property_status: partial.property_status,
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

const DEFAULT_TXN_SHARED_FILTERS = buildTxnSharedFilters({ property_status: 'active' });
const DEFAULT_TXN_LIST_FILTERS = buildTxnListFilters({ property_status: 'active' });

/**
 * Warm React Query cache for the default Transactions view so navigation
 * feels instant. Prefetches first pages only (not the full ledger).
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
    queryKey: ['deposits', DEFAULT_TXN_LIST_FILTERS, undefined, 'page', 1],
    queryFn: () =>
      api.getDeposits({
        ...DEFAULT_TXN_LIST_FILTERS,
        page: 1,
        page_size: 50,
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
      'page',
      1,
    ],
    queryFn: () =>
      api.getExpenses({
        ...DEFAULT_TXN_LIST_FILTERS,
        page: 1,
        page_size: 50,
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
