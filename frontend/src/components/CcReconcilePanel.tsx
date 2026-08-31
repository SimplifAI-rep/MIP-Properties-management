import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CcReconcileSession } from '../types';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import { invalidateAlertData } from '../utils/invalidateQueries';

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
    onSuccess: (session) => {
      setSessionId(session.id);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('cc_session', session.id);
        return next;
      });
      setMessage(
        `CC session opened${session.card_last4 ? ` (card …${session.card_last4})` : ''} — matching paid-by-card expenses, not creating duplicates.`,
      );
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session'] });
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
      actions: Parameters<typeof api.applyCcReconcileActions>[1];
    }) => api.applyCcReconcileActions(id, actions),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      void queryClient.invalidateQueries({ queryKey: ['bank-gap'] });
      invalidateAlertData(queryClient);
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => api.completeCcReconcileSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      invalidateAlertData(queryClient);
      setMessage('CC session completed. Matched merchants are CC-verified.');
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  const session: CcReconcileSession | undefined = sessionQuery.data;
  const busy =
    createMutation.isPending || actionsMutation.isPending || completeMutation.isPending;

  const proposed = session?.lines.filter((l) => l.status === 'proposed_match') ?? [];
  const unmatchedCc = session?.lines.filter((l) => l.status === 'unmatched') ?? [];
  const unmatchedApp = session?.unmatched_app.filter((a) => a.status === 'unmatched') ?? [];

  function confirmAllProposed() {
    if (!session || proposed.length === 0) return;
    actionsMutation.mutate({
      id: session.id,
      actions: proposed.map((line) => ({
        action: 'confirm_match' as const,
        fingerprint: line.fingerprint,
        tx_id: line.proposed_tx_id || undefined,
      })),
    });
  }

  function ignoreCc(fingerprint: string) {
    if (!session) return;
    const reason = window.prompt('Reason to ignore this CC charge?');
    if (!reason?.trim()) return;
    actionsMutation.mutate({
      id: session.id,
      actions: [{ action: 'ignore_cc', fingerprint, reason: reason.trim() }],
    });
  }

  function ignoreApp(txId: string) {
    if (!session) return;
    const reason = window.prompt('Reason to ignore this paid-by-card expense?');
    if (!reason?.trim()) return;
    actionsMutation.mutate({
      id: session.id,
      actions: [{ action: 'ignore_app', tx_id: txId, reason: reason.trim() }],
    });
  }

  return (
    <section className="panel p-4 sm:p-5 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Credit card match / verify
          </h3>
          <p className="mt-1 text-sm muted-text">
            Upload a card Excel to verify <strong>paid-by-card</strong> expenses. Soft matches
            become <strong>Proposed → CC-verified</strong> — they do not create a second copy.
          </p>
        </div>
        <label className="btn-primary cursor-pointer shrink-0 text-sm">
          {createMutation.isPending ? 'Opening…' : 'Upload CC Excel to verify'}
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

      {session ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div>
              <p className="label-text">File</p>
              <p className="font-medium truncate">{session.filename || session.id}</p>
            </div>
            <div>
              <p className="label-text">Card</p>
              <p className="font-medium">
                {session.card_last4 ? `…${session.card_last4}` : '—'}
              </p>
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
              <p className="label-text">Unresolved</p>
              <p className="font-medium tabular-nums">
                CC {session.counts.unresolved_cc ?? 0} · app{' '}
                {session.counts.unresolved_app ?? 0}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy || proposed.length === 0}
              onClick={confirmAllProposed}
            >
              Confirm {proposed.length} proposed match{proposed.length === 1 ? '' : 'es'}
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy || !session.can_complete || session.status !== 'in_progress'}
              onClick={() => completeMutation.mutate(session.id)}
            >
              Complete CC session
            </button>
          </div>

          {proposed.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Proposed matches</h4>
              <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
                {proposed.map((line) => (
                  <li
                    key={line.fingerprint}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800"
                  >
                    <span>
                      {line.transaction_date ? formatDate(line.transaction_date) : '—'} ·{' '}
                      {line.merchant || '—'} · {formatCurrency(line.amount)}
                      {line.proposed_tx_ref ? (
                        <span className="muted-text"> → {line.proposed_tx_ref}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {unmatchedCc.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Unmatched CC charges</h4>
              <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
                {unmatchedCc.map((line) => (
                  <li
                    key={line.fingerprint}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800"
                  >
                    <span>
                      {line.transaction_date ? formatDate(line.transaction_date) : '—'} ·{' '}
                      {line.merchant || '—'} · {formatCurrency(line.amount)}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={() => ignoreCc(line.fingerprint)}
                    >
                      Ignore…
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {unmatchedApp.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Unmatched paid-by-card app rows</h4>
              <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
                {unmatchedApp.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800"
                  >
                    <span>
                      {row.transaction_date ? formatDate(row.transaction_date) : '—'} ·{' '}
                      {row.description || '—'} · {formatCurrency(row.amount)}
                      {row.transaction_ref ? (
                        <span className="muted-text"> · {row.transaction_ref}</span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={() => ignoreApp(row.id)}
                    >
                      Ignore…
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
