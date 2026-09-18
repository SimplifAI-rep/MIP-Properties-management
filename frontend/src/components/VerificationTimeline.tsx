import { useMemo, useState } from 'react';
import type { VerificationOperatingAccount } from '../types';
import { HistorySessionGroups } from './HistorySessionGroups';
import { Chevron } from './verifyGroups';
import { MoneyValue } from './ui/MoneyValue';
import { formatDate } from './ui/States';

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
  closingBalance: string | null;
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
                  className={`absolute left-[4px] top-4 h-3 w-3 rounded-full ring-2 ring-white dark:ring-slate-900 ${
                    expanded ? 'bg-emerald-600' : 'bg-emerald-500'
                  }`}
                  aria-hidden
                />
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-900/40"
                    onClick={() =>
                      setOpenKey((prev) => (prev === period.key ? null : period.key))
                    }
                    aria-expanded={expanded}
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
                      </span>
                      {period.net != null || period.closingBalance != null ? (
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs muted-text tabular-nums">
                          {period.moneyIn != null ? (
                            <span>
                              In <MoneyValue amount={period.moneyIn} signed={false} />
                            </span>
                          ) : null}
                          {period.moneyOut != null ? (
                            <span>
                              Out <MoneyValue amount={period.moneyOut} signed={false} />
                            </span>
                          ) : null}
                          {period.net != null ? (
                            <span>
                              Net <MoneyValue amount={period.net} />
                            </span>
                          ) : null}
                          {period.closingBalance != null ? (
                            <span>
                              Closing{' '}
                              <MoneyValue amount={period.closingBalance} signed={false} />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
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
