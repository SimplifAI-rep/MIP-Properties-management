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
    if (bankQuery.isLoading) return <p className="text-sm muted-text px-1">Loading period…</p>;
    if (bankQuery.isError || !bankQuery.data) {
      return <p className="text-sm text-red-600 px-1">Could not load this period.</p>;
    }
    return <BankHistoryGroups session={bankQuery.data} />;
  }

  if (ccQuery.isLoading) return <p className="text-sm muted-text px-1">Loading period…</p>;
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
  // Created lines live in Matched (able_txs); ignored lines stay here for history.
  const notBank = session.lines.filter((l) => l.status === 'ignored');
  const draftTxs = notBank.map(bankDraftToUnified);

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Matched"
        subtitle="Confirmed matches from this bank period."
        count={ableTxs.length}
        tone="ok"
      >
        <TransactionTable rows={ableTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Missing from statement"
        subtitle="App transactions not found on the statement."
        count={notInExcelTxs.length}
        tone="warn"
      >
        <TransactionTable rows={notInExcelTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Unmatched statement lines"
        subtitle="Statement lines that were ignored."
        count={draftTxs.length}
        tone="warn"
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
  // Created lines live in Matched (able_txs); ignored lines stay here for history.
  const notBank = session.lines.filter((l) => l.status === 'ignored');
  const draftTxs = notBank.map(ccDraftToUnified);

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Matched"
        subtitle="Confirmed matches from this card period."
        count={ableTxs.length}
        tone="ok"
      >
        <TransactionTable rows={ableTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Missing from statement"
        subtitle="Card expenses not found on the statement."
        count={notInExcelTxs.length}
        tone="warn"
      >
        <TransactionTable rows={notInExcelTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Unmatched statement lines"
        subtitle="Statement charges that were ignored."
        count={draftTxs.length}
        tone="warn"
      >
        <TransactionTable rows={draftTxs} showActions={false} emptyMessage="None." />
      </VerifyGroupSection>
    </div>
  );
}
