import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  formatDate,
} from '../components/ui/States';
import { recordToUnified } from '../utils/unifiedTransaction';

export function NextCyclePage() {
  const deferredQuery = useQuery({
    queryKey: ['expenses', 'deferred'],
    queryFn: () =>
      api.getAllExpenses({
        deferred_only: true,
        include_running_balance: false,
      }),
  });

  if (deferredQuery.isLoading) return <LoadingState />;
  if (deferredQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load charges pushed to the next cycle."
        error={deferredQuery.error}
      />
    );
  }

  const rows = (deferredQuery.data?.items ?? []).map((row) =>
    recordToUnified(row as unknown as Record<string, unknown>, 'expense'),
  );

  return (
    <div className="space-y-5">
      <div>
        <h2 className="page-heading">Next cycle</h2>
        <p className="page-desc mt-1">
          Card charges pushed forward until the next verification period. They show
          at the top of Verification as soon as you upload the next statement.
        </p>
      </div>

      <section className="panel overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState message="Nothing is waiting for the next cycle." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <p className="text-sm">
                <span className="font-medium tabular-nums">{rows.length}</span>
                <span className="muted-text"> waiting</span>
              </p>
              <Link to="/verification" className="btn-secondary text-xs">
                Open Verification
              </Link>
            </div>
            <TransactionTable
              rows={rows}
              emptyMessage="Nothing is waiting for the next cycle."
              showBalance={false}
              className="overflow-x-auto"
              actionsColWidth="w-[12%]"
              renderActions={(row) => (
                <span className="text-xs muted-text tabular-nums">
                  After {formatDate(row.cc_deferred_until)}
                </span>
              )}
            />
          </>
        )}
      </section>
    </div>
  );
}
