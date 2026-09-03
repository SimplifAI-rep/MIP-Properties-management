import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { VerificationBankGroup, VerificationCcHistoryGroup } from '../types';
import { BankReconcilePanel } from './BankReconcilePanel';
import { CcReconcilePanel } from './CcReconcilePanel';
import { HistorySessionGroups } from './HistorySessionGroups';
import { formatDate } from './ui/States';

type Tab = 'bank' | 'card';

type PastPeriod = {
  key: string;
  kind: 'bank' | 'cc';
  label: string;
  sessionId: string;
  sortDate: string;
};

function pastFromBank(group: VerificationBankGroup): PastPeriod | null {
  if (!group.session_id || group.status !== 'verified') return null;
  return {
    key: `bank:${group.session_id}`,
    kind: 'bank',
    label: group.date
      ? `Bank · through ${formatDate(group.date)}`
      : `Bank · ${group.title}`,
    sessionId: group.session_id,
    sortDate: group.date || group.statement_end_date || '',
  };
}

function pastFromCc(group: VerificationCcHistoryGroup): PastPeriod | null {
  if (!group.session_id) return null;
  const card = group.card_last4 ? `Card ••${group.card_last4}` : 'Card';
  return {
    key: `cc:${group.session_id}`,
    kind: 'cc',
    label: group.date
      ? `${card} · through ${formatDate(group.date)}`
      : `${card} · ${group.title}`,
    sessionId: group.session_id,
    sortDate: group.date || group.statement_end_date || '',
  };
}

export function VerificationWorkspace() {
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const [tab, setTab] = useState<Tab>('bank');
  const [openPastKey, setOpenPastKey] = useState<string | null>(null);
  const [pastOpen, setPastOpen] = useState(false);

  const bank_groups = workspaceQuery.data?.bank_groups ?? [];
  const cc_history = workspaceQuery.data?.cc_history ?? [];

  const pastPeriods = useMemo(() => {
    const rows: PastPeriod[] = [];
    for (const g of bank_groups) {
      const row = pastFromBank(g);
      if (row) rows.push(row);
    }
    for (const g of cc_history) {
      const row = pastFromCc(g);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => (b.sortDate || '').localeCompare(a.sortDate || ''));
    return rows;
  }, [bank_groups, cc_history]);

  if (workspaceQuery.isLoading) {
    return <p className="text-sm muted-text">Loading…</p>;
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return <p className="text-sm text-red-600">Could not load verification.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-slate-200 p-1 dark:border-slate-700 w-fit">
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === 'bank'
              ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
              : 'muted-text hover:bg-slate-50 dark:hover:bg-slate-900/40'
          }`}
          onClick={() => setTab('bank')}
        >
          Bank
        </button>
        <button
          type="button"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            tab === 'card'
              ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
              : 'muted-text hover:bg-slate-50 dark:hover:bg-slate-900/40'
          }`}
          onClick={() => setTab('card')}
        >
          Card
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 sm:p-4">
        {tab === 'bank' ? <BankReconcilePanel /> : <CcReconcilePanel />}
      </div>

      <details
        className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
        open={pastOpen}
        onToggle={(e) => setPastOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-900/40">
          Past periods
          <span className="ml-2 text-xs font-normal muted-text">
            {pastPeriods.length}
          </span>
        </summary>
        <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-3 space-y-2">
          {pastPeriods.length === 0 ? (
            <p className="text-sm muted-text px-1">No completed periods yet.</p>
          ) : (
            pastPeriods.map((period) => {
              const open = openPastKey === period.key;
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
                    <span className="font-medium">{period.label}</span>
                    <span
                      className={
                        period.kind === 'bank'
                          ? 'badge-bank-verified ml-auto'
                          : 'badge-cc-verified ml-auto'
                      }
                    >
                      Verified
                    </span>
                  </button>
                  {open ? (
                    <div className="border-t border-slate-200 px-2 py-3 dark:border-slate-700">
                      <HistorySessionGroups kind={period.kind} sessionId={period.sessionId} />
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </details>
    </div>
  );
}
