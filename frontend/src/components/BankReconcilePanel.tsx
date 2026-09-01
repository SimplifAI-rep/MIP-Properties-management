import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BankReconcileLine, BankReconcileSession } from '../types';
import {
  formatVerifyAmount,
  formatVerifyDate,
  VerifyGroupSection,
  VerifyRowTable,
} from './verifyGroups';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';

type AppPeriodStatus = 'in_excel' | 'verified' | 'not_in_excel' | 'ignored';

type AppPeriodRow = {
  key: string;
  kind: 'deposit' | 'expense';
  id: string;
  transaction_ref?: string | null;
  transaction_date: string | null;
  amount: string;
  description?: string | null;
  status: AppPeriodStatus;
  fingerprint?: string;
  bank_asmachta?: string | null;
  bank_date?: string | null;
  match_confidence?: string | null;
};

function buildAppPeriodRows(session: BankReconcileSession): AppPeriodRow[] {
  const rows: AppPeriodRow[] = [];
  const seen = new Set<string>();

  for (const line of session.lines) {
    if (!line.proposed_tx_id) continue;
    if (line.status !== 'proposed_match' && line.status !== 'matched' && line.status !== 'added') {
      continue;
    }
    if (line.proposed_kind !== 'deposit' && line.proposed_kind !== 'expense') continue;
    const key = `${line.proposed_kind}:${line.proposed_tx_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      kind: line.proposed_kind,
      id: line.proposed_tx_id,
      transaction_ref: line.proposed_tx_ref,
      transaction_date: line.transaction_date,
      amount: line.amount,
      description: line.proposed_summary || line.description,
      status: line.status === 'proposed_match' ? 'in_excel' : 'verified',
      fingerprint: line.fingerprint,
      bank_asmachta: line.asmachta,
      bank_date: line.transaction_date,
      match_confidence: line.match_confidence,
    });
  }

  for (const app of session.unmatched_app) {
    const key = `${app.kind}:${app.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      kind: app.kind,
      id: app.id,
      transaction_ref: app.transaction_ref,
      transaction_date: app.transaction_date,
      amount: app.amount,
      description: app.description,
      status: app.status === 'ignored' ? 'ignored' : 'not_in_excel',
    });
  }

  const order: Record<AppPeriodStatus, number> = {
    in_excel: 0,
    not_in_excel: 1,
    verified: 2,
    ignored: 3,
  };
  rows.sort((a, b) => {
    const byStatus = order[a.status] - order[b.status];
    if (byStatus !== 0) return byStatus;
    return (b.transaction_date || '').localeCompare(a.transaction_date || '');
  });
  return rows;
}

function statusBadge(status: AppPeriodStatus) {
  switch (status) {
    case 'in_excel':
      return <span className="badge-bank-verified">Able to verify</span>;
    case 'verified':
      return <span className="badge-bank-verified">Verified</span>;
    case 'not_in_excel':
      return <span className="badge-bank-unverified">Not in Excel</span>;
    case 'ignored':
      return <span className="badge-bank-unverified">Ignored</span>;
  }
}

function draftKindLabel(line: BankReconcileLine): string {
  if (line.side === 'credit') return 'Deposit draft';
  return 'Expense draft';
}

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
    onSuccess: (created) => {
      setSessionId(created.id);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('session', created.id);
        return next;
      });
      setMessage(
        `Period opened from ${created.filename || 'bank file'}. Review app transactions below — confirm ones found in the Excel to mark Verified.`,
      );
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session'] });
      invalidateAlertData(queryClient);
      invalidateVerificationWorkspace(queryClient);
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
      invalidateVerificationWorkspace(queryClient);
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => api.completeBankReconcileSession(id),
    onSuccess: (completed) => {
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['bank-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      invalidateAlertData(queryClient);
      invalidateVerificationWorkspace(queryClient);
      setSessionId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('session');
        return next;
      });
      setMessage(
        `Period completed and moved to history. Last verification date → ${
          completed.statement_end_date ? formatDate(completed.statement_end_date) : 'updated'
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
  const activeSession = session?.status === 'in_progress' ? session : undefined;

  useEffect(() => {
    if (!session || session.status === 'in_progress') return;
    setSessionId(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('session');
      return next;
    });
  }, [session, setSearchParams]);

  const proposed =
    activeSession?.lines.filter((l) => l.status === 'proposed_match') ?? [];
  const proposedSettlements =
    activeSession?.lines.filter((l) => l.status === 'proposed_settlement') ?? [];
  const draftFromBank =
    activeSession?.lines.filter((l) => l.status === 'unmatched') ?? [];
  const notInBankLines =
    activeSession?.lines.filter((l) =>
      ['unmatched', 'ignored', 'added'].includes(l.status),
    ) ?? [];
  const appPeriodRows = activeSession ? buildAppPeriodRows(activeSession) : [];
  const ableRows = appPeriodRows.filter(
    (r) => r.status === 'in_excel' || r.status === 'verified',
  );
  const notInExcelRows = appPeriodRows.filter(
    (r) => r.status === 'not_in_excel' || r.status === 'ignored',
  );
  const pendingConfirm = ableRows.filter((r) => r.status === 'in_excel');

  function confirmAllProposed() {
    if (!activeSession || proposed.length === 0) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: proposed.map((line) => ({
        action: 'confirm_match' as const,
        fingerprint: line.fingerprint,
        kind: (line.proposed_kind as 'deposit' | 'expense') || undefined,
        tx_id: line.proposed_tx_id || undefined,
      })),
    });
  }

  function confirmAllSettlements() {
    if (!activeSession || proposedSettlements.length === 0) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: proposedSettlements.map((line) => ({
        action: 'confirm_settlement' as const,
        fingerprint: line.fingerprint,
        member_ids: line.proposed_member_ids || undefined,
      })),
    });
  }

  function ignoreBank(fingerprint: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_bank', fingerprint }],
    });
  }

  function addFromBank(fingerprint: string) {
    if (!activeSession) return;
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
      `Create this as a new verified transaction in the app.\nChoose property number:\n${choices}`,
    );
    if (!pick?.trim()) return;
    const index = Number(pick.trim()) - 1;
    const prop = props[index];
    if (!prop) {
      setError('Invalid property selection.');
      return;
    }
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'add_from_bank', fingerprint, property_id: prop.id }],
    });
  }

  function ignoreApp(kind: 'deposit' | 'expense', txId: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_app', kind, tx_id: txId }],
    });
  }

  function confirmOne(row: AppPeriodRow) {
    if (!activeSession || !row.fingerprint) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [
        {
          action: 'confirm_match',
          fingerprint: row.fingerprint,
          kind: row.kind,
          tx_id: row.id,
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-primary cursor-pointer text-sm">
          {createMutation.isPending ? 'Opening…' : 'Upload bank Excel'}
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
        {message ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>

      {sessionQuery.isLoading && sessionId ? (
        <p className="text-sm muted-text">Loading…</p>
      ) : null}

      {activeSession ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="tabular-nums muted-text">
              {formatDate(activeSession.statement_start_date)} →{' '}
              {formatDate(activeSession.statement_end_date)}
            </span>
            <span className="tabular-nums">
              {pendingConfirm.length} able ·{' '}
              {notInExcelRows.filter((r) => r.status === 'not_in_excel').length} not in Excel ·{' '}
              {draftFromBank.length} not in bank
            </span>
            {activeSession.gap_verified != null ? (
              <span className="tabular-nums">
                Gap {formatCurrency(activeSession.gap_verified)}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy || proposed.length === 0}
              onClick={confirmAllProposed}
            >
              Confirm able ({proposed.length})
            </button>
            {proposedSettlements.length > 0 ? (
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={busy}
                onClick={confirmAllSettlements}
              >
                Confirm CC settlements ({proposedSettlements.length})
              </button>
            ) : null}
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy || !activeSession.can_complete}
              onClick={() => completeMutation.mutate(activeSession.id)}
            >
              {completeMutation.isPending ? 'Completing…' : 'Complete'}
            </button>
          </div>

          <VerifyGroupSection
            title="Able to verify"
            subtitle="App transactions found in the bank Excel — confirm to mark Verified."
            count={ableRows.length}
            tone="ok"
          >
            <VerifyRowTable
              headers={['Status', 'Date', 'Type', 'Amount', 'App transaction', 'Action']}
            >
              {ableRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">{statusBadge(row.status)}</td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(row.transaction_date)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
                      {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyAmount(row.amount)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{row.transaction_ref || row.id}</span>
                    <div className="text-xs muted-text truncate max-w-md">{row.description}</div>
                    {row.bank_asmachta ? (
                      <div className="text-xs muted-text mt-0.5">אסמכתא {row.bank_asmachta}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'in_excel' ? (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy}
                        onClick={() => confirmOne(row)}
                      >
                        Confirm → Verified
                      </button>
                    ) : (
                      <span className="text-xs muted-text">Done</span>
                    )}
                  </td>
                </tr>
              ))}
            </VerifyRowTable>
          </VerifyGroupSection>

          <VerifyGroupSection
            title="Not in Excel"
            subtitle="App transactions in this period with no matching bank Excel line."
            count={notInExcelRows.length}
            tone="warn"
          >
            <VerifyRowTable
              headers={['Status', 'Date', 'Type', 'Amount', 'App transaction', 'Action']}
            >
              {notInExcelRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">{statusBadge(row.status)}</td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(row.transaction_date)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
                      {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyAmount(row.amount)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{row.transaction_ref || row.id}</span>
                    <div className="text-xs muted-text truncate max-w-md">{row.description}</div>
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'not_in_excel' ? (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy}
                        onClick={() => ignoreApp(row.kind, row.id)}
                      >
                        Ignore
                      </button>
                    ) : (
                      <span className="text-xs muted-text">Skipped</span>
                    )}
                  </td>
                </tr>
              ))}
            </VerifyRowTable>
          </VerifyGroupSection>

          {proposedSettlements.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700">
                <h4 className="text-sm font-medium">CC settlement groups</h4>
                <p className="text-xs muted-text mt-0.5">
                  Bank Mastercard settlement debits linked to CC-verified merchant groups.
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="px-3 py-2 text-left">Settlement</th>
                    <th className="px-3 py-2 text-left">Merchant group</th>
                    <th className="px-3 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {proposedSettlements.map((line) => (
                    <tr
                      key={line.fingerprint}
                      className="border-t border-slate-200 dark:border-slate-700"
                    >
                      <td className="px-3 py-2">
                        {formatVerifyDate(line.transaction_date)} · −
                        {formatCurrency(line.amount)}
                        {line.asmachta ? ` · אסמכתא ${line.asmachta}` : ''}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-xs muted-text">{line.proposed_summary}</div>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() =>
                            actionsMutation.mutate({
                              id: activeSession.id,
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

          <VerifyGroupSection
            title="Not in bank"
            subtitle="Bank Excel movements with no matching app transaction — create a draft in the app or ignore."
            count={notInBankLines.length}
            tone="warn"
          >
            <VerifyRowTable headers={['Draft', 'Date', 'Amount', 'Details', 'Action']}>
              {notInBankLines.map((line) => (
                <tr
                  key={line.fingerprint}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">
                    <span className={line.side === 'credit' ? 'badge-deposit' : 'badge-expense'}>
                      {draftKindLabel(line)}
                    </span>
                    {line.status === 'added' ? (
                      <span className="badge-bank-verified ml-1">Created</span>
                    ) : null}
                    {line.status === 'ignored' ? (
                      <span className="badge-bank-unverified ml-1">Ignored</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(line.transaction_date)}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyAmount(line.amount, line.side)}
                  </td>
                  <td className="px-3 py-2">
                    {line.asmachta ? (
                      <div className="text-xs font-mono">אסמכתא {line.asmachta}</div>
                    ) : null}
                    <div className="text-xs muted-text truncate max-w-md">{line.description}</div>
                    {line.proposed_tx_ref ? (
                      <div className="text-xs muted-text">→ {line.proposed_tx_ref}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {line.status === 'unmatched' ? (
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="btn-primary text-xs"
                          disabled={busy || propertiesQuery.isLoading}
                          onClick={() => addFromBank(line.fingerprint)}
                        >
                          Create transaction…
                        </button>
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() => ignoreBank(line.fingerprint)}
                        >
                          Ignore
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs muted-text">
                        {line.status === 'added' ? 'Created' : 'Skipped'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </VerifyRowTable>
          </VerifyGroupSection>
        </>
      ) : null}
    </div>
  );
}
