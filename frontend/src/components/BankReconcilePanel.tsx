import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BankReconcileSession } from '../types';
import { TransactionTable } from './TransactionTable';
import { VerifyGroupSection } from './verifyGroups';
import { formatCurrency, formatDate } from './ui/States';
import { getUserErrorMessage } from '../utils/errors';
import {
  invalidateAlertData,
  invalidateVerificationWorkspace,
} from '../utils/invalidateQueries';
import { bankDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

export function BankReconcilePanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | null>(
    () => searchParams.get('session'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bankAccountId, setBankAccountId] = useState<string>('');

  useEffect(() => {
    const fromUrl = searchParams.get('session');
    if (fromUrl && fromUrl !== sessionId) {
      setSessionId(fromUrl);
    }
  }, [searchParams, sessionId]);

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

  // Keep selected account in sync with the loaded session
  useEffect(() => {
    const accountId = sessionQuery.data?.bank_account_id;
    if (accountId && accountId !== bankAccountId) {
      setBankAccountId(accountId);
    }
  }, [sessionQuery.data?.bank_account_id, bankAccountId]);

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
      setMessage('Statement opened. Confirm matches below.');

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
  // Only unresolved statement lines stay here; Create moves them into Matched (able_txs).
  const notInBankLines =
    activeSession?.lines.filter((l) => l.status === 'unmatched') ?? [];

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
  const draftTxs: UnifiedTransaction[] = notInBankLines.map(bankDraftToUnified);

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
      `Create a verified transaction from this statement line.\nChoose property number:\n${choices}`,
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

  function confirmOne(tx: UnifiedTransaction) {
    if (!activeSession) return;
    const match = fingerprintByTxId.get(tx.id);
    if (!match) return;
    actionsMutation.mutate({
      id: activeSession.id,
      actions: [
        {
          action: 'confirm_match',
          fingerprint: match.fingerprint,
          kind: match.kind,
          tx_id: tx.id,
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {operatingAccounts.length > 1 ? (
          <label className="text-sm flex items-center gap-2 min-w-0">
            <span className="label-text shrink-0">Account</span>
            <select
              className="field py-1 text-sm min-w-[12rem] max-w-full"
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
        <label className="btn-primary cursor-pointer text-sm">
          {createMutation.isPending ? 'Uploading…' : 'Upload statement'}
          <input
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            disabled={
              busy ||
              (operatingAccounts.length > 0 && !bankAccountId) ||
              Boolean(activeSession)
            }
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) {
                createMutation.mutate({
                  file,
                  bankAccountId: bankAccountId || null,
                });
              }
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="tabular-nums muted-text">
              {formatDate(activeSession.statement_start_date)} →{' '}
              {formatDate(activeSession.statement_end_date)}
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
          {!activeSession.can_complete &&
          activeSession.gap_verified != null &&
          activeSession.within_tolerance_verified === false ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Balance still off by {formatCurrency(activeSession.gap_verified)} — ask an
              admin to check opening balance or gap tolerance.
            </p>
          ) : null}

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
                      ignoreApp(row.kind, row.id);
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
                        addFromBank(line.fingerprint);
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
                        ignoreBank(line.fingerprint);
                      }}
                    >
                      Ignore
                    </button>
                  </div>
                );
              }}
            />
          </VerifyGroupSection>

          {proposedSettlements.length > 0 ? (
            <details className="rounded-lg border border-slate-200 dark:border-slate-700">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                More · card settlements ({proposedSettlements.length})
              </summary>
              <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700 space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    disabled={busy}
                    onClick={confirmAllSettlements}
                  >
                    Confirm all settlements
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="table-head">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Settlement</th>
                      <th className="px-2 py-1.5 text-left">Group</th>
                      <th className="px-2 py-1.5 text-left">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposedSettlements.map((line) => (
                      <tr
                        key={line.fingerprint}
                        className="border-t border-slate-200 dark:border-slate-700"
                      >
                        <td className="px-2 py-1.5">
                          {formatDate(line.transaction_date)} · −
                          {formatCurrency(line.amount)}
                        </td>
                        <td className="px-2 py-1.5 text-xs muted-text">
                          {line.proposed_summary}
                        </td>
                        <td className="px-2 py-1.5">
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
                            Confirm
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
