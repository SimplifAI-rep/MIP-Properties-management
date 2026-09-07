import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CcReconcileSession } from '../types';
import { TransactionTable } from './TransactionTable';
import { VerifyGroupSection } from './verifyGroups';
import { formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';
import { ccDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

export function CcReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('cc_session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCardLast4, setSelectedCardLast4] = useState<string>('');

  // Follow URL only when the URL itself changes. Do not depend on sessionId —
  // otherwise a card switch optimistically updates state while the URL is still
  // stale and this effect snaps back to the previous session.
  const urlSessionId = searchParams.get('cc_session');
  useEffect(() => {
    setSessionId(urlSessionId);
  }, [urlSessionId]);

  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const creditCards = workspaceQuery.data?.credit_cards ?? [];

  const sessionQuery = useQuery({
    queryKey: ['cc-reconcile-session', sessionId],
    queryFn: () => api.getCcReconcileSession(sessionId!),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    if (selectedCardLast4 || creditCards.length === 0) return;
    const withOpen = creditCards.find((c) => c.open_session_id);
    setSelectedCardLast4((withOpen ?? creditCards[0]).card_last4);
  }, [creditCards, selectedCardLast4]);

  // Sync dropdown from the loaded session only when that session matches selection.
  useEffect(() => {
    const loaded = sessionQuery.data;
    if (!loaded || !sessionId || loaded.id !== sessionId) return;
    const last4 = loaded.card_last4;
    if (last4 && last4 !== selectedCardLast4) {
      setSelectedCardLast4(last4);
    }
  }, [sessionQuery.data, sessionId, selectedCardLast4]);

  function selectCard(last4: string) {
    setSelectedCardLast4(last4);
    if (last4 === '__new__') {
      setSessionId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('cc_session');
        return next;
      });
      setMessage(null);
      setError(null);
      return;
    }
    const card = creditCards.find((c) => c.card_last4 === last4);
    const nextSession = card?.open_session_id ?? null;
    setSessionId(nextSession);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextSession) next.set('cc_session', nextSession);
      else next.delete('cc_session');
      return next;
    });
    setMessage(null);
    setError(null);
  }

  const createMutation = useMutation({
    mutationFn: api.createCcReconcileSession,
    onSuccess: (created) => {
      setSessionId(created.id);
      if (created.card_last4) setSelectedCardLast4(created.card_last4);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('cc_session', created.id);
        return next;
      });
      setMessage('Statement opened. Check the lists below.');
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
        `Period finished${
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
    queryFn: () => api.getProperties(),
  });

  const session: CcReconcileSession | undefined =
    sessionId && sessionQuery.data?.id === sessionId ? sessionQuery.data : undefined;
  const busy =
    createMutation.isPending || actionsMutation.isPending || completeMutation.isPending;
  const activeSession = session?.status === 'in_progress' ? session : undefined;
  const selectedHasOpenSession = Boolean(
    creditCards.find((c) => c.card_last4 === selectedCardLast4)?.open_session_id,
  );

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
  // Only unresolved statement lines stay here; Create moves them into Matched (able_txs).
  const notInBankLines =
    activeSession?.lines.filter((l) => l.status === 'unmatched') ?? [];
  const fingerprintByTxId = new Map<string, string>();
  for (const line of activeSession?.lines ?? []) {
    if (
      line.proposed_tx_id &&
      (line.status === 'proposed_match' || line.status === 'matched' || line.status === 'added')
    ) {
      fingerprintByTxId.set(line.proposed_tx_id, line.fingerprint);
    }
  }
  const ignoredAppIds = new Set(
    (activeSession?.unmatched_app ?? [])
      .filter((r) => r.status === 'ignored')
      .map((r) => r.id),
  );
  const proposedTxIds = new Set(
    proposed.map((l) => l.proposed_tx_id).filter(Boolean) as string[],
  );

  const ableTxs: UnifiedTransaction[] = txsFromApi(
    activeSession?.able_txs as Record<string, unknown>[] | undefined,
  );
  const notInExcelTxs: UnifiedTransaction[] = txsFromApi(
    activeSession?.not_in_excel_txs as Record<string, unknown>[] | undefined,
  );
  const draftTxs: UnifiedTransaction[] = notInBankLines.map(ccDraftToUnified);

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

  function bufferPropertyId(): string | null {
    const props = propertiesQuery.data ?? [];
    if (props.length === 0) {
      setError('No properties available to attach a new transaction.');
      return null;
    }
    const buffer = props.find((p) => p.client_prop_id === 'BUFFER');
    return (buffer ?? props[0]).id;
  }

  function ignoreCc(fingerprint: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_cc', fingerprint }],
    });
  }

  function ignoreAllCc() {
    if (!activeSession || notInBankLines.length === 0) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: notInBankLines.map((line) => ({
        action: 'ignore_cc' as const,
        fingerprint: line.fingerprint,
      })),
    });
  }

  function addFromCc(fingerprint: string) {
    if (!activeSession) return;
    const propertyId = bufferPropertyId();
    if (!propertyId) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'add_from_cc', fingerprint, property_id: propertyId }],
    });
  }

  function createAllFromCc() {
    if (!activeSession || notInBankLines.length === 0) return;
    const propertyId = bufferPropertyId();
    if (!propertyId) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: notInBankLines.map((line) => ({
        action: 'add_from_cc' as const,
        fingerprint: line.fingerprint,
        property_id: propertyId,
      })),
    });
  }

  function ignoreApp(txId: string) {
    if (!activeSession) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [{ action: 'ignore_app', tx_id: txId }],
    });
  }

  function ignoreAllApp() {
    if (!activeSession) return;
    const pending = notInExcelTxs.filter((tx) => !ignoredAppIds.has(tx.id));
    if (pending.length === 0) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: pending.map((tx) => ({
        action: 'ignore_app' as const,
        tx_id: tx.id,
      })),
    });
  }

  function confirmOne(tx: UnifiedTransaction) {
    if (!activeSession) return;
    const fingerprint = fingerprintByTxId.get(tx.id);
    if (!fingerprint) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [
        {
          action: 'confirm_match',
          fingerprint,
          tx_id: tx.id,
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      {!activeSession && !sessionQuery.isLoading ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-4 py-4 dark:border-slate-600 space-y-3">
          <p className="text-sm font-medium">How to check a card period</p>
          <ol className="list-decimal pl-5 text-sm muted-text space-y-1">
            <li>Choose the Excel file from the card</li>
            <li>Review the lists below</li>
            <li>Finish the period</li>
          </ol>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {creditCards.length > 1 || selectedCardLast4 === '__new__' ? (
          <label className="text-sm flex items-center gap-2 min-w-0">
            <span className="label-text shrink-0">Card</span>
            <select
              className="field py-1 text-sm min-w-[12rem] max-w-full"
              value={selectedCardLast4}
              disabled={busy}
              onChange={(e) => selectCard(e.target.value)}
            >
              {creditCards.length === 0 ? (
                <option value="">From statement</option>
              ) : (
                <>
                  {creditCards.map((card) => (
                    <option key={card.card_last4} value={card.card_last4}>
                      {card.label}
                      {card.open_session_id ? ' · in progress' : ''}
                    </option>
                  ))}
                  <option value="__new__">New card…</option>
                </>
              )}
            </select>
          </label>
        ) : null}
        <label className="btn-primary cursor-pointer text-sm">
          {createMutation.isPending ? 'Uploading…' : 'Upload card statement'}
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            disabled={
              busy ||
              Boolean(activeSession) ||
              (selectedCardLast4 !== '__new__' &&
                selectedCardLast4 !== '' &&
                selectedHasOpenSession)
            }
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) createMutation.mutate(file);
            }}
          />
        </label>
        {creditCards.length === 1 ? (
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy || Boolean(activeSession)}
            onClick={() => selectCard('__new__')}
          >
            Another card
          </button>
        ) : null}
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
          <p className="text-sm font-medium">Check the lists</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="tabular-nums muted-text">
              {formatDate(activeSession.statement_start_date)} →{' '}
              {formatDate(activeSession.statement_end_date)}
              {activeSession.card_last4 ? ` · ••${activeSession.card_last4}` : ''}
            </span>
            {proposed.length > 0 ? (
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={busy}
                onClick={confirmAllProposed}
              >
                Confirm all found ({proposed.length})
              </button>
            ) : null}
            {notInBankLines.length > 0 ? (
              <>
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  disabled={busy || propertiesQuery.isLoading}
                  onClick={createAllFromCc}
                >
                  Create remaining ({notInBankLines.length})
                </button>
                <button
                  type="button"
                  className="btn-secondary text-sm"
                  disabled={busy}
                  onClick={ignoreAllCc}
                >
                  Ignore remaining ({notInBankLines.length})
                </button>
              </>
            ) : null}
            {notInExcelTxs.some((tx) => !ignoredAppIds.has(tx.id)) ? (
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={busy}
                onClick={ignoreAllApp}
              >
                Ignore remaining missing (
                {notInExcelTxs.filter((tx) => !ignoredAppIds.has(tx.id)).length})
              </button>
            ) : null}
            <button
              type="button"
              className={
                activeSession.can_complete ? 'btn-primary text-sm' : 'btn-secondary text-sm'
              }
              disabled={busy || !activeSession.can_complete}
              onClick={() => completeMutation.mutate(activeSession.id)}
            >
              {completeMutation.isPending ? 'Finishing…' : 'Finish period'}
            </button>
          </div>
          {!activeSession.can_complete ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Still{' '}
              {proposed.length +
                notInBankLines.length +
                notInExcelTxs.filter((tx) => !ignoredAppIds.has(tx.id)).length}{' '}
              items to handle
            </p>
          ) : null}

          <VerifyGroupSection
            title="Found on statement"
            subtitle="Confirm these"
            count={ableTxs.length}
            tone="ok"
            hideWhenEmpty
          >
            <TransactionTable
              rows={ableTxs}
              emptyMessage="None."
              renderActions={(row) =>
                proposedTxIds.has(row.id) ? (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmOne(row);
                    }}
                  >
                    Confirm
                  </button>
                ) : (
                  <span className="text-xs muted-text">Checked</span>
                )
              }
            />
          </VerifyGroupSection>

          <VerifyGroupSection
            title="In the app, not on the statement"
            subtitle="Ignore if OK"
            count={notInExcelTxs.length}
            tone="warn"
            hideWhenEmpty
          >
            <TransactionTable
              rows={notInExcelTxs}
              emptyMessage="None."
              renderActions={(row) =>
                ignoredAppIds.has(row.id) ? (
                  <span className="text-xs muted-text">Ignored</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      ignoreApp(row.id);
                    }}
                  >
                    Ignore
                  </button>
                )
              }
            />
          </VerifyGroupSection>

          <VerifyGroupSection
            title="On the statement, not in the app"
            subtitle="Create or Ignore"
            count={draftTxs.length}
            tone="warn"
            hideWhenEmpty
          >
            <TransactionTable
              rows={draftTxs}
              emptyMessage="None."
              renderActions={(row) => {
                const line = notInBankLines.find((l) => l.fingerprint === row.id);
                if (!line) return null;
                return (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      disabled={busy || propertiesQuery.isLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        addFromCc(line.fingerprint);
                      }}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        ignoreCc(line.fingerprint);
                      }}
                    >
                      Ignore
                    </button>
                  </div>
                );
              }}
            />
          </VerifyGroupSection>
        </>
      ) : null}
    </div>
  );
}
