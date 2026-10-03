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
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });

  if (settingsQuery.isLoading || workspaceQuery.isLoading) {
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
  const headline = workspaceQuery.data?.headline;
  const periodOpen = Boolean(headline?.period_open);
  const bankBalance = headline?.bank_balance ?? data.opening_balance;
  const offsetRaw = headline?.verification_offset ?? '0';
  const offsetNum = Number(offsetRaw);
  const offsetTone =
    !periodOpen || offsetNum === 0
      ? ''
      : offsetNum > 0
        ? 'amount-deposit'
        : 'amount-expense';

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Bank verification
          </h3>
          <p className="mt-1 text-sm muted-text">
            Last closing balance, and the gap of the period in progress (0 when nothing is open).
          </p>
        </div>
        <Link to="/verification" className="btn-primary shrink-0 text-sm">
          Open Verification
        </Link>
      </div>
      {periodOpen ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          A verification period is still open.
        </p>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="label-text">
            <Tooltip content="Closing of the last finished period, or the opening balance if none has been finished yet.">
              Bank balance
            </Tooltip>
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {bankBalance != null ? formatCurrency(bankBalance) : 'Not set'}
          </p>
          <p className="mt-0.5 text-xs muted-text">
            {headline?.bank_balance_date
              ? `Closing · ${formatDate(headline.bank_balance_date)}`
              : data.opening_balance != null
                ? 'Opening — no period finished yet'
                : 'Ask an admin to set it'}
          </p>
        </div>
        <div>
          <p className="label-text">
            <Tooltip content="How far the open period is from matching. 0 when no period is in progress.">
              Verification offset
            </Tooltip>
          </p>
          <p className={`mt-1 text-lg font-semibold tabular-nums ${offsetTone}`.trim()}>
            {formatCurrency(offsetRaw)}
          </p>
          <p className="mt-0.5 text-xs muted-text">
            {periodOpen ? 'Open period gap' : 'No open period'}
          </p>
        </div>
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
          <p className="label-text">Unverified transactions</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{data.unverified_count}</p>
        </div>
      </div>
    </section>
  );
}
