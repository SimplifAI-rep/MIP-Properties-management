import { Tooltip } from './Tooltip';

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="panel p-8 text-center muted-text">
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
      {message}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center muted-text dark:border-slate-600 dark:bg-slate-900">
      {message}
    </div>
  );
}

export function Card({
  title,
  value,
  subtitle,
  tooltip,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  tooltip?: string;
}) {
  return (
    <div className="panel p-5">
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {tooltip ? (
          <Tooltip content={tooltip}>{title}</Tooltip>
        ) : (
          title
        )}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</p>
      {subtitle ? <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
    </div>
  );
}

export function formatCurrency(amount: string | number, currency = 'ILS') {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  return new Intl.NumberFormat('en-IL', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB');
}
