import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { formatCurrency, formatDate } from './ui/States';
import { Tooltip } from './ui/Tooltip';
import { getUserErrorMessage } from '../utils/errors';

/** Compact Dashboard summary — full controls live on Verification tab. */
export function BankVerificationSummaryCard() {
  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: () => api.getBankSettings(),
  });

  if (settingsQuery.isLoading) {
    return (
      <section className="panel p-4 sm:p-5">
        <p className="text-sm muted-text">Loading bank verification…</p>
      </section>
    );
  }

  if (settingsQuery.isError) {
    return (
      <section className="panel p-4 sm:p-5">
        <p className="text-sm text-red-600">{getUserErrorMessage(settingsQuery.error)}</p>
      </section>
    );
  }

  const data = settingsQuery.data!;

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Bank verification
          </h3>
          <p className="mt-1 text-sm muted-text">
            Opening balance, verified-through date, and pending bank transactions.
          </p>
        </div>
        <Link to="/verification" className="btn-primary shrink-0 text-sm">
          Open Verification
        </Link>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="label-text">
            <Tooltip content="Books are considered bank-verified through this date.">
              Bank verified through
            </Tooltip>
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {data.last_verification_date
              ? formatDate(data.last_verification_date)
              : 'Not set'}
          </p>
        </div>
        <div>
          <p className="label-text">Opening balance</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {data.opening_balance != null
              ? formatCurrency(data.opening_balance)
              : 'Not set'}
          </p>
        </div>
        <div>
          <p className="label-text">Gap tolerance</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatCurrency(data.gap_tolerance_amount)}
          </p>
        </div>
        <div>
          <p className="label-text">Unverified transactions</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{data.unverified_count}</p>
        </div>
      </div>
    </section>
  );
}
