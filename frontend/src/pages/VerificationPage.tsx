import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { BankVerificationPanel } from '../components/BankVerificationPanel';
import { VerificationWorkspace } from '../components/VerificationWorkspace';
import { formatCurrency, formatDate } from '../components/ui/States';
import { getUserErrorMessage } from '../utils/errors';

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="label-text truncate">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums truncate" title={hint || value}>
        {value}
      </p>
    </div>
  );
}

export function VerificationPage() {
  const queryClient = useQueryClient();
  const [bankBalanceInput, setBankBalanceInput] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: api.getBankSettings,
  });

  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: api.getVerificationWorkspace,
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
      if (result.statement_start_date) {
        setDateTo(result.statement_start_date);
      }
      setParseError(null);
    },
    onError: (err) => setParseError(getUserErrorMessage(err)),
  });

  const settings = settingsQuery.data;
  const gap = gapQuery.data;
  const workspace = workspaceQuery.data;
  const tolerance = Number(gap?.gap_tolerance_amount ?? settings?.gap_tolerance_amount ?? 0.01);
  const gapOk =
    gap?.gap_verified != null ? Math.abs(Number(gap.gap_verified)) <= tolerance : null;

  return (
    <div className="space-y-4">
      <h2 className="page-heading">Verification</h2>

      <section className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <Stat
            label="Opening O"
            value={
              settings?.opening_balance != null
                ? formatCurrency(settings.opening_balance)
                : '—'
            }
            hint={
              settings?.opening_balance_as_of
                ? `as of ${formatDate(settings.opening_balance_as_of)}`
                : undefined
            }
          />
          <Stat
            label="Bank verified through"
            value={
              settings?.last_verification_date
                ? formatDate(settings.last_verification_date)
                : '—'
            }
          />
          <Stat
            label="CC verified through"
            value={
              workspace?.last_cc_verification_date
                ? formatDate(workspace.last_cc_verification_date)
                : '—'
            }
          />
          <div className="min-w-0">
            <p className="label-text">Bank balance B</p>
            <div className="mt-0.5 flex gap-1">
              <input
                type="number"
                step="0.01"
                className="field py-1 text-sm tabular-nums"
                value={bankBalanceInput}
                onChange={(e) => setBankBalanceInput(e.target.value)}
                placeholder="—"
              />
              <label className="btn-secondary cursor-pointer shrink-0 text-xs self-stretch flex items-center px-2">
                {parseMutation.isPending ? '…' : 'Excel'}
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
            {parseError ? <p className="text-xs text-red-600 mt-0.5">{parseError}</p> : null}
          </div>
          <Stat
            label="Verified Gap"
            value={
              gap?.gap_verified != null ? formatCurrency(gap.gap_verified) : '—'
            }
            hint={
              gapOk == null ? undefined : gapOk ? 'within tolerance' : 'outside tolerance'
            }
          />
          <Stat
            label="Pending"
            value={`${settings?.unverified_count ?? '—'} bank · ${workspace?.cc_pool.pending_count ?? '—'} CC`}
          />
        </div>
        {dateTo ? (
          <p className="text-xs muted-text mt-2">
            Gap net through {formatDate(dateTo)}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setDateTo('')}
            >
              clear
            </button>
          </p>
        ) : null}
      </section>

      <details className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-900/40">
          Setup
        </summary>
        <div className="border-t border-slate-200 dark:border-slate-700">
          <BankVerificationPanel />
        </div>
      </details>

      <VerificationWorkspace
        bankBalanceInput={bankBalanceInput}
        setBankBalanceInput={setBankBalanceInput}
        dateTo={dateTo}
        setDateTo={setDateTo}
      />
    </div>
  );
}
