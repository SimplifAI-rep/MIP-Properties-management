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

  useEffect(() => {
    const fromUrl = searchParams.get('cc_session');
    if (fromUrl && fromUrl !== sessionId) {
      setSessionId(fromUrl);
    }
  }, [searchParams, sessionId]);

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

  useEffect(() => {
    const last4 = sessionQuery.data?.card_last4;
    if (last4 && last4 !== selectedCardLast4) {
      setSelectedCardLast4(last4);
    }
  }, [sessionQuery.data?.card_last4, selectedCardLast4]);

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
      setMessage('Statement opened. Confirm matches below.');
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
        `Period completed${
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

  const session: CcReconcileSession | undefined = sessionQuery.data;
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
      `Create a verified card expense from this statement charge.\nChoose property number:\n${choices}`,
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
          {createMutation.isPending ? 'Uploading…' : 'Upload statement'}
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="tabular-nums muted-text">
              {formatDate(activeSession.statement_start_date)} →{' '}
              {formatDate(activeSession.statement_end_date)}
              {activeSession.card_last4 ? ` · ••${activeSession.card_last4}` : ''}
            </span>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={busy || proposed.length === 0}
              onClick={confirmAllProposed}
            >
              Confirm all matches ({proposed.length})
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={busy || !activeSession.can_complete}
              onClick={() => completeMutation.mutate(activeSession.id)}
            >
              {completeMutation.isPending ? 'Completing…' : 'Complete period'}
            </button>
          </div>

          <VerifyGroupSection title="Matched" count={ableTxs.length} tone="ok">
            <TransactionTable
              rows={ableTxs}
              emptyMessage="No matches yet."
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
                  <span className="text-xs muted-text">Verified</span>
                )
              }
            />
          </VerifyGroupSection>

          <VerifyGroupSection
            title="Missing from statement"
            count={notInExcelTxs.length}
            tone="warn"
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
            title="Unmatched statement lines"
            count={draftTxs.length}
            tone="warn"
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
