import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { VerificationBankGroup, VerificationCcHistoryGroup } from '../types';
import { BankReconcilePanel } from './BankReconcilePanel';
import { CcReconcilePanel } from './CcReconcilePanel';
import {
  VerificationTimeline,
  type TimelineCard,
  type TimelinePeriod,
} from './VerificationTimeline';
import { Chevron } from './verifyGroups';
import { formatDate } from './ui/States';

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

/** One numbered step inside the current period. */
function StepSection({
  step,
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  step: number;
  title: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-900/40"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span className="text-sm font-medium">
          <span className="muted-text font-normal">Step {step} · </span>
          {title}
        </span>
        {meta ? <span className="ml-auto shrink-0">{meta}</span> : null}
      </button>
      {open ? (
        <div className="border-t border-slate-200 p-3 sm:p-4 dark:border-slate-700">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function VerificationWorkspace() {
  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });
  const [bankOpen, setBankOpen] = useState(true);
  const [cardOpen, setCardOpen] = useState(true);
  const workspace = workspaceQuery.data;
  const bank_groups = workspace?.bank_groups ?? [];
  const cc_history = workspace?.cc_history ?? [];
  const credit_cards = workspace?.credit_cards ?? [];

  const openBankSession = bank_groups.find(
    (g) => g.status === 'unverified' && Boolean(g.session_id),
  );
  const openBankHasCc = Boolean(openBankSession?.has_cc_deduction);
  const hasOpenCc =
    Boolean(workspace?.cc_active_session_id) ||
    credit_cards.some((c) => Boolean(c.open_session_id));

  const showCard = useMemo(() => {
    const bankWithCcPending =
      bank_groups.some((g) => g.has_cc_deduction) &&
      ((workspace?.cc_pool.pending_count ?? 0) > 0 || hasOpenCc);
    return openBankHasCc || hasOpenCc || bankWithCcPending;
  }, [bank_groups, hasOpenCc, openBankHasCc, workspace]);

  const pastPeriods = useMemo(() => {
    const verifiedBanks = bank_groups.filter(
      (g): g is VerificationBankGroup & { session_id: string } =>
        g.status === 'verified' && Boolean(g.session_id),
    );
    const usedCc = new Set<string>();
    const rows: TimelinePeriod[] = verifiedBanks.map((bank) => {
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
      const cards: TimelineCard[] = [];
      if (bank.has_cc_deduction) {
        for (const card of cc_history) {
          if (!card.session_id || usedCc.has(card.session_id)) continue;
          if (!cardBelongsToBank(card, bank)) continue;
          usedCc.add(card.session_id);
          cards.push({
            key: `cc:${card.session_id}`,
            label: card.card_last4 ? `Card ••${card.card_last4}` : 'Card statement',
            sessionId: card.session_id,
            count: card.transaction_count ?? 0,
          });
        }
      }
      const itemCount =
        (bank.transaction_count ?? 0) +
        cards.reduce((sum, card) => sum + card.count, 0);
      return {
        key: `bank:${bank.session_id}`,
        dateLabel,
        startDate: start ?? null,
        endDate: end ?? null,
        bankSessionId: bank.session_id!,
        bankAccountId: bank.bank_account_id ?? null,
        hasCcDeduction: Boolean(bank.has_cc_deduction),
        itemCount,
        moneyIn: bank.money_in ?? null,
        moneyOut: bank.money_out ?? null,
        net:
          bank.money_in != null || bank.money_out != null
            ? Number(bank.money_in ?? 0) - Number(bank.money_out ?? 0)
            : null,
        closingBalance: bank.bank_balance ?? null,
        cards,
      };
    });
    return rows;
  }, [bank_groups, cc_history]);

  /** Where each account's in-progress statement begins, for gap detection. */
  const openStarts = useMemo(() => {
    const out: Record<string, string> = {};
    for (const group of bank_groups) {
      if (group.status !== 'unverified') continue;
      const start = group.statement_start_date;
      if (!start) continue;
      out[group.bank_account_id ?? 'default'] = start;
    }
    return out;
  }, [bank_groups]);

  if (workspaceQuery.isLoading) {
    return <p className="text-sm muted-text">Loading…</p>;
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return <p className="text-sm text-red-600">Could not load verification.</p>;
  }

  return (
    <div className="space-y-5">
      <section className="panel space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="section-title text-base">Current period</h3>
          {openBankSession ? (
            <span className="badge-warning">In progress</span>
          ) : (
            <span className="badge-neutral">Nothing open</span>
          )}
        </div>

        <StepSection
          step={1}
          title="Bank statement"
          open={bankOpen}
          onToggle={() => setBankOpen((prev) => !prev)}
        >
          <BankReconcilePanel />
        </StepSection>

        {showCard ? (
          <StepSection
            step={2}
            title="Credit card"
            open={cardOpen}
            onToggle={() => setCardOpen((prev) => !prev)}
          >
            <div className="space-y-3">
              {!hasOpenCc ? (
                <p className="text-sm muted-text">
                  Your bank statement includes a card payment — upload that card
                  statement next.
                </p>
              ) : null}
              <CcReconcilePanel />
            </div>
          </StepSection>
        ) : openBankSession ? (
          <p className="px-1 text-sm muted-text">
            No card payment on this statement — no card check needed.
          </p>
        ) : null}
      </section>

      <VerificationTimeline
        periods={pastPeriods}
        openStarts={openStarts}
        accounts={workspace?.operating_accounts ?? []}
      />
    </div>
  );
}
