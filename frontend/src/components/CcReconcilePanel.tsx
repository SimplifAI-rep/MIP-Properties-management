import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { CcReconcileSession } from '../types';
import { VerifyTransactionTable } from './VerifyTransactionTable';
import { VerifyGroupSection, VerifyProgress, VerifySpinner } from './verifyGroups';
import { ConfirmButton } from './ui/ConfirmButton';
import { FileDropzone } from './ui/FileDropzone';
import { formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';
import { ccDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

const LINE_STATUS_KEYS = ['proposed_match', 'matched', 'ignored', 'unmatched', 'added'];

function isCaughtUpMessage(message: string): boolean {
  return /no new (card|credit|bank) transactions|no transactions for that period/i.test(
    message,
  );
}

export function CcReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('cc_session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCardLast4, setSelectedCardLast4] = useState<string>('');
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [pendingBulk, setPendingBulk] = useState<string | null>(null);

  // Follow the URL when it names a session. Do not clear state when the nav
  // link drops ?cc_session= — an in-progress card period still lives on the workspace.
  const urlSessionId = searchParams.get('cc_session');
  useEffect(() => {
    if (urlSessionId) setSessionId(urlSessionId);
  }, [urlSessionId]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [notice]);

  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const creditCards = (workspaceQuery.data?.credit_cards ?? []).filter(
    (card) => card.is_active !== false || Boolean(card.open_session_id),
  );

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

  // Restore the in-progress card period after leaving Verification.
  useEffect(() => {
    if (sessionId || urlSessionId) return;
    if (!workspaceQuery.isSuccess || workspaceQuery.isFetching) return;
    const selected = selectedCardLast4
      ? creditCards.find((card) => card.card_last4 === selectedCardLast4)
      : undefined;
    const openId =
      selected?.open_session_id ??
      (selectedCardLast4
        ? null
        : creditCards.find((card) => card.open_session_id)?.open_session_id ?? null);
    if (!openId) return;
    setSessionId(openId);
  }, [
    sessionId,
    urlSessionId,
    selectedCardLast4,
    creditCards,
    workspaceQuery.isSuccess,
    workspaceQuery.isFetching,
  ]);

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
    setMessage(null);
    setNotice(null);
    setError(null);
    if (last4 === '__new__') {
      setSessionId(null);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('cc_session');
        return next;
      });
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
      setNotice(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['cc-reconcile-session'] });
      invalidateAlertData(queryClient);
      invalidateVerificationWorkspace(queryClient);
    },
    onError: (err) => {
      const text = getUserErrorMessage(err);
      setMessage(null);
      if (isCaughtUpMessage(text)) {
        setNotice(text);
        setError(null);
      } else {
        setError(text);
        setNotice(null);
      }
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
    onSettled: () => {
      setPendingRowId(null);
      setPendingBulk(null);
    },
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
  // Only unresolved statement lines stay here; Create moves them into the found list.
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

  const counts = activeSession?.counts ?? {};
  const totalItems =
    LINE_STATUS_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0) +
    (counts.app_unmatched ?? 0) +
    (counts.app_ignored ?? 0);
  const remainingItems = (counts.unresolved_cc ?? 0) + (counts.unresolved_app ?? 0);
  const handledItems = Math.max(0, totalItems - remainingItems);

  function runActions(
    bulkKey: string | null,
    rowId: string | null,
    actions: Parameters<typeof api.applyCcReconcileActions>[1],
  ) {
    if (!activeSession || actions.length === 0) return;
    setPendingBulk(bulkKey);
    setPendingRowId(rowId);
    actionsMutation.mutate({ id: activeSession.id, actions });
  }

  function confirmAllProposed() {
    runActions(
      'confirm',
      null,
      proposed.map((line) => ({
        action: 'confirm_match' as const,
        fingerprint: line.fingerprint,
        tx_id: line.proposed_tx_id || undefined,
      })),
    );
  }

  function ignoreCc(fingerprint: string) {
    runActions(null, fingerprint, [{ action: 'ignore_cc', fingerprint }]);
  }

  function ignoreAllCc() {
    runActions(
      'ignore-cc',
      null,
      notInBankLines.map((line) => ({
        action: 'ignore_cc' as const,
        fingerprint: line.fingerprint,
      })),
    );
  }

  function addFromCc(fingerprint: string) {
    runActions(null, fingerprint, [{ action: 'add_from_cc', fingerprint }]);
  }

  function createAllFromCc() {
    runActions(
      'create-cc',
      null,
      notInBankLines.map((line) => ({
        action: 'add_from_cc' as const,
        fingerprint: line.fingerprint,
      })),
    );
  }

  function deferApp(txId?: string) {
    const pending = notInExcelTxs.filter((tx) => !ignoredAppIds.has(tx.id));
    runActions(txId ? null : 'defer-cc', txId ?? null, [
      {
        action: 'defer_cc_to_next' as const,
        ...(txId
          ? { tx_id: txId }
          : { member_ids: pending.map((tx) => tx.id) }),
      },
    ]);
  }

  function confirmOne(tx: UnifiedTransaction) {
    const fingerprint = fingerprintByTxId.get(tx.id);
    if (!fingerprint) return;
    runActions(null, tx.id, [
      { action: 'confirm_match', fingerprint, tx_id: tx.id },
    ]);
  }

  const pendingMissingCount = notInExcelTxs.filter(
    (tx) => !ignoredAppIds.has(tx.id),
  ).length;

  const completeBlockers: string[] = [];
  if (activeSession && !activeSession.can_complete) {
    completeBlockers.push(
      remainingItems > 0 ? `Still ${remainingItems} to handle` : 'Not ready to finish yet',
    );
  }

  const showCardPicker = creditCards.length > 1 || selectedCardLast4 === '__new__';
  const showUpload = !activeSession && !sessionQuery.isLoading;

  return (
    <div className="space-y-3">
      {showCardPicker || creditCards.length === 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          {showCardPicker ? (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="label-text mb-0 shrink-0">Card</span>
              <select
                className="field w-auto min-w-[12rem] max-w-full py-1 text-sm"
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
          {creditCards.length === 1 && selectedCardLast4 !== '__new__' ? (
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={busy || Boolean(activeSession)}
              onClick={() => selectCard('__new__')}
            >
              Another card
            </button>
          ) : null}
        </div>
      ) : null}

      {showUpload ? (
        <FileDropzone
          label="Upload card statement"
          busy={createMutation.isPending}
          disabled={
            busy ||
            (selectedCardLast4 !== '__new__' &&
              selectedCardLast4 !== '' &&
              selectedHasOpenSession)
          }
          disabledHint="This card already has an open period"
          onFile={(file) => createMutation.mutate(file)}
        >
          <p className="text-sm font-medium">Start a new card period</p>
          <p className="mt-1 text-xs muted-text">
            Choose the Excel from the card · check the lists · finish the period
          </p>
        </FileDropzone>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-200"
        >
          {/no transactions for that period/i.test(notice)
            ? notice
            : `You're all caught up — ${notice}`}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {sessionQuery.isLoading && sessionId ? (
        <p className="text-sm muted-text">Loading…</p>
      ) : null}

      {activeSession ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-sm">
              <span className="font-medium tabular-nums">
                {formatDate(activeSession.statement_start_date)} →{' '}
                {formatDate(activeSession.statement_end_date)}
              </span>
              {activeSession.card_last4 ? (
                <span className="muted-text"> · ••{activeSession.card_last4}</span>
              ) : null}
            </p>
            {actionsMutation.isPending ? <VerifySpinner label="Saving…" /> : null}
          </div>

          <VerifyProgress handled={handledItems} total={totalItems} />

          <VerifyGroupSection
            title="Found on statement"
            subtitle="Confirm these"
            count={ableTxs.length}
            tone="ok"
            defaultOpen
            hideWhenEmpty
            actions={
              proposed.length > 0 ? (
                pendingBulk === 'confirm' ? (
                  <VerifySpinner />
                ) : (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={confirmAllProposed}
                  >
                    Confirm all found ({proposed.length})
                  </button>
                )
              ) : null
            }
          >
            <VerifyTransactionTable
              rows={ableTxs}
              pendingRowId={pendingRowId}
              renderActions={(row) =>
                proposedTxIds.has(row.id) ? (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={() => confirmOne(row)}
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
            title="On the statement, not in the app"
            subtitle="Create or Ignore"
            count={draftTxs.length}
            tone="warn"
            defaultOpen
            hideWhenEmpty
            actions={
              notInBankLines.length > 0 ? (
                <>
                  <ConfirmButton
                    label={`Create all (${notInBankLines.length})`}
                    confirmLabel={`Create ${notInBankLines.length}`}
                    disabled={busy}
                    pending={pendingBulk === 'create-cc'}
                    onConfirm={createAllFromCc}
                  />
                  <ConfirmButton
                    label={`Ignore all (${notInBankLines.length})`}
                    confirmLabel={`Ignore ${notInBankLines.length}`}
                    disabled={busy}
                    pending={pendingBulk === 'ignore-cc'}
                    onConfirm={ignoreAllCc}
                  />
                </>
              ) : null
            }
          >
            <VerifyTransactionTable
              rows={draftTxs}
              pendingRowId={pendingRowId}
              renderActions={(row) => {
                const line = notInBankLines.find((l) => l.fingerprint === row.id);
                if (!line) return null;
                return (
                  <>
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      disabled={busy}
                      onClick={() => addFromCc(line.fingerprint)}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={() => ignoreCc(line.fingerprint)}
                    >
                      Ignore
                    </button>
                  </>
                );
              }}
            />
          </VerifyGroupSection>

          <VerifyGroupSection
            title="In the app, not on the statement"
            subtitle="Push to the next cycle — not in this card payment, and not counted in this period's totals"
            count={notInExcelTxs.length}
            tone="warn"
            defaultOpen
            hideWhenEmpty
            actions={
              pendingMissingCount > 0 ? (
                <ConfirmButton
                  label={`Push to next cycle (${pendingMissingCount})`}
                  confirmLabel={`Push ${pendingMissingCount}`}
                  disabled={busy}
                  pending={pendingBulk === 'defer-cc'}
                  onConfirm={() => deferApp()}
                />
              ) : null
            }
          >
            <VerifyTransactionTable
              rows={notInExcelTxs}
              pendingRowId={pendingRowId}
              renderActions={(row) =>
                ignoredAppIds.has(row.id) ? (
                  <span className="text-xs muted-text">Ignored</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={() => deferApp(row.id)}
                  >
                    Push to next cycle
                  </button>
                )
              }
            />
          </VerifyGroupSection>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            {completeBlockers.length > 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {completeBlockers.join(' · ')}
              </p>
            ) : (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                Everything is handled — ready to finish.
              </p>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !activeSession.can_complete}
              onClick={() => completeMutation.mutate(activeSession.id)}
            >
              {completeMutation.isPending ? 'Finishing…' : 'Finish period'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
