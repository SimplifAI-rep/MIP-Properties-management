import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { VerificationBankGroup, VerificationCcHistoryGroup } from '../types';
import { BankReconcilePanel } from './BankReconcilePanel';
import { CcReconcilePanel } from './CcReconcilePanel';
import { HistorySessionGroups } from './HistorySessionGroups';
import { formatDate } from './ui/States';

type PastStatement = {
  key: string;
  kind: 'bank' | 'cc';
  label: string;
  sessionId: string;
};

type PastPeriodRow = {
  key: string;
  dateLabel: string;
  sortDate: string;
  statements: PastStatement[];
};

function bankStatement(group: VerificationBankGroup): PastStatement | null {
  if (!group.session_id || group.status !== 'verified') return null;
  return {
    key: `bank:${group.session_id}`,
    kind: 'bank',
    label: 'Bank statement',
    sessionId: group.session_id,
  };
}

function ccStatement(group: VerificationCcHistoryGroup): PastStatement | null {
  if (!group.session_id) return null;
  return {
    key: `cc:${group.session_id}`,
    kind: 'cc',
    label: group.card_last4 ? `Card ••${group.card_last4}` : 'Card statement',
    sessionId: group.session_id,
  };
}

function periodDate(group: {
  date: string | null;
  statement_end_date: string | null;
}): string {
  return group.date || group.statement_end_date || '';
}

export function VerificationWorkspace() {
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const [bankOpen, setBankOpen] = useState(true);
  const [cardOpen, setCardOpen] = useState(true);
  const [openPastKey, setOpenPastKey] = useState<string | null>(null);

  const bank_groups = workspaceQuery.data?.bank_groups ?? [];
  const cc_history = workspaceQuery.data?.cc_history ?? [];

  const pastPeriods = useMemo(() => {
    const byDate = new Map<string, PastPeriodRow>();

    const ensure = (sortDate: string): PastPeriodRow => {
      const key = sortDate || 'unknown';
      let row = byDate.get(key);
      if (!row) {
        row = {
          key,
          sortDate,
          dateLabel: sortDate ? `Through ${formatDate(sortDate)}` : 'Past period',
          statements: [],
        };
        byDate.set(key, row);
      }
      return row;
    };

    for (const g of bank_groups) {
      const statement = bankStatement(g);
      if (!statement) continue;
      ensure(periodDate(g)).statements.push(statement);
    }
    for (const g of cc_history) {
      const statement = ccStatement(g);
      if (!statement) continue;
      ensure(periodDate(g)).statements.push(statement);
    }

    for (const row of byDate.values()) {
      row.statements.sort((a, b) => {
        if (a.kind === b.kind) return a.label.localeCompare(b.label);
        return a.kind === 'bank' ? -1 : 1;
      });
    }

    return Array.from(byDate.values()).sort((a, b) =>
      (b.sortDate || '').localeCompare(a.sortDate || ''),
    );
  }, [bank_groups, cc_history]);

  if (workspaceQuery.isLoading) {
    return <p className="text-sm muted-text">Loading…</p>;
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return <p className="text-sm text-red-600">Could not load verification.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-900/40"
          onClick={() => setBankOpen((prev) => !prev)}
          aria-expanded={bankOpen}
        >
          <span className="text-slate-500 w-3 shrink-0 text-xs" aria-hidden>
            {bankOpen ? '▾' : '▸'}
          </span>
          Bank
        </button>
        {bankOpen ? (
          <div className="border-t border-slate-200 p-3 sm:p-4 dark:border-slate-700">
            <BankReconcilePanel />
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-900/40"
          onClick={() => setCardOpen((prev) => !prev)}
          aria-expanded={cardOpen}
        >
          <span className="text-slate-500 w-3 shrink-0 text-xs" aria-hidden>
            {cardOpen ? '▾' : '▸'}
          </span>
          Card
        </button>
        {cardOpen ? (
          <div className="border-t border-slate-200 p-3 sm:p-4 dark:border-slate-700">
            <CcReconcilePanel />
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        {pastPeriods.length === 0 ? (
          <p className="text-sm muted-text px-1">No completed periods yet.</p>
        ) : (
          pastPeriods.map((period) => {
            const open = openPastKey === period.key;
            const hasBank = period.statements.some((s) => s.kind === 'bank');
            const hasCard = period.statements.some((s) => s.kind === 'cc');
            return (
              <div
                key={period.key}
                className="rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  onClick={() =>
                    setOpenPastKey((prev) => (prev === period.key ? null : period.key))
                  }
                  aria-expanded={open}
                >
                  <span className="text-slate-500 w-3 shrink-0 text-xs" aria-hidden>
                    {open ? '▾' : '▸'}
                  </span>
                  <span className="font-medium">{period.dateLabel}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    {hasBank ? <span className="badge-bank-verified">Bank</span> : null}
                    {hasCard ? <span className="badge-cc-verified">Card</span> : null}
                  </span>
                </button>
                {open ? (
                  <div className="border-t border-slate-200 px-2 py-3 dark:border-slate-700 space-y-4">
                    {period.statements.map((statement) => (
                      <div key={statement.key} className="space-y-2">
                        <h4 className="px-1 text-sm font-medium">{statement.label}</h4>
                        <HistorySessionGroups
                          kind={statement.kind}
                          sessionId={statement.sessionId}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
