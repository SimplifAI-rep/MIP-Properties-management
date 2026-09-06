import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { VerificationBankGroup, VerificationCcHistoryGroup } from '../types';
import { BankReconcilePanel } from './BankReconcilePanel';
import { CcReconcilePanel } from './CcReconcilePanel';
import { HistorySessionGroups } from './HistorySessionGroups';
import { formatDate } from './ui/States';

type PastCardStatement = {
  key: string;
  label: string;
  sessionId: string;
};

type PastBankPeriod = {
  key: string;
  dateLabel: string;
  sortDate: string;
  bankSessionId: string;
  hasCcDeduction: boolean;
  cards: PastCardStatement[];
};

function periodDate(group: {
  date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
}): string {
  return group.date || group.statement_end_date || '';
}

function cardBelongsToBank(
  card: VerificationCcHistoryGroup,
  bank: VerificationBankGroup,
): boolean {
  const cardDate = card.date || card.statement_end_date || '';
  if (!cardDate) return false;
  const start = bank.statement_start_date || '';
  const end = bank.date || bank.statement_end_date || '';
  if (start && end) return cardDate >= start && cardDate <= end;
  if (end) return cardDate === end || cardDate.slice(0, 7) === end.slice(0, 7);
  return false;
}

export function VerificationWorkspace() {
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const [bankOpen, setBankOpen] = useState(true);
  const [cardOpen, setCardOpen] = useState(true);
  const [openPastKey, setOpenPastKey] = useState<string | null>(null);

  const workspace = workspaceQuery.data;
  const bank_groups = workspace?.bank_groups ?? [];
  const cc_history = workspace?.cc_history ?? [];
  const credit_cards = workspace?.credit_cards ?? [];

  const showCard = useMemo(() => {
    const openBankHasCc = bank_groups.some(
      (g) => g.status === 'unverified' && g.session_id && g.has_cc_deduction,
    );
    const hasOpenCc =
      Boolean(workspace?.cc_active_session_id) ||
      credit_cards.some((c) => Boolean(c.open_session_id));
    const bankWithCcPending =
      bank_groups.some((g) => g.has_cc_deduction) &&
      ((workspace?.cc_pool.pending_count ?? 0) > 0 || hasOpenCc);
    return openBankHasCc || hasOpenCc || bankWithCcPending;
  }, [bank_groups, credit_cards, workspace]);

  const pastPeriods = useMemo(() => {
    const verifiedBanks = bank_groups.filter(
      (g): g is VerificationBankGroup & { session_id: string } =>
        g.status === 'verified' && Boolean(g.session_id),
    );
    const usedCc = new Set<string>();
    const rows: PastBankPeriod[] = verifiedBanks.map((bank) => {
      const sortDate = periodDate(bank);
      const start = bank.statement_start_date;
      const end = bank.date || bank.statement_end_date;
      let dateLabel = '—';
      if (start && end) {
        dateLabel = `${formatDate(start)} → ${formatDate(end)}`;
      } else if (end) {
        dateLabel = formatDate(end);
      } else if (start) {
        dateLabel = formatDate(start);
      }
      const cards: PastCardStatement[] = [];
      if (bank.has_cc_deduction) {
        for (const card of cc_history) {
          if (!card.session_id || usedCc.has(card.session_id)) continue;
          if (!cardBelongsToBank(card, bank)) continue;
          usedCc.add(card.session_id);
          cards.push({
            key: `cc:${card.session_id}`,
            label: card.card_last4 ? `Card ••${card.card_last4}` : 'Card statement',
            sessionId: card.session_id,
          });
        }
      }
      return {
        key: `bank:${bank.session_id}`,
        sortDate,
        dateLabel,
        bankSessionId: bank.session_id!,
        hasCcDeduction: Boolean(bank.has_cc_deduction),
        cards,
      };
    });
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
          <div className="border-t border-slate-200 p-3 sm:p-4 dark:border-slate-700 space-y-3">
            <BankReconcilePanel />

            {showCard ? (
              <div className="ml-0 sm:ml-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-900/40"
                  onClick={() => setCardOpen((prev) => !prev)}
                  aria-expanded={cardOpen}
                >
                  <span className="text-slate-500 w-3 shrink-0 text-xs" aria-hidden>
                    {cardOpen ? '▾' : '▸'}
                  </span>
                  Card
                  <span className="ml-auto text-xs font-normal muted-text">
                    Required for bank card-payment rows
                  </span>
                </button>
                {cardOpen ? (
                  <div className="border-t border-slate-200 p-3 dark:border-slate-700">
                    <CcReconcilePanel />
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs muted-text px-1">
                Card verification appears here only when the bank statement includes a
                credit-card payment deduction.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
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
                  <span className="font-medium">{period.dateLabel}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span className="badge-bank-verified">Bank</span>
                    {period.hasCcDeduction ? (
                      <span className="badge-cc-verified">
                        Card{period.cards.length ? ` · ${period.cards.length}` : ''}
                      </span>
                    ) : null}
                  </span>
                </button>
                {open ? (
                  <div className="border-t border-slate-200 px-2 py-3 dark:border-slate-700 space-y-4">
                    <div className="space-y-2">
                      <h4 className="px-1 text-sm font-medium">Bank statement</h4>
                      <HistorySessionGroups kind="bank" sessionId={period.bankSessionId} />
                    </div>
                    {period.hasCcDeduction ? (
                      period.cards.length > 0 ? (
                        period.cards.map((card) => (
                          <div key={card.key} className="space-y-2 sm:ml-3">
                            <h4 className="px-1 text-sm font-medium">{card.label}</h4>
                            <HistorySessionGroups kind="cc" sessionId={card.sessionId} />
                          </div>
                        ))
                      ) : (
                        <p className="text-xs muted-text px-1 sm:ml-3">
                          Bank had a card payment — no completed card period linked yet.
                        </p>
                      )
                    ) : (
                      <p className="text-xs muted-text px-1 sm:ml-3">
                        No credit-card deduction on this bank statement — card verification
                        was not required.
                      </p>
                    )}
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
