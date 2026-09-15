import { useState, type ReactNode } from 'react';

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${
        open ? 'rotate-90' : ''
      }`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/** Thin progress bar for "how much of this statement is handled". */
export function VerifyProgress({ handled, total }: { handled: number; total: number }) {
  if (total <= 0) return null;
  const pct = Math.min(100, Math.round((handled / total) * 100));
  const done = handled >= total;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs muted-text">
        <span className="tabular-nums">
          {handled} of {total} handled
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        role="progressbar"
        aria-valuenow={handled}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div
          className={`h-full rounded-full transition-all ${
            done ? 'bg-emerald-500' : 'bg-slate-500 dark:bg-slate-400'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function VerifyGroupSection({
  title,
  subtitle,
  count,
  children,
  tone = 'default',
  defaultOpen = false,
  hideWhenEmpty = false,
  actions,
}: {
  title: string;
  subtitle?: string;
  count: number;
  children: ReactNode;
  tone?: 'default' | 'warn' | 'ok';
  /** When true, the table starts expanded. Default is collapsed. */
  defaultOpen?: boolean;
  /** When true, render nothing if count is 0. */
  hideWhenEmpty?: boolean;
  /** Bulk actions for this list, shown in the header so their scope is obvious. */
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (hideWhenEmpty && count === 0) return null;
  const border =
    tone === 'warn'
      ? 'border-amber-300 dark:border-amber-700/60'
      : tone === 'ok'
        ? 'border-emerald-300 dark:border-emerald-700/50'
        : 'border-slate-200 dark:border-slate-700';
  return (
    <div className={`overflow-hidden rounded-lg border ${border}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          <Chevron open={open} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {title}{' '}
              <span className="muted-text font-normal tabular-nums">({count})</span>
            </span>
            {subtitle ? (
              <span className="mt-0.5 block text-xs muted-text">{subtitle}</span>
            ) : null}
          </span>
        </button>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {open ? (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-700">
          {count === 0 ? <p className="muted-text p-3 text-sm">None.</p> : children}
        </div>
      ) : null}
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
