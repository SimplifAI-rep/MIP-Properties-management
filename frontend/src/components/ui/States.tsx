import { useEffect } from 'react';
import { useFeedback } from '../../context/FeedbackContext';
import { getUserErrorMessage, isReportableError } from '../../utils/errors';
import { Tooltip } from './Tooltip';

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="panel p-8 text-center muted-text">
      {label}
    </div>
  );
}

type ErrorDisplayProps = {
  /** Friendly message shown to the user. */
  message?: string;
  /** Raw error — used for email report + deriving a friendly message when needed. */
  error?: unknown;
  /** Override auto-report (default: report unexpected errors). */
  report?: boolean;
};

export function ErrorState({ message, error, report }: ErrorDisplayProps) {
  const { reportError } = useFeedback();
  const userMessage = message ?? getUserErrorMessage(error);
  const shouldReport =
    report ?? (error !== undefined ? isReportableError(error) : true);

  useEffect(() => {
    if (!shouldReport) return;
    reportError(error ?? new Error(userMessage), { userMessage });
  }, [error, reportError, shouldReport, userMessage]);

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
      <p>{userMessage}</p>
      {shouldReport ? (
        <p className="mt-2 text-xs opacity-80">
          A report with this error and page was emailed so we can look into it.
        </p>
      ) : null}
    </div>
  );
}

/** Compact form/mutation error line; emails a report for unexpected failures. */
export function InlineError({ message, error, report }: ErrorDisplayProps) {
  const { reportError } = useFeedback();
  const userMessage = message ?? (error !== undefined ? getUserErrorMessage(error) : '');
  const shouldReport =
    report ?? (error !== undefined ? isReportableError(error) : false);

  useEffect(() => {
    if (!shouldReport || !userMessage) return;
    reportError(error ?? new Error(userMessage), { userMessage });
  }, [error, reportError, shouldReport, userMessage]);

  if (!userMessage) return null;

  return <p className="text-negative text-sm whitespace-pre-wrap">{userMessage}</p>;
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
