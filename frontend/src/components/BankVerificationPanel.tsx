import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';

/** Read-only glance on Verification. Opening balance is set in Admin only. */
export function BankVerificationPanel() {
  const { isAdmin } = useAuth();
  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: () => api.getBankSettings(),
  });

  if (settingsQuery.isLoading) {
    return <p className="p-4 text-sm muted-text">Loading…</p>;
  }
  if (settingsQuery.isError) {
    return (
      <p className="p-4 text-sm text-red-600">{getUserErrorMessage(settingsQuery.error)}</p>
    );
  }

  const data = settingsQuery.data!;

  return (
    <section className="p-4 sm:p-5 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="label-text">Opening balance</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {data.opening_balance != null ? formatCurrency(data.opening_balance) : 'Not set'}
          </p>
          {data.opening_balance_as_of ? (
            <p className="text-xs muted-text">As of {formatDate(data.opening_balance_as_of)}</p>
          ) : null}
        </div>
        <div>
          <p className="label-text">Bank verified through</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {data.last_verification_date
              ? formatDate(data.last_verification_date)
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
      {isAdmin ? (
        <p className="text-xs muted-text">
          <Link to="/admin/bank-settings" className="underline">
            Edit in Admin → Bank settings
          </Link>
        </p>
      ) : null}
    </section>
  );
}
