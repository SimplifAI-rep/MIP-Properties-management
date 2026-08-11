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

/**
 * After ClientData import replaces owners/properties/ledger rows.
 * Prefer this over invalidateQueries() so unrelated cache (auth, UI) stays warm.
 */
export function invalidateAfterClientDataImport(queryClient: QueryClient): void {
  invalidateTransactionData(queryClient);
  queryClient.invalidateQueries({ queryKey: ['owners'] });
  queryClient.invalidateQueries({ queryKey: ['owner'] });
  queryClient.invalidateQueries({ queryKey: ['properties'] });
  queryClient.invalidateQueries({ queryKey: ['property'] });
  queryClient.invalidateQueries({ queryKey: ['deposit-gaps'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-period-float'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-recent-deposits'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard-recent-expenses'] });
  queryClient.invalidateQueries({ queryKey: ['transaction-years'] });
  queryClient.invalidateQueries({ queryKey: ['client-data-status'] });
  queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
}
