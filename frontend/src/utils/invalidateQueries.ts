import type { QueryClient } from '@tanstack/react-query';

/** Invalidate ledger lists, summaries, and alert badges after mutation/import. */
export function invalidateTransactionData(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['deposits'] });
  queryClient.invalidateQueries({ queryKey: ['expenses'] });
  queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
  queryClient.invalidateQueries({ queryKey: ['deposit-summary-rental'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary-heshe'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary-owner'] });
  queryClient.invalidateQueries({ queryKey: ['alerts'] });
  queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
}

/** Invalidate alert list/summary only. */
export function invalidateAlertData(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['alerts'] });
  queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
}
