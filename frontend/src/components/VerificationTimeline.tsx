import { useMemo, useState } from 'react';
import type { VerificationOperatingAccount } from '../types';
import { HistorySessionGroups } from './HistorySessionGroups';
import { PeriodBalanceBadge, periodBalanceState } from './PeriodBalanceCheck';
import { Chevron } from './verifyGroups';
import { MoneyValue } from './ui/MoneyValue';
import { formatCurrency, formatDate } from './ui/States';

/**
 * Finished periods as a vertical timeline. Periods tile the calendar — each one
 * picks up the day after the last ended — so the rail doubles as a coverage
 * check: any hole between two nodes is money nobody ever verified.
 */

export type TimelineCard = {
  key: string;
  label: string;
  sessionId: string;
  count: number;
};

export type TimelinePeriod = {
  key: string;
  dateLabel: string;
  startDate: string | null;
  endDate: string | null;
  bankSessionId: string;
  bankAccountId: string | null;
  hasCcDeduction: boolean;
  itemCount: number;
  moneyIn: string | null;
  moneyOut: string | null;
  net: number | null;
  bankIn: string | null;
  bankOut: string | null;
  closingBalance: string | null;
  openingBalance: string | null;
  verifiedNet: string | null;
  gapVerified: string | null;
  withinTolerance: boolean | null;
  cards: TimelineCard[];
};

type Row =
  | { kind: 'period'; key: string; period: TimelinePeriod }
  | { kind: 'gap'; key: string; days: number; from: string; to: string };

const RAIL = 'absolute left-[9px] w-px';
/** Distance from a row's top to the middle of its dot. */
const DOT_CENTER = '22px';

function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86400000;
}

function isoFromDay(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

/** Days between two periods that no statement ever covered. */
function holeBetween(
  earlierEnd: string | null,
  laterStart: string | null,
): { days: number; from: string; to: string } | null {
  if (!earlierEnd || !laterStart) return null;
  const first = dayNumber(earlierEnd) + 1;
  const last = dayNumber(laterStart) - 1;
  const days = last - first + 1;
  if (days <= 0) return null;
  return { days, from: isoFromDay(first), to: isoFromDay(last) };
}

function periodYear(period: TimelinePeriod): number | null {
  const iso = period.endDate || period.startDate;
  return iso ? Number(iso.slice(0, 4)) : null;
}

export function VerificationTimeline({
  periods,
  openStarts,
  accounts,
}: {
  periods: TimelinePeriod[];
  /** Start date of each account's in-progress statement, keyed by account id. */
  openStarts: Record<string, string>;
  accounts: VerificationOperatingAccount[];
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const years = useMemo(() => {
    const found = new Set<number>();
    for (const period of periods) {
      const year = periodYear(period);
      if (year != null) found.add(year);
    }
    return [...found].sort((a, b) => b - a);
  }, [periods]);

  const [year, setYear] = useState<number | null>(null);
  const activeYear = year ?? years[0] ?? null;

  const rows = useMemo<Row[]>(() => {
    const accountOf = (period: TimelinePeriod) => period.bankAccountId ?? 'default';

    // Walk every period oldest-first so each one knows what came before it on
    // the same account. Gaps only mean something within a single account.
    const oldestFirst = [...periods].sort((a, b) =>
      (a.startDate || a.endDate || '').localeCompare(b.startDate || b.endDate || ''),
    );
    const previous = new Map<string, TimelinePeriod>();
    const newestByAccount = new Map<string, TimelinePeriod>();
    for (const period of oldestFirst) {
      const account = accountOf(period);
      const before = newestByAccount.get(account);
      if (before) previous.set(period.key, before);
      newestByAccount.set(account, period);
    }

    const visible = oldestFirst
      .filter((period) => activeYear == null || periodYear(period) === activeYear)
      .reverse();

    const out: Row[] = [];
    for (const period of visible) {
      const account = accountOf(period);
      // A hole between the newest finished period and the statement now open
      // belongs above that period, since the rail runs newest-first.
      if (newestByAccount.get(account)?.key === period.key) {
        const ahead = holeBetween(period.endDate, openStarts[account] ?? null);
        if (ahead) out.push({ kind: 'gap', key: `ahead-${period.key}`, ...ahead });
      }
      out.push({ kind: 'period', key: period.key, period });
      const behind = holeBetween(previous.get(period.key)?.endDate ?? null, period.startDate);
      if (behind) out.push({ kind: 'gap', key: `behind-${period.key}`, ...behind });
    }
    return out;
  }, [periods, openStarts, activeYear]);

  const showAccount = accounts.length > 1;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="section-title text-base">Finished periods</h3>
        {years.length > 1 ? (
          <select
            className="field w-auto py-1 text-sm"
            value={activeYear ?? ''}
            onChange={(event) => setYear(Number(event.target.value))}
            aria-label="Year"
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-1 text-sm muted-text">No finished periods yet.</p>
      ) : (
        <ol>
          {rows.map((row, index) => {
            const single = rows.length === 1;
            const first = index === 0;
            const last = index === rows.length - 1;
            const railStyle = {
              top: first ? DOT_CENTER : 0,
              ...(last ? { height: DOT_CENTER } : { bottom: 0 }),
            };

            if (row.kind === 'gap') {
              return (
                <li key={row.key} className="relative pb-2 pl-7">
                  {single ? null : (
                    <span
                      className={`${RAIL} bg-amber-300 dark:bg-amber-500/60`}
                      style={railStyle}
                      aria-hidden
                    />
                  )}
                  <span
                    className="absolute left-[4px] top-4 h-3 w-3 rounded-full bg-amber-400 ring-2 ring-white dark:ring-slate-900"
                    aria-hidden
                  />
                  <p className="py-3 text-xs font-medium text-amber-700 dark:text-amber-400">
                    {row.days} {row.days === 1 ? 'day' : 'days'} never checked
                    <span className="ml-2 font-normal tabular-nums">
                      {row.from === row.to
                        ? formatDate(row.from)
                        : `${formatDate(row.from)} → ${formatDate(row.to)}`}
                    </span>
                  </p>
                </li>
              );
            }

            const period = row.period;
            const expanded = openKey === period.key;
            const balanceCheck = {
              openingBalance: period.openingBalance,
              bankBalance: period.closingBalance,
              verifiedNet: period.verifiedNet,
              gapVerified: period.gapVerified,
              withinTolerance: period.withinTolerance,
              bankIn: period.bankIn,
              bankOut: period.bankOut,
              appIn: period.moneyIn,
              appOut: period.moneyOut,
            };
            const totals = periodBalanceState(balanceCheck);
            const rowTone =
              totals === 'match'
                ? 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-700/60 dark:bg-emerald-950/25'
                : totals === 'mismatch'
                  ? 'border-amber-300 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/25'
                  : 'border-slate-200 dark:border-slate-700';
            const dotTone =
              totals === 'match'
                ? expanded
                  ? 'bg-emerald-600'
                  : 'bg-emerald-500'
                : totals === 'mismatch'
                  ? 'bg-amber-500'
                  : 'bg-slate-400';
            return (
              <li key={row.key} className="relative pb-2 pl-7">
                {single ? null : (
                  <span
                    className={`${RAIL} bg-slate-200 dark:bg-slate-700`}
                    style={railStyle}
                    aria-hidden
                  />
                )}
                <span
                  className={`absolute left-[4px] top-4 h-3 w-3 rounded-full ring-2 ring-white dark:ring-slate-900 ${dotTone}`}
                  aria-hidden
                />
                <div className={`overflow-hidden rounded-lg border ${rowTone}`}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-900/40"
                    onClick={() =>
                      setOpenKey((prev) => (prev === period.key ? null : period.key))
                    }
                    aria-expanded={expanded}
                    aria-label={
                      totals === 'match'
                        ? `${period.dateLabel}, totals match`
                        : totals === 'mismatch'
                          ? `${period.dateLabel}, totals off`
                          : period.dateLabel
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium tabular-nums">
                          {period.dateLabel}
                        </span>
                        {period.itemCount > 0 ? (
                          <span className="muted-text tabular-nums">
                            {period.itemCount} items
                          </span>
                        ) : null}
                        {showAccount ? (
                          <span className="truncate text-xs muted-text">
                            {accounts.find(
                              (account) => account.id === period.bankAccountId,
                            )?.label ?? 'Operating account'}
                          </span>
                        ) : null}
                        {totals === 'match' ? (
                          <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                            Totals match
                          </span>
                        ) : totals === 'mismatch' ? (
                          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                            Totals off
                            {period.gapVerified != null
                              ? ` · ${formatCurrency(period.gapVerified)}`
                              : ''}
                          </span>
                        ) : null}
                      </span>
                      {period.net != null ||
                      period.closingBalance != null ||
                      period.bankIn != null ? (
                        <span className="mt-0.5 flex flex-col gap-0.5 text-xs muted-text tabular-nums">
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span>
                              Bank in{' '}
                              <MoneyValue amount={period.bankIn ?? 0} signed={false} />
                            </span>
                            <span>
                              Bank out{' '}
                              <MoneyValue
                                amount={
                                  Number(period.bankOut ?? 0) === 0
                                    ? 0
                                    : -Math.abs(Number(period.bankOut ?? 0))
                                }
                              />
                            </span>
                            <span>
                              Bank net{' '}
                              <MoneyValue
                                amount={
                                  Number(period.bankIn ?? 0) - Number(period.bankOut ?? 0)
                                }
                              />
                            </span>
                          </span>
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span>
                              App in{' '}
                              <MoneyValue amount={period.moneyIn ?? 0} signed={false} />
                            </span>
                            <span>
                              App out{' '}
                              <MoneyValue
                                amount={
                                  Number(period.moneyOut ?? 0) === 0
                                    ? 0
                                    : -Math.abs(Number(period.moneyOut ?? 0))
                                }
                              />
                            </span>
                            <span>
                              App net <MoneyValue amount={period.net ?? 0} />
                            </span>
                            {period.closingBalance != null ? (
                              <span>
                                Closing{' '}
                                <MoneyValue amount={period.closingBalance} signed={false} />
                              </span>
                            ) : null}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <PeriodBalanceBadge check={balanceCheck} />
                      <span className="badge-bank-verified">Bank</span>
                      {period.hasCcDeduction ? (
                        <span className="badge-cc-verified">
                          Card{period.cards.length ? ` · ${period.cards.length}` : ''}
                        </span>
                      ) : null}
                      <span className="badge-neutral">View only</span>
                    </span>
                    <span className="mt-0.5 shrink-0">
                      <Chevron open={expanded} />
                    </span>
                  </button>
                  {expanded ? (
                    <div className="space-y-4 border-t border-slate-200 px-3 py-3 dark:border-slate-700">
                      <div className="space-y-2">
                        <h4 className="section-title text-sm">Bank statement</h4>
                        <HistorySessionGroups
                          kind="bank"
                          sessionId={period.bankSessionId}
                        />
                      </div>
                      {period.hasCcDeduction ? (
                        period.cards.length > 0 ? (
                          period.cards.map((card) => (
                            <div key={card.key} className="space-y-2">
                              <h4 className="section-title text-sm">{card.label}</h4>
                              <HistorySessionGroups
                                kind="cc"
                                sessionId={card.sessionId}
                              />
                            </div>
                          ))
                        ) : (
                          <p className="px-1 text-xs muted-text">
                            Bank had a card payment — no finished card period linked
                            yet.
                          </p>
                        )
                      ) : (
                        <p className="px-1 text-xs muted-text">
                          No card payment on this bank statement — card check was not
                          needed.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
