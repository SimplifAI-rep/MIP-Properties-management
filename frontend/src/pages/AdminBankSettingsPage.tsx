import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { DateInputDMY } from '../components/ui/DateInputDMY';
import { formatCurrency, formatDate } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { getUserErrorMessage } from '../utils/errors';

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Admin-only bank verification settings and historical cutover. */
export function AdminBankSettingsPage() {
  const queryClient = useQueryClient();
  const [bankAccountId, setBankAccountId] = useState<string>('');

  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: api.getVerificationWorkspace,
  });
  const accounts = workspaceQuery.data?.operating_accounts ?? [];

  useEffect(() => {
    if (bankAccountId || accounts.length === 0) return;
    setBankAccountId(accounts[0].id);
  }, [accounts, bankAccountId]);

  const settingsQuery = useQuery({
    queryKey: ['bank-settings', bankAccountId || null],
    queryFn: () => api.getBankSettings(bankAccountId || null),
    enabled: Boolean(bankAccountId) || accounts.length === 0,
  });

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
      void queryClient.invalidateQueries({ queryKey: ['verification-workspace'] });
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
      void queryClient.invalidateQueries({ queryKey: ['verification-workspace'] });
      setMessage(
        `Cutover complete. Marked ${result.deposits_marked} deposits and ${result.expenses_marked} expenses as verified through ${formatDate(result.settings.last_verification_date!)}.`,
      );
      setError(null);
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const busy = saveMutation.isPending || cutoverMutation.isPending;
  const data = settingsQuery.data;

  function runSave() {
    const amount = openingBalance.trim();
    if (amount && Number(amount) < 0) {
      setError('Opening balance cannot be negative.');
      return;
    }
    saveMutation.mutate({
      bank_account_id: bankAccountId || null,
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
      setError('Enter an opening balance and effective date before cutover.');
      return;
    }
    const ok = window.confirm(
      `This will:\n` +
        `• Set opening balance to ${amount} as of ${asOfDate}\n` +
        `• Mark all transactions on or before ${asOfDate} as verified\n` +
        `• Set bank verified through to ${asOfDate}\n\n` +
        `Continue?`,
    );
    if (!ok) return;
    cutoverMutation.mutate({
      opening_balance: amount,
      as_of_date: asOfDate,
      gap_tolerance_amount: gapTolerance.trim() || '0.01',
      bank_account_id: bankAccountId || null,
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="page-heading">Bank settings</h2>
        <p className="page-desc">
          Configure opening balance per operating account, gap tolerance, and historical
          cutover.
        </p>
      </div>

      <section className="panel p-4 sm:p-5 space-y-4">
        {accounts.length > 0 ? (
          <label className="text-sm flex flex-wrap items-center gap-2">
            <span className="label-text">Operating account</span>
            <select
              className="field py-1 text-sm min-w-[16rem]"
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {settingsQuery.isLoading ? (
          <p className="text-sm muted-text">Loading…</p>
        ) : settingsQuery.isError ? (
          <p className="text-sm text-red-600">{getUserErrorMessage(settingsQuery.error)}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="label-text">Opening balance</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {data?.opening_balance != null
                  ? formatCurrency(data.opening_balance)
                  : 'Not set'}
              </p>
            </div>
            <div>
              <p className="label-text">Bank verified through</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {data?.last_verification_date
                  ? formatDate(data.last_verification_date)
                  : 'Not set'}
              </p>
            </div>
            <div>
              <p className="label-text">Gap tolerance</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCurrency(data?.gap_tolerance_amount ?? '0.01')}
              </p>
            </div>
            <div>
              <p className="label-text">Unverified transactions</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {data?.unverified_count ?? 0}
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-700 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="label-text">
              <Tooltip content="Starting bank balance for gap calculations. Shown read-only on Verification.">
                Opening balance (ILS)
              </Tooltip>
            </span>
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
            <span className="label-text">Effective date</span>
            <DateInputDMY
              value={asOfDate || undefined}
              onChange={(iso) => setAsOfDate(iso ?? '')}
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Bank verified through</span>
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
              {cutoverMutation.isPending ? 'Running…' : 'Apply cutover'}
            </button>
          </div>
          <p className="sm:col-span-2 lg:col-span-4 text-xs muted-text">
            Save updates settings only. Cutover sets the opening balance and effective date,
            marks transactions on or before that date as verified, and updates bank verified
            through.
          </p>
        </div>

        {message ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </section>
    </div>
  );
}
