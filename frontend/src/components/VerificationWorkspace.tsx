import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { VerificationBankGroup, VerificationCcHistoryGroup } from '../types';
import { BankReconcilePanel } from './BankReconcilePanel';
import { CcReconcilePanel } from './CcReconcilePanel';
import { HistorySessionGroups } from './HistorySessionGroups';
import { formatDate } from './ui/States';

function Menu({
  open,
  onToggle,
  title,
  meta,
  badge,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  meta?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900/40"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="text-slate-500 w-3 shrink-0 text-xs" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="font-medium text-sm text-slate-900 dark:text-slate-100">{title}</span>
        {badge}
        {meta ? <span className="text-xs muted-text truncate ml-auto">{meta}</span> : null}
      </button>
      {open ? (
        <div className="border-t border-slate-200 px-3 py-3 dark:border-slate-700 space-y-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function historyBankMeta(group: VerificationBankGroup): string {
  const bits: string[] = [];
  if (group.statement_start_date && group.statement_end_date) {
    bits.push(
      `${formatDate(group.statement_start_date)} → ${formatDate(group.statement_end_date)}`,
    );
  }
  bits.push(`${group.transaction_count}`);
  return bits.join(' · ');
}

function historyCcMeta(group: VerificationCcHistoryGroup): string {
  const bits: string[] = [];
  if (group.statement_start_date && group.statement_end_date) {
    bits.push(
      `${formatDate(group.statement_start_date)} → ${formatDate(group.statement_end_date)}`,
    );
  }
  if (group.card_last4) bits.push(`…${group.card_last4}`);
  bits.push(`${group.transaction_count}`);
  return bits.join(' · ');
}

export function VerificationWorkspace({
  bankBalanceInput: _bankBalanceInput,
  setBankBalanceInput: _setBankBalanceInput,
  dateTo: _dateTo,
  setDateTo: _setDateTo,
}: {
  bankBalanceInput: string;
  setBankBalanceInput: (v: string) => void;
  dateTo: string;
  setDateTo: (v: string) => void;
}) {
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: api.getVerificationWorkspace,
  });

  // All menus start closed
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (workspaceQuery.isLoading) {
    return <p className="text-sm muted-text">Loading…</p>;
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return <p className="text-sm text-red-600">Could not load workspace.</p>;
  }

  const { bank_groups, cc_pool, cc_history = [] } = workspaceQuery.data;
  const openGroup = bank_groups.find((g) => g.id === 'bank-open');
  const bankHistory = bank_groups.filter((g) => g.status === 'verified');
  const hasActiveBank = Boolean(openGroup?.session_id);
  const bankMeta = hasActiveBank
    ? `${formatDate(openGroup!.statement_start_date)} → ${formatDate(openGroup!.statement_end_date)}`
    : 'Upload Excel';
  const ccMeta = `${cc_pool.pending_count} pending`;

  function toggle(key: string) {
    setOpenKey((prev) => (prev === key ? null : key));
  }

  return (
    <div className="space-y-2">
      <Menu
        open={openKey === 'bank'}
        onToggle={() => toggle('bank')}
        title="Bank verification"
        meta={bankMeta}
        badge={
          hasActiveBank ? (
            <span className="badge-bank-unverified">Open</span>
          ) : undefined
        }
      >
        <BankReconcilePanel />
      </Menu>

      <Menu
        open={openKey === 'cc'}
        onToggle={() => toggle('cc')}
        title="Credit card verification"
        meta={ccMeta}
        badge={
          cc_pool.pending_count > 0 ? (
            <span className="badge-cc-pending">Pending</span>
          ) : undefined
        }
      >
        <CcReconcilePanel />
      </Menu>

      <Menu
        open={openKey === 'bank-history' || Boolean(openKey?.startsWith('bh:'))}
        onToggle={() =>
          setOpenKey((prev) =>
            prev === 'bank-history' || prev?.startsWith('bh:') ? null : 'bank-history',
          )
        }
        title="Bank history"
        meta={`${bankHistory.length} period${bankHistory.length === 1 ? '' : 's'}`}
      >
        {bankHistory.length === 0 ? (
          <p className="text-sm muted-text">No completed bank periods.</p>
        ) : (
          <div className="space-y-2">
            {bankHistory.map((group) => {
              const key = `bh:${group.id}`;
              const open = openKey === key;
              return (
                <Menu
                  key={group.id}
                  open={open}
                  onToggle={() =>
                    setOpenKey((prev) => (prev === key ? 'bank-history' : key))
                  }
                  title={group.date ? `Through ${formatDate(group.date)}` : group.title}
                  meta={historyBankMeta(group)}
                  badge={<span className="badge-bank-verified">Verified</span>}
                >
                  {group.session_id ? (
                    <HistorySessionGroups kind="bank" sessionId={group.session_id} />
                  ) : (
                    <p className="text-sm muted-text">No session.</p>
                  )}
                </Menu>
              );
            })}
          </div>
        )}
      </Menu>

      <Menu
        open={openKey === 'cc-history' || Boolean(openKey?.startsWith('ch:'))}
        onToggle={() =>
          setOpenKey((prev) =>
            prev === 'cc-history' || prev?.startsWith('ch:') ? null : 'cc-history',
          )
        }
        title="Credit card history"
        meta={`${cc_history.length} period${cc_history.length === 1 ? '' : 's'} · ${cc_pool.cc_verified_count} awaiting bank`}
      >
        {cc_history.length === 0 ? (
          <p className="text-sm muted-text">No completed CC periods.</p>
        ) : (
          <div className="space-y-2">
            {cc_history.map((group) => {
              const key = `ch:${group.id}`;
              const open = openKey === key;
              return (
                <Menu
                  key={group.id}
                  open={open}
                  onToggle={() =>
                    setOpenKey((prev) => (prev === key ? 'cc-history' : key))
                  }
                  title={group.date ? `Through ${formatDate(group.date)}` : group.title}
                  meta={historyCcMeta(group)}
                  badge={<span className="badge-cc-verified">CC-verified</span>}
                >
                  {group.session_id ? (
                    <HistorySessionGroups kind="cc" sessionId={group.session_id} />
                  ) : (
                    <p className="text-sm muted-text">No session.</p>
                  )}
                </Menu>
              );
            })}
          </div>
        )}
      </Menu>
    </div>
  );
}
