import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { BankReconcileSession, CcReconcileSession } from '../types';
import { TransactionTable } from './TransactionTable';
import { VerifyGroupSection } from './verifyGroups';
import { bankDraftToUnified, ccDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';

/** Read-only 3-group view for a completed bank or CC verify session (history). */
export function HistorySessionGroups({
  kind,
  sessionId,
}: {
  kind: 'bank' | 'cc';
  sessionId: string;
}) {
  const bankQuery = useQuery({
    queryKey: ['bank-reconcile-session', sessionId],
    queryFn: () => api.getBankReconcileSession(sessionId),
    enabled: kind === 'bank',
  });
  const ccQuery = useQuery({
    queryKey: ['cc-reconcile-session', sessionId],
    queryFn: () => api.getCcReconcileSession(sessionId),
    enabled: kind === 'cc',
  });

  if (kind === 'bank') {
    if (bankQuery.isLoading) return <p className="text-sm muted-text px-1">Loading…</p>;
    if (bankQuery.isError || !bankQuery.data) {
      return <p className="text-sm text-red-600 px-1">Could not load this period.</p>;
    }
    return <BankHistoryGroups session={bankQuery.data} />;
  }

  if (ccQuery.isLoading) return <p className="text-sm muted-text px-1">Loading…</p>;
  if (ccQuery.isError || !ccQuery.data) {
    return <p className="text-sm text-red-600 px-1">Could not load this period.</p>;
  }
  return <CcHistoryGroups session={ccQuery.data} />;
}

function BankHistoryGroups({ session }: { session: BankReconcileSession }) {
  const ableTxs = txsFromApi(session.able_txs as Record<string, unknown>[] | undefined);
  const notInExcelTxs = txsFromApi(
    session.not_in_excel_txs as Record<string, unknown>[] | undefined,
  );
  const notBank = session.lines.filter((l) => l.status === 'ignored');
  const draftTxs = notBank.map(bankDraftToUnified);

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Found on statement"
        subtitle="View only"
        count={ableTxs.length}
        tone="ok"
        hideWhenEmpty
      >
        <TransactionTable rows={ableTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="In the app, not on the statement"
        subtitle="View only"
        count={notInExcelTxs.length}
        tone="warn"
        hideWhenEmpty
      >
        <TransactionTable rows={notInExcelTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="On the statement, not in the app"
        subtitle="View only"
        count={draftTxs.length}
        tone="warn"
        hideWhenEmpty
      >
        <TransactionTable rows={draftTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>
    </div>
  );
}

function CcHistoryGroups({ session }: { session: CcReconcileSession }) {
  const ableTxs = txsFromApi(session.able_txs as Record<string, unknown>[] | undefined);
  const notInExcelTxs = txsFromApi(
    session.not_in_excel_txs as Record<string, unknown>[] | undefined,
  );
  const notBank = session.lines.filter((l) => l.status === 'ignored');
  const draftTxs = notBank.map(ccDraftToUnified);

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Found on statement"
        subtitle="View only"
        count={ableTxs.length}
        tone="ok"
        hideWhenEmpty
      >
        <TransactionTable rows={ableTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="In the app, not on the statement"
        subtitle="View only"
        count={notInExcelTxs.length}
        tone="warn"
        hideWhenEmpty
      >
        <TransactionTable rows={notInExcelTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="On the statement, not in the app"
        subtitle="View only"
        count={draftTxs.length}
        tone="warn"
        hideWhenEmpty
      >
        <TransactionTable rows={draftTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>
    </div>
  );
}
