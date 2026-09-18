import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { BankReconcileSession, CcReconcileSession } from '../types';
import { VerifyTransactionTable } from './VerifyTransactionTable';
import { VerifyGroupSection } from './verifyGroups';
import { MoneyValue } from './ui/MoneyValue';
import { bankDraftToUnified, ccDraftToUnified, txsFromApi } from '../utils/verifyTxDisplay';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

/** Read-only view of a finished bank or card period, verified transactions first. */

type Flow = 'all' | 'in' | 'out';

const FLOW_OPTIONS: { id: Flow; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in', label: 'Money in' },
  { id: 'out', label: 'Money out' },
];

function matchesQuery(row: UnifiedTransaction, needle: string): boolean {
  if (!needle) return true;
  const fields = [
    row.notes,
    row.company,
    row.property_name,
    row.owner_name,
    row.client_prop_id,
    row.section,
    row.transaction_ref,
    row.bank_asmachta,
    row.amount,
    row.transaction_date,
  ];
  return fields.some(
    (field) => field != null && String(field).toLowerCase().includes(needle),
  );
}

function sumBy(rows: UnifiedTransaction[], kind: 'deposit' | 'expense'): number {
  return rows
    .filter((row) => row.kind === kind)
    .reduce((total, row) => total + Number(row.amount || 0), 0);
}

/** Outflows display as negative, but -0 would format with a stray minus sign. */
function asOutflow(total: number): number {
  return total === 0 ? 0 : -total;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs muted-text">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
      {hint ? <p className="truncate text-xs muted-text">{hint}</p> : null}
    </div>
  );
}

/** Verified transactions with a search box — the main thing you open a period for. */
function VerifiedTransactions({ rows }: { rows: UnifiedTransaction[] }) {
  const [query, setQuery] = useState('');
  const [flow, setFlow] = useState<Flow>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (flow === 'in' && row.kind !== 'deposit') return false;
      if (flow === 'out' && row.kind !== 'expense') return false;
      return matchesQuery(row, needle);
    });
  }, [rows, query, flow]);

  const narrowed = query.trim() !== '' || flow !== 'all';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          Verified transactions{' '}
          <span className="muted-text font-normal tabular-nums">({rows.length})</span>
        </h4>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className="field w-auto min-w-[10rem] py-1 text-sm"
            placeholder="Search this period…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search verified transactions"
          />
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
            {FLOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs ${
                  flow === option.id
                    ? 'bg-slate-200 font-medium text-slate-900 dark:bg-slate-700 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
                aria-pressed={flow === option.id}
                onClick={() => setFlow(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {narrowed ? (
        <p className="text-xs muted-text tabular-nums" role="status">
          Showing {filtered.length} of {rows.length}
        </p>
      ) : null}

      <VerifyTransactionTable
        rows={filtered}
        emptyMessage={
          rows.length === 0
            ? 'No transactions were verified in this period.'
            : 'Nothing matches that search.'
        }
        frameClassName="rounded-lg border border-emerald-300 dark:border-emerald-700/50"
      />
    </div>
  );
}

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
    if (bankQuery.isLoading) return <p className="px-1 text-sm muted-text">Loading…</p>;
    if (bankQuery.isError || !bankQuery.data) {
      return <p className="px-1 text-sm text-red-600">Could not load this period.</p>;
    }
    return <BankHistoryGroups session={bankQuery.data} />;
  }

  if (ccQuery.isLoading) return <p className="px-1 text-sm muted-text">Loading…</p>;
  if (ccQuery.isError || !ccQuery.data) {
    return <p className="px-1 text-sm text-red-600">Could not load this period.</p>;
  }
  return <CcHistoryGroups session={ccQuery.data} />;
}

function BankHistoryGroups({ session }: { session: BankReconcileSession }) {
  const verified = txsFromApi(session.able_txs as Record<string, unknown>[] | undefined);
  const notOnStatement = txsFromApi(
    session.not_in_excel_txs as Record<string, unknown>[] | undefined,
  );
  const skippedLines = session.lines
    .filter((line) => line.status === 'ignored')
    .map(bankDraftToUnified);

  const moneyIn = sumBy(verified, 'deposit');
  const moneyOut = sumBy(verified, 'expense');

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4 dark:border-slate-700">
        <Stat label="Money in" value={<MoneyValue amount={moneyIn} />} />
        <Stat label="Money out" value={<MoneyValue amount={asOutflow(moneyOut)} />} />
        <Stat
          label="Net"
          value={<MoneyValue amount={moneyIn - moneyOut} />}
          hint="Verified in this period"
        />
        <Stat
          label="Closing balance"
          value={
            session.bank_balance != null ? (
              <MoneyValue amount={session.bank_balance} signed={false} />
            ) : (
              '—'
            )
          }
          hint={session.filename ?? undefined}
        />
      </dl>

      <VerifiedTransactions rows={verified} />

      <VerifyGroupSection
        title="Skipped statement lines"
        subtitle="On the statement, deliberately left out of the app"
        count={skippedLines.length}
        tone="warn"
        hideWhenEmpty
      >
        <VerifyTransactionTable rows={skippedLines} />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not on the statement"
        subtitle="In the app, but the bank did not show them"
        count={notOnStatement.length}
        tone="warn"
        hideWhenEmpty
      >
        <VerifyTransactionTable rows={notOnStatement} />
      </VerifyGroupSection>
    </div>
  );
}

function CcHistoryGroups({ session }: { session: CcReconcileSession }) {
  const verified = txsFromApi(session.able_txs as Record<string, unknown>[] | undefined);
  const notOnStatement = txsFromApi(
    session.not_in_excel_txs as Record<string, unknown>[] | undefined,
  );
  const skippedLines = session.lines
    .filter((line) => line.status === 'ignored')
    .map(ccDraftToUnified);

  const charged = sumBy(verified, 'expense');

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4 dark:border-slate-700">
        <Stat
          label="Charged total"
          value={<MoneyValue amount={asOutflow(charged)} />}
          hint="Verified in this period"
        />
        <Stat label="Card" value={session.card_last4 ? `••${session.card_last4}` : '—'} />
        <Stat label="Items" value={verified.length} />
        <Stat label="Statement" value={session.filename ?? '—'} />
      </dl>

      <VerifiedTransactions rows={verified} />

      <VerifyGroupSection
        title="Skipped statement lines"
        subtitle="On the statement, deliberately left out of the app"
        count={skippedLines.length}
        tone="warn"
        hideWhenEmpty
      >
        <VerifyTransactionTable rows={skippedLines} />
      </VerifyGroupSection>

      <VerifyGroupSection
        title="Not on the statement"
        subtitle="Card expenses in the app the card did not show"
        count={notOnStatement.length}
        tone="warn"
        hideWhenEmpty
      >
        <VerifyTransactionTable rows={notOnStatement} />
      </VerifyGroupSection>
    </div>
  );
}
