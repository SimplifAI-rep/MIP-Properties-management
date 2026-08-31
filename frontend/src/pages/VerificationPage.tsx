import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { BankReconcilePanel } from '../components/BankReconcilePanel';
import { BankVerificationPanel } from '../components/BankVerificationPanel';
import { CcReconcilePanel } from '../components/CcReconcilePanel';
import { formatCurrency, formatDate } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { getUserErrorMessage } from '../utils/errors';

export function VerificationPage() {
  const queryClient = useQueryClient();
  const [bankBalanceInput, setBankBalanceInput] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [parseInfo, setParseInfo] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: api.getBankSettings,
  });

  const gapQuery = useQuery({
    queryKey: ['bank-gap', bankBalanceInput || null, dateTo || null],
    queryFn: () =>
      api.getBankGap({
        bank_balance: bankBalanceInput.trim() || undefined,
        date_to: dateTo.trim() || undefined,
      }),
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
  }, [settingsQuery.dataUpdatedAt, queryClient]);

  const parseMutation = useMutation({
    mutationFn: api.parseBankBalance,
    onSuccess: (result) => {
      setBankBalanceInput(String(result.bank_balance));
      // Default Net through date to earliest movement date in the file
      if (result.statement_start_date) {
        setDateTo(result.statement_start_date);
      }
      const rangeBits = [
        result.statement_start_date
          ? `from ${formatDate(result.statement_start_date)}`
          : null,
        result.statement_end_date ? `to ${formatDate(result.statement_end_date)}` : null,
      ].filter(Boolean);
      setParseInfo(
        `Parsed B = ${formatCurrency(result.bank_balance)} from ${result.movement_row_count} movement rows` +
          (rangeBits.length ? ` (${rangeBits.join(' ')})` : ''),
      );
      setParseError(null);
    },
    onError: (err) => {
      setParseError(getUserErrorMessage(err));
      setParseInfo(null);
    },
  });

  const gap = gapQuery.data;
  const tolerance = Number(gap?.gap_tolerance_amount ?? 0.01);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Verification</h2>
        <p className="page-desc">
          Bank reconcile workspace — opening balance, cutover, and Gap vs the operating
          account. Daily receipt entry stays on{' '}
          <Link to="/transactions" className="underline">
            Transactions
          </Link>
          .
        </p>
      </div>

      <BankVerificationPanel />

      <BankReconcilePanel />

      <CcReconcilePanel />

      <section className="panel p-4 sm:p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Bank Gap (read-only)
          </h3>
          <p className="mt-1 text-sm muted-text">
            Gap = Bank balance (B) − (Opening O + bank-scoped net N). Success uses{' '}
            <strong>verified-only</strong> net; all-scoped net is shown for comparison.
            Owner-paid / He-She / rental are out of N.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm sm:col-span-2">
            <span className="label-text">
              <Tooltip content="Latest row היתרה בש״ח from the bank Excel (or paste manually).">
                Bank balance B (ILS)
              </Tooltip>
            </span>
            <div className="flex flex-wrap gap-2">
              <input
                className="field min-w-[10rem] flex-1"
                type="number"
                step="0.01"
                value={bankBalanceInput}
                onChange={(e) => setBankBalanceInput(e.target.value)}
                placeholder="Upload file or paste"
              />
              <label className="btn-secondary cursor-pointer text-sm">
                {parseMutation.isPending ? 'Parsing…' : 'Upload bank Excel'}
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  disabled={parseMutation.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) parseMutation.mutate(file);
                  }}
                />
              </label>
            </div>
          </label>
          <label className="text-sm">
            <span className="label-text">
              <Tooltip content="Only include bank-scoped txs through this date. After uploading a bank Excel for Gap, defaults to the earliest movement date in the file.">
                Net through date
              </Tooltip>
            </span>
            <input
              className="field"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <div className="text-sm">
            <p className="label-text">N starts after</p>
            <p className="mt-2 font-medium tabular-nums">
              {gap?.after_date ? formatDate(gap.after_date) : 'Not set (all dates)'}
            </p>
          </div>
        </div>

        {parseInfo ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">{parseInfo}</p>
        ) : null}
        {parseError ? <p className="text-sm text-red-600">{parseError}</p> : null}

        {gapQuery.isLoading ? (
          <p className="text-sm muted-text">Computing Gap…</p>
        ) : gapQuery.isError ? (
          <p className="text-sm text-red-600">{getUserErrorMessage(gapQuery.error)}</p>
        ) : gap ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="label-text">Opening O</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {gap.opening_balance != null
                  ? formatCurrency(gap.opening_balance)
                  : 'Not set'}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="label-text">All bank-scoped net N</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCurrency(gap.all_scoped_net)}
              </p>
              <p className="text-xs muted-text">
                In {formatCurrency(gap.all_scoped_deposits)} − Out{' '}
                {formatCurrency(gap.all_scoped_expenses)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="label-text">Verified-only net N</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCurrency(gap.verified_net)}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:col-span-2 lg:col-span-3">
              <p className="label-text">
                Gap (success = verified){' '}
                {gap.within_tolerance_verified == null
                  ? ''
                  : gap.within_tolerance_verified
                    ? '· within tolerance'
                    : '· outside tolerance'}
              </p>
              <div className="mt-2 flex flex-wrap gap-6">
                <div>
                  <p className="text-xs muted-text">Verified Gap</p>
                  <p
                    className={`text-2xl font-semibold tabular-nums ${
                      gap.gap_verified == null
                        ? 'muted-text'
                        : Math.abs(Number(gap.gap_verified)) <= tolerance
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-amber-800 dark:text-amber-200'
                    }`}
                  >
                    {gap.gap_verified != null
                      ? formatCurrency(gap.gap_verified)
                      : 'Set O and B'}
                  </p>
                </div>
                <div>
                  <p className="text-xs muted-text">All-scoped Gap</p>
                  <p className="text-xl font-semibold tabular-nums">
                    {gap.gap_all_scoped != null
                      ? formatCurrency(gap.gap_all_scoped)
                      : 'Set O and B'}
                  </p>
                </div>
                <div>
                  <p className="text-xs muted-text">Tolerance</p>
                  <p className="text-xl font-semibold tabular-nums">
                    {formatCurrency(gap.gap_tolerance_amount)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
