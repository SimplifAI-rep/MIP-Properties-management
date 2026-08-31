import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BankReconcileSession } from '../types';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import { invalidateAlertData } from '../utils/invalidateQueries';

export function BankReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = searchParams.get('session');
    if (fromUrl && fromUrl !== sessionId) {
      setSessionId(fromUrl);
    }
  }, [searchParams, sessionId]);

  const sessionQuery = useQuery({
    queryKey: ['bank-reconcile-session', sessionId],
    queryFn: () => api.getBankReconcileSession(sessionId!),
    enabled: Boolean(sessionId),
  });

  const createMutation = useMutation({
    mutationFn: api.createBankReconcileSession,
    onSuccess: (session) => {
      setSessionId(session.id);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('session', session.id);
        return next;
      });
      setMessage(
        `Reconcile session opened from ${session.filename || 'bank file'} — proposed matches are ready to confirm (not duplicates).`,
      );
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session'] });
      invalidateAlertData(queryClient);
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const actionsMutation = useMutation({
    mutationFn: ({
      id,
      actions,
    }: {
      id: string;
      actions: Parameters<typeof api.applyBankReconcileActions>[1];
    }) => api.applyBankReconcileActions(id, actions),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['bank-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      invalidateAlertData(queryClient);
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => api.completeBankReconcileSession(id),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['bank-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      invalidateAlertData(queryClient);
      setMessage(
        `Session completed. Last verification date → ${
          session.statement_end_date ? formatDate(session.statement_end_date) : 'updated'
        }.`,
      );
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const session: BankReconcileSession | undefined = sessionQuery.data;
  const busy =
    createMutation.isPending || actionsMutation.isPending || completeMutation.isPending;

  const proposed = session?.lines.filter((l) => l.status === 'proposed_match') ?? [];
  const proposedSettlements =
    session?.lines.filter((l) => l.status === 'proposed_settlement') ?? [];
  const unmatchedBank = session?.lines.filter((l) => l.status === 'unmatched') ?? [];
  const unmatchedApp = session?.unmatched_app.filter((a) => a.status === 'unmatched') ?? [];

  function confirmAllProposed() {
    if (!session || proposed.length === 0) return;
    actionsMutation.mutate({
      id: session.id,
      actions: proposed.map((line) => ({
        action: 'confirm_match' as const,
        fingerprint: line.fingerprint,
        kind: (line.proposed_kind as 'deposit' | 'expense') || undefined,
        tx_id: line.proposed_tx_id || undefined,
      })),
    });
  }

  function confirmAllSettlements() {
    if (!session || proposedSettlements.length === 0) return;
    actionsMutation.mutate({
      id: session.id,
      actions: proposedSettlements.map((line) => ({
        action: 'confirm_settlement' as const,
        fingerprint: line.fingerprint,
        member_ids: line.proposed_member_ids || undefined,
      })),
    });
  }

  function ignoreBank(fingerprint: string) {
    if (!session) return;
    const reason = window.prompt('Reason to ignore this bank line?');
    if (!reason?.trim()) return;
    actionsMutation.mutate({
      id: session.id,
      actions: [{ action: 'ignore_bank', fingerprint, reason: reason.trim() }],
    });
  }

  function addFromBank(fingerprint: string) {
    if (!session) return;
    const props = propertiesQuery.data ?? [];
    if (props.length === 0) {
      setError('No properties available to attach a new transaction.');
      return;
    }
    const choices = props
      .slice(0, 20)
      .map((p, i) => `${i + 1}. ${p.client_prop_id} — ${p.name}`)
      .join('\n');
    const pick = window.prompt(
      `Add missing from bank as a new verified transaction.\nChoose property number:\n${choices}`,
    );
    if (!pick?.trim()) return;
    const index = Number(pick.trim()) - 1;
    const prop = props[index];
    if (!prop) {
      setError('Invalid property selection.');
      return;
    }
    actionsMutation.mutate({
      id: session.id,
      actions: [{ action: 'add_from_bank', fingerprint, property_id: prop.id }],
    });
  }

  function ignoreApp(kind: 'deposit' | 'expense', txId: string) {
    if (!session) return;
    const reason = window.prompt('Reason to ignore this app transaction?');
    if (!reason?.trim()) return;
    actionsMutation.mutate({
      id: session.id,
      actions: [{ action: 'ignore_app', kind, tx_id: txId, reason: reason.trim() }],
    });
  }

  return (
    <section className="panel p-4 sm:p-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Bank match / verify
          </h3>
          <p className="mt-1 text-sm muted-text">
            Upload the bank Excel as ground truth. Soft matches become{' '}
            <strong>Proposed match → Verified</strong>, not duplicates. Confirming attaches
            bank אסמכתא and does not create a second copy.
          </p>
        </div>
        <label className="btn-primary cursor-pointer shrink-0 text-sm">
          {createMutation.isPending ? 'Opening…' : 'Upload bank Excel to verify'}
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) createMutation.mutate(file);
            }}
          />
        </label>
      </div>

      {message ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {sessionQuery.isLoading && sessionId ? (
        <p className="text-sm muted-text">Loading session…</p>
      ) : null}

      {session ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div>
              <p className="label-text">File</p>
              <p className="font-medium truncate">{session.filename || session.id}</p>
            </div>
            <div>
              <p className="label-text">Period</p>
              <p className="font-medium tabular-nums">
                {session.statement_start_date
                  ? formatDate(session.statement_start_date)
                  : '—'}{' '}
                →{' '}
                {session.statement_end_date ? formatDate(session.statement_end_date) : '—'}
              </p>
            </div>
            <div>
              <p className="label-text">Verified Gap</p>
              <p className="font-medium tabular-nums">
                {session.gap_verified != null
                  ? formatCurrency(session.gap_verified)
                  : 'Set opening balance'}
              </p>
            </div>
            <div>
              <p className="label-text">Unresolved</p>
              <p className="font-medium tabular-nums">
                bank {session.counts.unresolved_bank ?? 0} · app{' '}
                {session.counts.unresolved_app ?? 0}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy || proposed.length === 0 || session.status !== 'in_progress'}
              onClick={confirmAllProposed}
            >
              Confirm all proposed matches ({proposed.length})
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={
                busy || proposedSettlements.length === 0 || session.status !== 'in_progress'
              }
              onClick={confirmAllSettlements}
            >
              Confirm CC settlements ({proposedSettlements.length})
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy || !session.can_complete || session.status !== 'in_progress'}
              onClick={() => completeMutation.mutate(session.id)}
            >
              {completeMutation.isPending ? 'Completing…' : 'Complete session'}
            </button>
          </div>
          {!session.can_complete && session.status === 'in_progress' ? (
            <p className="text-xs muted-text">
              Complete stays disabled until every bank line and bank-scoped app row is
              matched, settled, added, or ignored with a reason, and Gap is within tolerance
              (when O and B are set). CC settlements confirm a merchant date group — they do
              not create duplicate expenses.
            </p>
          ) : null}

          {proposedSettlements.length > 0 ? (
            <div className="overflow-x-auto">
              <h4 className="text-sm font-medium mb-2">Proposed CC settlements</h4>
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-2 py-2 text-left">Bank settlement</th>
                    <th className="px-2 py-2 text-left">CC-verified group</th>
                    <th className="px-2 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {proposedSettlements.map((line) => (
                    <tr
                      key={line.fingerprint}
                      className="border-t border-slate-200 dark:border-slate-700"
                    >
                      <td className="px-2 py-2">
                        {line.transaction_date ? formatDate(line.transaction_date) : '—'} · −
                        {formatCurrency(line.amount)}
                        {line.asmachta ? ` · אסמכתא ${line.asmachta}` : ''}
                        <div className="text-xs muted-text truncate max-w-xs">
                          {line.description}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="text-xs muted-text">{line.proposed_summary}</div>
                        {line.proposed_window_start && line.proposed_window_end ? (
                          <div className="text-xs muted-text">
                            Window {formatDate(line.proposed_window_start)} →{' '}
                            {formatDate(line.proposed_window_end)}
                          </div>
                        ) : null}
                        {line.proposed_group_total != null ? (
                          <div className="text-xs tabular-nums">
                            Group total {formatCurrency(line.proposed_group_total)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() =>
                            actionsMutation.mutate({
                              id: session.id,
                              actions: [
                                {
                                  action: 'confirm_settlement',
                                  fingerprint: line.fingerprint,
                                  member_ids: line.proposed_member_ids || undefined,
                                },
                              ],
                            })
                          }
                        >
                          Confirm group
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {proposed.length > 0 ? (
            <div className="overflow-x-auto">
              <h4 className="text-sm font-medium mb-2">Proposed matches</h4>
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-2 py-2 text-left">Bank</th>
                    <th className="px-2 py-2 text-left">App match</th>
                    <th className="px-2 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {proposed.slice(0, 50).map((line) => (
                    <tr key={line.fingerprint} className="border-t border-slate-200 dark:border-slate-700">
                      <td className="px-2 py-2">
                        {line.transaction_date ? formatDate(line.transaction_date) : '—'} ·{' '}
                        {line.side === 'credit' ? '+' : '−'}
                        {formatCurrency(line.amount)}
                        {line.asmachta ? ` · אסמכתא ${line.asmachta}` : ''}
                        <div className="text-xs muted-text truncate max-w-xs">
                          {line.description}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <span className="font-mono text-xs">{line.proposed_tx_ref}</span>
                        <div className="text-xs muted-text">{line.proposed_summary}</div>
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() =>
                            actionsMutation.mutate({
                              id: session.id,
                              actions: [
                                {
                                  action: 'confirm_match',
                                  fingerprint: line.fingerprint,
                                  kind: (line.proposed_kind as 'deposit' | 'expense') || undefined,
                                  tx_id: line.proposed_tx_id || undefined,
                                },
                              ],
                            })
                          }
                        >
                          Confirm → Verified
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {proposed.length > 50 ? (
                <p className="text-xs muted-text mt-1">Showing 50 of {proposed.length}</p>
              ) : null}
            </div>
          ) : null}

          {unmatchedBank.length > 0 ? (
            <div className="overflow-x-auto">
              <h4 className="text-sm font-medium mb-2">
                Unmatched bank lines ({unmatchedBank.length})
              </h4>
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-2 py-2 text-left">Line</th>
                    <th className="px-2 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedBank.slice(0, 30).map((line) => (
                    <tr key={line.fingerprint} className="border-t border-slate-200 dark:border-slate-700">
                      <td className="px-2 py-2">
                        {line.transaction_date ? formatDate(line.transaction_date) : '—'} ·{' '}
                        {line.side === 'credit' ? '+' : '−'}
                        {formatCurrency(line.amount)}
                        <div className="text-xs muted-text truncate max-w-md">
                          {line.description}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            disabled={busy || propertiesQuery.isLoading}
                            onClick={() => addFromBank(line.fingerprint)}
                          >
                            Add missing…
                          </button>
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            disabled={busy}
                            onClick={() => ignoreBank(line.fingerprint)}
                          >
                            Ignore…
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {unmatchedApp.length > 0 ? (
            <div className="overflow-x-auto">
              <h4 className="text-sm font-medium mb-2">
                Unmatched app transactions ({unmatchedApp.length})
              </h4>
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-2 py-2 text-left">Transaction</th>
                    <th className="px-2 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedApp.slice(0, 30).map((row) => (
                    <tr
                      key={`${row.kind}:${row.id}`}
                      className="border-t border-slate-200 dark:border-slate-700"
                    >
                      <td className="px-2 py-2">
                        <span className="font-mono text-xs">{row.transaction_ref}</span> ·{' '}
                        {row.kind} ·{' '}
                        {row.transaction_date ? formatDate(row.transaction_date) : '—'} ·{' '}
                        {formatCurrency(row.amount)}
                        <div className="text-xs muted-text truncate max-w-md">
                          {row.description}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() => ignoreApp(row.kind, row.id)}
                        >
                          Ignore…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
