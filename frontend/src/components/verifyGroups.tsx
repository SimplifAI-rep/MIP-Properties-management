import type { ReactNode } from 'react';
import { formatCurrency, formatDate } from './ui/States';

/** Shared verification buckets for bank + CC Excel sessions. */
export type VerifyBucket = 'able' | 'not_in_excel' | 'not_in_bank';

export function VerifyGroupSection({
  title,
  subtitle,
  count,
  children,
  tone = 'default',
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  count: number;
  children: ReactNode;
  tone?: 'default' | 'warn' | 'ok';
  /** When true, the table starts expanded. Default is collapsed. */
  defaultOpen?: boolean;
}) {
  const border =
    tone === 'warn'
      ? 'border-amber-300 dark:border-amber-700/60'
      : tone === 'ok'
        ? 'border-emerald-300 dark:border-emerald-700/50'
        : 'border-slate-200 dark:border-slate-700';
  return (
    <details
      className={`group overflow-x-auto rounded-lg border ${border}`}
      defaultOpen={defaultOpen}
    >
      <summary className="cursor-pointer select-none list-none px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900/40 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 w-3 shrink-0 text-xs group-open:hidden" aria-hidden>
            ▸
          </span>
          <span className="text-slate-500 w-3 shrink-0 text-xs hidden group-open:inline" aria-hidden>
            ▾
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-medium">
              {title}{' '}
              <span className="muted-text font-normal tabular-nums">({count})</span>
            </h4>
            {subtitle ? <p className="text-xs muted-text mt-0.5">{subtitle}</p> : null}
          </div>
        </div>
      </summary>
      <div className="border-t border-slate-200 dark:border-slate-700">
        {count === 0 ? (
          <p className="muted-text p-3 text-sm">None.</p>
        ) : (
          children
        )}
      </div>
    </details>
  );
}

export function VerifyRowTable({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="table-head">
        <tr>
          {headers.map((h) => (
            <th key={h} className="px-3 py-2 text-left">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function formatVerifyDate(value: string | null | undefined) {
  return value ? formatDate(value) : '—';
}

export function formatVerifyAmount(value: string, sign?: 'credit' | 'debit' | null) {
  const core = formatCurrency(value);
  if (sign === 'credit') return `+${core}`;
  if (sign === 'debit') return `−${core}`;
  return core;
}
