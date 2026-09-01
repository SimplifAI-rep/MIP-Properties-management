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
}: {
  title: string;
  subtitle?: string;
  count: number;
  children: ReactNode;
  tone?: 'default' | 'warn' | 'ok';
}) {
  const border =
    tone === 'warn'
      ? 'border-amber-300 dark:border-amber-700/60'
      : tone === 'ok'
        ? 'border-emerald-300 dark:border-emerald-700/50'
        : 'border-slate-200 dark:border-slate-700';
  return (
    <div className={`overflow-x-auto rounded-lg border ${border}`}>
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <h4 className="text-sm font-medium">
          {title}{' '}
          <span className="muted-text font-normal tabular-nums">({count})</span>
        </h4>
        {subtitle ? <p className="text-xs muted-text mt-0.5">{subtitle}</p> : null}
      </div>
      {count === 0 ? (
        <p className="muted-text p-3 text-sm">None.</p>
      ) : (
        children
      )}
    </div>
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
