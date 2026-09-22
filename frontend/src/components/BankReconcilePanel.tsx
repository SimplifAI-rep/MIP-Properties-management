import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BankReconcileSession } from '../types';
import { VerifyTransactionTable } from './VerifyTransactionTable';
import {
  VerifyGroupSection,
  VerifyProgress,
  VerifyRowTable,
  VerifySpinner,
} from './verifyGroups';
import { PeriodBalanceCheck, balanceMismatchCopy } from './PeriodBalanceCheck';
import { ConfirmButton } from './ui/ConfirmButton';
import { FileDropzone } from './ui/FileDropzone';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';
import { bankDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

const LINE_STATUS_KEYS = [
  'proposed_match',
  'proposed_settlement',
  'matched',
  'ignored',
  'unmatched',
  'added',
  'settled',
];

/** Upload rejected because the period is already verified — a success, not a failure. */
function isCaughtUpMessage(message: string): boolean {
  return /no new bank transactions/i.test(message);
}

export function BankReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState<string>('');
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [pendingBulk, setPendingBulk] = useState<string | null>(null);

  // Follow URL only when the URL itself changes. Do not depend on sessionId —
  // otherwise an account switch optimistically updates state while the URL is
  // still stale and this effect snaps back to the previous session.
  const urlSessionId = searchParams.get('session');
  useEffect(() => {
    setSessionId(urlSessionId);
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

  const operatingAccounts = workspaceQuery.data?.operating_accounts ?? [];

  const sessionQuery = useQuery({
    queryKey: ['bank-reconcile-session', sessionId],
    queryFn: () => api.getBankReconcileSession(sessionId!),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    if (bankAccountId || operatingAccounts.length === 0) return;
    const withOpen = operatingAccounts.find((a) => a.open_session_id);
    setBankAccountId((withOpen ?? operatingAccounts[0]).id);
  }, [operatingAccounts, bankAccountId]);

  // Keep selected account in sync with the loaded session only when IDs match.
  useEffect(() => {
    const loaded = sessionQuery.data;
    if (!loaded || !sessionId || loaded.id !== sessionId) return;
    const accountId = loaded.bank_account_id;
    if (accountId && accountId !== bankAccountId) {
      setBankAccountId(accountId);
    }
  }, [sessionQuery.data, sessionId, bankAccountId]);

  function selectBankAccount(nextId: string) {
    setBankAccountId(nextId);
    const account = operatingAccounts.find((a) => a.id === nextId);
    const nextSession = account?.open_session_id ?? null;
    setSessionId(nextSession);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (nextSession) next.set('session', nextSession);
      else next.delete('session');
      return next;
    });
    setMessage(null);
    setNotice(null);
    setError(null);
  }

  const createMutation = useMutation({
    mutationFn: ({ file, bankAccountId }: { file: File; bankAccountId?: string | null }) =>
      api.createBankReconcileSession(file, bankAccountId),
    onSuccess: (created) => {
      setSessionId(created.id);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('session', created.id);
        return next;
      });
      setMessage('Statement opened. Check the lists below.');
      setNotice(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-reconcile-session'] });
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
    onSettled: () => {
      setPendingRowId(null);
      setPendingBulk(null);
    },
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
    queryFn: api.getProperties,
  });

  const session: BankReconcileSession | undefined =
    sessionId && sessionQuery.data?.id === sessionId ? sessionQuery.data : undefined;
  const busy =
    createMutation.isPending || actionsMutation.isPending || completeMutation.isPending;
  const activeSession = session?.status === 'in_progress' ? session : undefined;
  const activeAccountLabel =
    operatingAccounts.find(
      (a) => a.id === (activeSession?.bank_account_id || bankAccountId),
    )?.label ?? null;

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
    activeSession?.lines.filter(
      (l) =>
        l.status === 'proposed_settlement' &&
        (l.proposed_member_ids?.length ?? 0) > 0,
    ) ?? [];
  // Unmatched statement lines that need Create/Ignore — card payment rows wait for Card.
  const notInBankLines =
    activeSession?.lines.filter((l) => {
      if (l.status !== 'unmatched') return false;
      if (l.proposed_kind === 'cc_settlement') return false;
      const text = (l.description || '').toLowerCase();
      if (
        text.includes('mastercard') ||
        text.includes('מאסטרקרד') ||
        text.includes('מסטרקארד')
      ) {
        return false;
      }
      return true;
    }) ?? [];

  const fingerprintByTxId = new Map<string, { fingerprint: string; kind: 'deposit' | 'expense' }>();
  for (const line of activeSession?.lines ?? []) {
    if (
      line.proposed_tx_id &&
      (line.proposed_kind === 'deposit' || line.proposed_kind === 'expense') &&
      (line.status === 'proposed_match' || line.status === 'matched' || line.status === 'added')
    ) {
      fingerprintByTxId.set(line.proposed_tx_id, {
        fingerprint: line.fingerprint,
        kind: line.proposed_kind,
      });
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
  const leftoverCcTxs: UnifiedTransaction[] = txsFromApi(
    activeSession?.leftover_cc_txs as Record<string, unknown>[] | undefined,
  );
  const draftTxs: UnifiedTransaction[] = notInBankLines.map(bankDraftToUnified);

  const counts = activeSession?.counts ?? {};
  const totalItems =
    LINE_STATUS_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0) +
    (counts.app_unmatched ?? 0) +
    (counts.app_ignored ?? 0);
  const remainingItems = (counts.unresolved_bank ?? 0) + (counts.unresolved_app ?? 0);
  const handledItems = Math.max(0, totalItems - remainingItems);

  function runActions(
    bulkKey: string | null,
    rowId: string | null,
    actions: Parameters<typeof api.applyBankReconcileActions>[1],
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
        kind: (line.proposed_kind as 'deposit' | 'expense') || undefined,
        tx_id: line.proposed_tx_id || undefined,
      })),
    );
  }

  function confirmAllSettlements() {
    runActions(
      'settle-confirm',
      null,
      proposedSettlements.map((line) => ({
        action: 'confirm_settlement' as const,
        fingerprint: line.fingerprint,
        member_ids: line.proposed_member_ids || undefined,
      })),
    );
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

  function ignoreBank(fingerprint: string) {
    runActions(null, fingerprint, [{ action: 'ignore_bank', fingerprint }]);
  }

  function ignoreAllBank() {
    runActions(
      'ignore-bank',
      null,
      notInBankLines.map((line) => ({
        action: 'ignore_bank' as const,
        fingerprint: line.fingerprint,
      })),
    );
  }

  function ignoreAllSettlements() {
    runActions(
      'settle-ignore',
      null,
      proposedSettlements.map((line) => ({
        action: 'ignore_bank' as const,
        fingerprint: line.fingerprint,
      })),
    );
  }

  function addFromBank(fingerprint: string) {
    const propertyId = bufferPropertyId();
    if (!propertyId) return;
    runActions(null, fingerprint, [
      { action: 'add_from_bank', fingerprint, property_id: propertyId },
    ]);
  }

  function createAllFromBank() {
    const propertyId = bufferPropertyId();
    if (!propertyId) return;
    runActions(
      'create-bank',
      null,
      notInBankLines.map((line) => ({
        action: 'add_from_bank' as const,
        fingerprint: line.fingerprint,
        property_id: propertyId,
      })),
    );
  }

  function ignoreApp(kind: 'deposit' | 'expense', txId: string) {
    runActions(null, txId, [{ action: 'ignore_app', kind, tx_id: txId }]);
  }

  function ignoreAllApp() {
    const pending = notInExcelTxs.filter((tx) => !ignoredAppIds.has(tx.id));
    runActions(
      'ignore-app',
      null,
      pending.map((tx) => ({
        action: 'ignore_app' as const,
        kind: tx.kind,
        tx_id: tx.id,
      })),
    );
  }

  function deferLeftoverCc(txId?: string) {
    runActions(txId ? null : 'defer-cc', txId ?? null, [
      {
        action: 'defer_cc_to_next' as const,
        ...(txId ? { tx_id: txId } : {}),
      },
    ]);
  }

  function confirmOne(tx: UnifiedTransaction) {
    const match = fingerprintByTxId.get(tx.id);
    if (!match) return;
    runActions(null, tx.id, [
      {
        action: 'confirm_match',
        fingerprint: match.fingerprint,
        kind: match.kind,
        tx_id: tx.id,
      },
    ]);
  }

  const pendingMissingCount = notInExcelTxs.filter(
    (tx) => !ignoredAppIds.has(tx.id),
  ).length;

  const completeBlockers: string[] = [];
  if (activeSession && !activeSession.can_complete) {
    if (remainingItems > 0) {
      completeBlockers.push(`Still ${remainingItems} to handle`);
    }
    if (completeBlockers.length === 0) {
      completeBlockers.push('Not ready to finish yet');
    }
  }
  const gapOff =
    Boolean(activeSession) &&
    activeSession!.gap_verified != null &&
    activeSession!.within_tolerance_verified === false;

  const showUpload = !activeSession && !sessionQuery.isLoading;

  return (
    <div className="space-y-3">
      {operatingAccounts.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="label-text mb-0 shrink-0">Account</span>
          <select
            className="field w-auto min-w-[12rem] max-w-full py-1 text-sm"
            value={bankAccountId}
            disabled={busy}
            onChange={(e) => selectBankAccount(e.target.value)}
          >
            {operatingAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
                {account.open_session_id ? ' · in progress' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {showUpload ? (
        <FileDropzone
          label="Upload bank statement"
          busy={createMutation.isPending}
          disabled={busy || (operatingAccounts.length > 0 && !bankAccountId)}
          disabledHint="Choose an account first"
          onFile={(file) =>
            createMutation.mutate({ file, bankAccountId: bankAccountId || null })
          }
        >
          <p className="text-sm font-medium">Start a new bank period</p>
          <p className="mt-1 text-xs muted-text">
            Choose the Excel from the bank · check the lists · finish the period
          </p>
        </FileDropzone>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/30 dark:text-emerald-200"
        >
          You're all caught up — {notice}
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
              {activeAccountLabel ? (
                <span className="muted-text"> · {activeAccountLabel}</span>
              ) : null}
            </p>
            {actionsMutation.isPending ? <VerifySpinner label="Saving…" /> : null}
          </div>

          <PeriodBalanceCheck
            check={{
              openingBalance: activeSession.opening_balance,
              bankBalance: activeSession.bank_balance,
              verifiedNet: activeSession.verified_net,
              gapVerified: activeSession.gap_verified,
              withinTolerance: activeSession.within_tolerance_verified,
              bankIn: activeSession.bank_in,
              bankOut: activeSession.bank_out,
              appIn: activeSession.app_in,
              appOut: activeSession.app_out,
            }}
          />

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
                    disabled={busy || propertiesQuery.isLoading}
                    pending={pendingBulk === 'create-bank'}
                    onConfirm={createAllFromBank}
                  />
                  <ConfirmButton
                    label={`Ignore all (${notInBankLines.length})`}
                    confirmLabel={`Ignore ${notInBankLines.length}`}
                    disabled={busy}
                    pending={pendingBulk === 'ignore-bank'}
                    onConfirm={ignoreAllBank}
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
                      disabled={busy || propertiesQuery.isLoading}
                      onClick={() => addFromBank(line.fingerprint)}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={() => ignoreBank(line.fingerprint)}
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
            subtitle="Ignore if OK"
            count={notInExcelTxs.length}
            tone="warn"
            defaultOpen
            hideWhenEmpty
            actions={
              pendingMissingCount > 0 ? (
                <ConfirmButton
                  label={`Ignore all (${pendingMissingCount})`}
                  confirmLabel={`Ignore ${pendingMissingCount}`}
                  disabled={busy}
                  pending={pendingBulk === 'ignore-app'}
                  onConfirm={ignoreAllApp}
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
                    onClick={() => ignoreApp(row.kind, row.id)}
                  >
                    Ignore
                  </button>
                )
              }
            />
          </VerifyGroupSection>

          {leftoverCcTxs.length > 0 ? (
            <VerifyGroupSection
              title="Card charges not in this payment"
              subtitle="Already in the app — push to the next cycle. Not counted in this period's totals."
              count={leftoverCcTxs.length}
              tone="warn"
              defaultOpen
              actions={
                leftoverCcTxs.length > 0 ? (
                  <ConfirmButton
                    label={`Push to next cycle (${leftoverCcTxs.length})`}
                    confirmLabel={`Push ${leftoverCcTxs.length}`}
                    disabled={busy}
                    pending={pendingBulk === 'defer-cc'}
                    onConfirm={() => deferLeftoverCc()}
                  />
                ) : null
              }
            >
              <VerifyTransactionTable
                rows={leftoverCcTxs}
                pendingRowId={pendingRowId}
                renderActions={(row) => (
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy}
                    onClick={() => deferLeftoverCc(row.id)}
                  >
                    Push to next cycle
                  </button>
                )}
              />
            </VerifyGroupSection>
          ) : null}

          {proposedSettlements.length > 0 ? (
            <VerifyGroupSection
              title="Card payments on the bank statement"
              subtitle="Covered by the card statement — no action needed to finish"
              count={proposedSettlements.length}
              actions={
                <>
                  {pendingBulk === 'settle-confirm' ? (
                    <VerifySpinner />
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary text-xs"
                      disabled={busy}
                      onClick={confirmAllSettlements}
                    >
                      Confirm all
                    </button>
                  )}
                  <ConfirmButton
                    label="Ignore all"
                    confirmLabel={`Ignore ${proposedSettlements.length}`}
                    disabled={busy}
                    pending={pendingBulk === 'settle-ignore'}
                    onConfirm={ignoreAllSettlements}
                  />
                </>
              }
            >
              <VerifyRowTable headers={['Card payment', 'Details', 'Action']}>
                {proposedSettlements.map((line) => (
                  <tr
                    key={line.fingerprint}
                    className="border-t border-slate-100 dark:border-slate-800"
                  >
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {formatDate(line.transaction_date)} · −{formatCurrency(line.amount)}
                    </td>
                    <td className="px-3 py-2 text-xs muted-text">
                      {line.proposed_summary}
                    </td>
                    <td className="px-3 py-2">
                      {pendingRowId === line.fingerprint ? (
                        <VerifySpinner />
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          disabled={busy}
                          onClick={() =>
                            runActions(null, line.fingerprint, [
                              {
                                action: 'confirm_settlement',
                                fingerprint: line.fingerprint,
                                member_ids: line.proposed_member_ids || undefined,
                              },
                            ])
                          }
                        >
                          Confirm
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </VerifyRowTable>
            </VerifyGroupSection>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
            {completeBlockers.length > 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {completeBlockers.join(' · ')}
              </p>
            ) : gapOff ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Everything is handled — {balanceMismatchCopy(activeSession.gap_verified)}.
                Confirm to finish anyway.
              </p>
            ) : (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                Everything is handled — ready to finish.
              </p>
            )}
            {gapOff && activeSession.can_complete ? (
              <ConfirmButton
                label="Finish anyway"
                confirmLabel="Yes, finish anyway"
                className="btn-primary"
                disabled={busy}
                pending={completeMutation.isPending}
                onConfirm={() => completeMutation.mutate(activeSession.id)}
              />
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !activeSession.can_complete}
                onClick={() => completeMutation.mutate(activeSession.id)}
              >
                {completeMutation.isPending ? 'Finishing…' : 'Finish period'}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
