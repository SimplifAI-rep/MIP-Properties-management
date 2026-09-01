import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { BankReconcileSession, CcReconcileSession } from '../types';
import {
  formatVerifyAmount,
  formatVerifyDate,
  VerifyGroupSection,
  VerifyRowTable,
} from './verifyGroups';

/** Read-only 3-group view for a completed bank or CC verify session (history). */
export function HistorySessionGroups({
  kind,
  sessionId,
}: {
  kind: 'bank' | 'cc';
  sessionId: string;
}) {
  const query = useQuery({
    queryKey: [kind === 'bank' ? 'bank-reconcile-session' : 'cc-reconcile-session', sessionId],
    queryFn: () =>
      kind === 'bank'
        ? api.getBankReconcileSession(sessionId)
        : api.getCcReconcileSession(sessionId),
  });

  if (query.isLoading) return <p className="text-sm muted-text px-1">Loading period…</p>;
  if (query.isError || !query.data) {
    return <p className="text-sm text-red-600 px-1">Could not load this verified period.</p>;
  }

  if (kind === 'bank') {
    return <BankHistoryGroups session={query.data as BankReconcileSession} />;
  }
  return <CcHistoryGroups session={query.data as CcReconcileSession} />;
}

function BankHistoryGroups({ session }: { session: BankReconcileSession }) {
  const able = session.lines.filter(
    (l) =>
      (l.status === 'matched' || l.status === 'proposed_match') &&
      l.proposed_tx_id &&
      (l.proposed_kind === 'deposit' || l.proposed_kind === 'expense'),
  );
  const notExcel = session.unmatched_app;
  const notBank = session.lines.filter((l) =>
    ['unmatched', 'ignored', 'added'].includes(l.status),
  );

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Able to verify"
        subtitle="Confirmed matches from this bank Excel period."
        count={able.length}
        tone="ok"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction']}>
          {able.map((line) => (
            <tr
              key={line.fingerprint}
              className="border-t border-slate-200 dark:border-slate-700"
            >
              <td className="px-3 py-2">
                <span className="badge-bank-verified">
                  {line.status === 'matched' ? 'Verified' : 'Proposed'}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(line.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">
                {formatVerifyAmount(line.amount, line.side)}
              </td>
              <td className="px-3 py-2">
                <span className="font-mono text-xs">{line.proposed_tx_ref}</span>
                <div className="text-xs muted-text">{line.proposed_summary}</div>
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not in Excel"
        subtitle="App transactions for the period that were not in the Excel (ignored or left unmatched)."
        count={notExcel.length}
        tone="warn"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction']}>
          {notExcel.map((row) => (
            <tr
              key={`${row.kind}:${row.id}`}
              className="border-t border-slate-200 dark:border-slate-700"
            >
              <td className="px-3 py-2">
                <span className="badge-bank-unverified">
                  {row.status === 'ignored' ? 'Ignored' : 'Not in Excel'}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(row.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyAmount(row.amount)}</td>
              <td className="px-3 py-2">
                <span className="font-mono text-xs">{row.transaction_ref}</span>
                <div className="text-xs muted-text">{row.description}</div>
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not in bank"
        subtitle="Excel movements that were created in the app or ignored."
        count={notBank.length}
        tone="warn"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'Details']}>
          {notBank.map((line) => (
            <tr
              key={line.fingerprint}
              className="border-t border-slate-200 dark:border-slate-700"
            >
              <td className="px-3 py-2">
                <span className="badge-bank-unverified">
                  {line.status === 'added'
                    ? 'Created'
                    : line.status === 'ignored'
                      ? 'Ignored'
                      : 'Open'}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(line.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">
                {formatVerifyAmount(line.amount, line.side)}
              </td>
              <td className="px-3 py-2 text-xs muted-text truncate max-w-md">
                {line.description}
                {line.proposed_tx_ref ? ` → ${line.proposed_tx_ref}` : ''}
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>
    </div>
  );
}

function CcHistoryGroups({ session }: { session: CcReconcileSession }) {
  const able = session.lines.filter(
    (l) =>
      (l.status === 'matched' || l.status === 'proposed_match' || l.status === 'added') &&
      l.proposed_tx_id,
  );
  const notExcel = session.unmatched_app;
  const notBank = session.lines.filter((l) =>
    ['unmatched', 'ignored', 'added'].includes(l.status),
  );
  // added appears in both able (via proposed_tx) and notBank — for history keep added only in notBank if it was created from excel
  const ableOnly = able.filter((l) => l.status !== 'added');

  return (
    <div className="space-y-3">
      <VerifyGroupSection
        title="Able to verify"
        subtitle="CC-verified matches from this card Excel period."
        count={ableOnly.length}
        tone="ok"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction']}>
          {ableOnly.map((line) => (
            <tr
              key={line.fingerprint}
              className="border-t border-slate-200 dark:border-slate-700"
            >
              <td className="px-3 py-2">
                <span className="badge-cc-verified">CC-verified</span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(line.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyAmount(line.amount)}</td>
              <td className="px-3 py-2">
                <span className="font-mono text-xs">{line.proposed_tx_ref}</span>
                <div className="text-xs muted-text">{line.proposed_summary || line.merchant}</div>
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not in Excel"
        subtitle="Paid-by-card expenses not found in this CC Excel."
        count={notExcel.length}
        tone="warn"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'App transaction']}>
          {notExcel.map((row) => (
            <tr key={row.id} className="border-t border-slate-200 dark:border-slate-700">
              <td className="px-3 py-2">
                <span className="badge-cc-pending">
                  {row.status === 'ignored' ? 'Ignored' : 'Not in Excel'}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(row.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyAmount(row.amount)}</td>
              <td className="px-3 py-2">
                <span className="font-mono text-xs">{row.transaction_ref}</span>
                <div className="text-xs muted-text">{row.description}</div>
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not in bank"
        subtitle="CC Excel charges created in the app or ignored."
        count={notBank.length}
        tone="warn"
      >
        <VerifyRowTable headers={['Status', 'Date', 'Amount', 'Details']}>
          {notBank.map((line) => (
            <tr
              key={line.fingerprint}
              className="border-t border-slate-200 dark:border-slate-700"
            >
              <td className="px-3 py-2">
                <span className="badge-bank-unverified">
                  {line.status === 'added'
                    ? 'Created'
                    : line.status === 'ignored'
                      ? 'Ignored'
                      : 'Open'}
                </span>
              </td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyDate(line.transaction_date)}</td>
              <td className="px-3 py-2 tabular-nums">{formatVerifyAmount(line.amount)}</td>
              <td className="px-3 py-2 text-xs muted-text truncate max-w-md">
                {line.merchant || line.details}
                {line.proposed_tx_ref ? ` → ${line.proposed_tx_ref}` : ''}
              </td>
            </tr>
          ))}
        </VerifyRowTable>
      </VerifyGroupSection>
    </div>
  );
}
