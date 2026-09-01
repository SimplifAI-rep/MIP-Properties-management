import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CcReconcileLine, CcReconcileSession } from '../types';
import {
  formatVerifyAmount,
  formatVerifyDate,
  VerifyGroupSection,
  VerifyRowTable,
} from './verifyGroups';
import { formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';

type AppCcStatus = 'able' | 'verified' | 'not_in_excel' | 'ignored';

type AppCcRow = {
  key: string;
  id: string;
  transaction_ref?: string | null;
  transaction_date: string | null;
  amount: string;
  description?: string | null;
  status: AppCcStatus;
  fingerprint?: string;
  merchant?: string | null;
};

function buildCcAppRows(session: CcReconcileSession): AppCcRow[] {
  const rows: AppCcRow[] = [];
  const seen = new Set<string>();

  for (const line of session.lines) {
    if (!line.proposed_tx_id) continue;
    if (line.status !== 'proposed_match' && line.status !== 'matched' && line.status !== 'added') {
      continue;
    }
    const key = `expense:${line.proposed_tx_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      id: line.proposed_tx_id,
      transaction_ref: line.proposed_tx_ref,
      transaction_date: line.transaction_date,
      amount: line.amount,
      description: line.proposed_summary || line.merchant || line.details,
      status: line.status === 'proposed_match' ? 'able' : 'verified',
      fingerprint: line.fingerprint,
      merchant: line.merchant,
    });
  }

  for (const app of session.unmatched_app) {
    const key = `expense:${app.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      id: app.id,
      transaction_ref: app.transaction_ref,
      transaction_date: app.transaction_date,
      amount: app.amount,
      description: app.description,
      status: app.status === 'ignored' ? 'ignored' : 'not_in_excel',
    });
  }

  const order: Record<AppCcStatus, number> = {
    able: 0,
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

function ccStatusBadge(status: AppCcStatus) {
  switch (status) {
    case 'able':
      return <span className="badge-cc-verified">Able to verify</span>;
    case 'verified':
      return <span className="badge-cc-verified">CC-verified</span>;
    case 'not_in_excel':
      return <span className="badge-cc-pending">Not in Excel</span>;
    case 'ignored':
      return <span className="badge-bank-unverified">Ignored</span>;
  }
}

export function CcReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('cc_session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromUrl = searchParams.get('cc_session');
    if (fromUrl && fromUrl !== sessionId) {
      setSessionId(fromUrl);
    }
  }, [searchParams, sessionId]);

  const sessionQuery = useQuery({
    queryKey: ['cc-reconcile-session', sessionId],
    queryFn: () => api.getCcReconcileSession(sessionId!),
    enabled: Boolean(sessionId),
  });

  const createMutation = useMutation({
    mutationFn: api.createCcReconcileSession,
    onSuccess: (created) => {
      setSessionId(created.id);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('cc_session', created.id);
        return next;
      });
      setMessage(
        `CC period opened${created.card_last4 ? ` (card …${created.card_last4})` : ''}. Review unpaid-by-card app rows in the three groups.`,
      );
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session'] });
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
      actions: Parameters<typeof api.applyCcReconcileActions>[1];
    }) => api.applyCcReconcileActions(id, actions),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      invalidateAlertData(queryClient);
      invalidateVerificationWorkspace(queryClient);
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => api.completeCcReconcileSession(id),
    onSuccess: (completed) => {
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      invalidateAlertData(queryClient);
      invalidateVerificationWorkspace(queryClient);
      setSessionId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('cc_session');
        return next;
      });
      setMessage(
        `CC period completed and moved to history${
          completed.statement_end_date
            ? ` through ${formatDate(completed.statement_end_date)}`
            : ''
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

  const session: CcReconcileSession | undefined = sessionQuery.data;
  const busy =
    createMutation.isPending || actionsMutation.isPending || completeMutation.isPending;
  const activeSession = session?.status === 'in_progress' ? session : undefined;

  useEffect(() => {
    if (!session || session.status === 'in_progress') return;
    setSessionId(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('cc_session');
      return next;
    });
  }, [session, setSearchParams]);

  const proposed =
    activeSession?.lines.filter((l) => l.status === 'proposed_match') ?? [];
  const notInBankLines =
    activeSession?.lines.filter((l) =>
      ['unmatched', 'ignored', 'added'].includes(l.status),
    ) ?? [];
  const appRows = activeSession ? buildCcAppRows(activeSession) : [];
  const ableRows = appRows.filter((r) => r.status === 'able' || r.status === 'verified');
  const notInExcelRows = appRows.filter(
    (r) => r.status === 'not_in_excel' || r.status === 'ignored',
  );
  const pendingAble = ableRows.filter((r) => r.status === 'able');
  const pendingNotExcel = notInExcelRows.filter((r) => r.status === 'not_in_excel');
  const pendingNotBank = notInBankLines.filter((l) => l.status === 'unmatched');

  function confirmAllProposed() {
    if (!activeSession || proposed.length === 0) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: proposed.map((line) => ({
        action: 'confirm_match' as const,
        fingerprint: line.fingerprint,
        tx_id: line.proposed_tx_id || undefined,
      })),
    });
  }

  function ignoreCc(fingerprint: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_cc', fingerprint }],
    });
  }

  function addFromCc(fingerprint: string) {
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
      `Create this CC Excel charge as a new CC-verified expense.\nChoose property number:\n${choices}`,
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
      actions: [{ action: 'add_from_cc', fingerprint, property_id: prop.id }],
    });
  }

  function ignoreApp(txId: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_app', tx_id: txId }],
    });
  }

  function confirmOne(row: AppCcRow) {
    if (!activeSession || !row.fingerprint) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [
        {
          action: 'confirm_match',
          fingerprint: row.fingerprint,
          tx_id: row.id,
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-primary cursor-pointer text-sm">
          {createMutation.isPending ? 'Opening…' : 'Upload CC Excel'}
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
              {formatVerifyDate(activeSession.statement_start_date)} →{' '}
              {formatVerifyDate(activeSession.statement_end_date)}
              {activeSession.card_last4 ? ` · …${activeSession.card_last4}` : ''}
            </span>
            <span className="tabular-nums">
              {pendingAble.length} able · {pendingNotExcel.length} not in Excel ·{' '}
              {pendingNotBank.length} not in bank
            </span>
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
            subtitle="Paid-by-card app expenses found in the CC Excel — confirm to mark CC-verified."
            count={ableRows.length}
            tone="ok"
          >
            <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction', 'Action']}>
              {ableRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">{ccStatusBadge(row.status)}</td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(row.transaction_date)}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyAmount(row.amount)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{row.transaction_ref || row.id}</span>
                    <div className="text-xs muted-text truncate max-w-md">{row.description}</div>
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'able' ? (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy}
                        onClick={() => confirmOne(row)}
                      >
                        Confirm → CC-verified
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
            subtitle="Unverified paid-by-card expenses in this period with no matching CC Excel charge."
            count={notInExcelRows.length}
            tone="warn"
          >
            <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction', 'Action']}>
              {notInExcelRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">{ccStatusBadge(row.status)}</td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(row.transaction_date)}
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
                        onClick={() => ignoreApp(row.id)}
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

          <VerifyGroupSection
            title="Not in bank"
            subtitle="CC Excel charges with no matching paid-by-card expense — create or ignore."
            count={notInBankLines.length}
            tone="warn"
          >
            <VerifyRowTable headers={['Draft', 'Date', 'Amount', 'Details', 'Action']}>
              {notInBankLines.map((line: CcReconcileLine) => (
                <tr
                  key={line.fingerprint}
                  className="border-t border-slate-200 dark:border-slate-700 align-top"
                >
                  <td className="px-3 py-2">
                    <span className="badge-expense">Expense draft</span>
                    {line.status === 'added' ? (
                      <span className="badge-cc-verified ml-1">Created</span>
                    ) : null}
                    {line.status === 'ignored' ? (
                      <span className="badge-bank-unverified ml-1">Ignored</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyDate(line.transaction_date)}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {formatVerifyAmount(line.amount)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-xs truncate max-w-md">{line.merchant || '—'}</div>
                    <div className="text-xs muted-text truncate max-w-md">{line.details}</div>
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
                          onClick={() => addFromCc(line.fingerprint)}
                        >
                          Create transaction…
                        </button>
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() => ignoreCc(line.fingerprint)}
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
