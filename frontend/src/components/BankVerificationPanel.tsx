import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { DateInputDMY } from './ui/DateInputDMY';
import { formatCurrency, formatDate } from './ui/States';
import { Tooltip } from './ui/Tooltip';
import { getUserErrorMessage } from '../utils/errors';

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function BankVerificationPanel() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: api.getBankSettings,
  });

  const [editing, setEditing] = useState(false);
  const [openingBalance, setOpeningBalance] = useState('');
  const [asOfDate, setAsOfDate] = useState(todayISO());
  const [lastVerificationDate, setLastVerificationDate] = useState(todayISO());
  const [gapTolerance, setGapTolerance] = useState('0.01');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const data = settingsQuery.data;
    if (!data) return;
    setOpeningBalance(data.opening_balance ?? '');
    setAsOfDate(data.opening_balance_as_of ?? todayISO());
    setLastVerificationDate(data.last_verification_date ?? todayISO());
    setGapTolerance(data.gap_tolerance_amount ?? '0.01');
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: api.updateBankSettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      setEditing(false);
      setMessage('Bank settings saved.');
      setError(null);
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const cutoverMutation = useMutation({
    mutationFn: api.runBankCutover,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['bank-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setEditing(false);
      setMessage(
        `Cutover done. Marked ${result.deposits_marked} deposits and ${result.expenses_marked} expenses as Verified through ${formatDate(result.settings.last_verification_date!)}.`,
      );
      setError(null);
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const data = settingsQuery.data;
  const busy = saveMutation.isPending || cutoverMutation.isPending;

  function runSave() {
    const amount = openingBalance.trim();
    if (amount && Number(amount) < 0) {
      setError('Opening balance cannot be negative.');
      return;
    }
    saveMutation.mutate({
      ...(amount ? { opening_balance: amount } : { clear_opening_balance: true }),
      ...(asOfDate
        ? { opening_balance_as_of: asOfDate }
        : { clear_opening_balance_as_of: true }),
      ...(lastVerificationDate
        ? { last_verification_date: lastVerificationDate }
        : { clear_last_verification_date: true }),
      gap_tolerance_amount: gapTolerance.trim() || '0.01',
    });
  }

  function runCutover() {
    const amount = openingBalance.trim();
    if (!amount || Number(amount) < 0 || !asOfDate) {
      setError('Enter opening balance and as-of date (D₀) before cutover.');
      return;
    }
    const ok = window.confirm(
      `Go-live cutover will:\n` +
        `• Set opening bank amount to ${amount} as of ${asOfDate}\n` +
        `• Mark all transactions on or before ${asOfDate} as Verified (no bank אסמכתא)\n` +
        `• Set last verification date to ${asOfDate}\n\n` +
        `Continue?`,
    );
    if (!ok) return;
    cutoverMutation.mutate({
      opening_balance: amount,
      as_of_date: asOfDate,
      gap_tolerance_amount: gapTolerance.trim() || '0.01',
    });
  }

  return (
    <section className="panel p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Bank verification
          </h3>
          <p className="mt-1 text-sm muted-text">
            Separate from company float. Opening balance + last verification date for the
            operating account.
          </p>
        </div>
        {!editing ? (
          <button
            type="button"
            className="btn-secondary shrink-0 text-sm"
            onClick={() => {
              setEditing(true);
              setMessage(null);
              setError(null);
            }}
          >
            Edit / cutover
          </button>
        ) : null}
      </div>

      {settingsQuery.isLoading ? (
        <p className="mt-3 text-sm muted-text">Loading bank settings…</p>
      ) : settingsQuery.isError ? (
        <p className="mt-3 text-sm text-red-600">
          {getUserErrorMessage(settingsQuery.error)}
        </p>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="label-text">
              <Tooltip content="Books are considered bank-verified through this date.">
                Bank verified through
              </Tooltip>
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {data?.last_verification_date
                ? formatDate(data.last_verification_date)
                : 'Not set'}
            </p>
          </div>
          <div>
            <p className="label-text">Opening bank amount</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {data?.opening_balance != null
                ? formatCurrency(data.opening_balance)
                : 'Not set'}
            </p>
            {data?.opening_balance_as_of ? (
              <p className="text-xs muted-text">
                as of {formatDate(data.opening_balance_as_of)}
              </p>
            ) : null}
          </div>
          <div>
            <p className="label-text">
              <Tooltip content="Admin Gap ≈ 0 threshold (used in later reconcile steps).">
                Gap tolerance
              </Tooltip>
            </p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {formatCurrency(data?.gap_tolerance_amount ?? '0.01')}
            </p>
          </div>
          <div>
            <p className="label-text">Unverified since then</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {data?.unverified_count ?? 0}
            </p>
          </div>
        </div>
      )}

      {editing ? (
        <div className="mt-4 grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-700 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="label-text">Opening balance (ILS)</span>
            <input
              className="field"
              type="number"
              step="0.01"
              min="0"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Opening as-of date</span>
            <DateInputDMY
              value={asOfDate || undefined}
              onChange={(iso) => setAsOfDate(iso ?? '')}
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Last verification date</span>
            <DateInputDMY
              value={lastVerificationDate || undefined}
              onChange={(iso) => setLastVerificationDate(iso ?? '')}
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Gap tolerance (ILS)</span>
            <input
              className="field"
              type="number"
              step="0.01"
              min="0"
              value={gapTolerance}
              onChange={(e) => setGapTolerance(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={runSave}
            >
              {saveMutation.isPending ? 'Saving…' : 'Save settings'}
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy}
              onClick={runCutover}
            >
              {cutoverMutation.isPending ? 'Running…' : 'Run go-live cutover'}
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          <p className="sm:col-span-2 lg:col-span-4 text-xs muted-text">
            <strong>Save</strong> updates settings only.
            <strong> Cutover</strong> uses opening balance + as-of (D₀), marks every
            deposit/expense dated on or before D₀ as Verified without a bank אסמכתא, and
            sets last verification = D₀. New activity after D₀ stays Unverified.
          </p>
        </div>
      ) : null}

      {message ? <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
