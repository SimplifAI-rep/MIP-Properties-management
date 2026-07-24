import type { ReactNode } from 'react';
import { api } from '../api/client';
import { useFeedback } from '../context/FeedbackContext';
import { formatCurrency, formatDate } from './ui/States';
import { Tooltip } from './ui/Tooltip';
import {
  formatTransactionFeedback,
  isUploadReceiptRef,
  transactionAmountClassName,
  transactionRowClassName,
  type UnifiedTransaction,
} from '../utils/unifiedTransaction';

export function TransactionTypeBadges({
  row,
  reviewMarker,
}: {
  row: UnifiedTransaction;
  reviewMarker?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.needs_review ? reviewMarker : null}
      <span className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
        {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
      </span>
      {row.paid_by_resident ? (
        <Tooltip content="Excel He/She paid — excluded from company float.">
          <span className="badge-resident-paid">He/She paid</span>
        </Tooltip>
      ) : null}
      {row.paid_by_owner ? (
        <Tooltip content="Paid by the owner — excluded from company float.">
          <span className="badge-owner-paid">Owner paid</span>
        </Tooltip>
      ) : null}
      {row.paid_by_company ? (
        <Tooltip content="Paid by the company (MIP) — counts in company float.">
          <span className="badge-mip-paid">MIP paid</span>
        </Tooltip>
      ) : null}
      {row.ledger_column === 'nearly_cc' ? (
        <Tooltip content="From the Nearly credit-card column.">
          <span className="badge-nearly-cc">Nearly CC</span>
        </Tooltip>
      ) : null}
      {row.ledger_column === 'cash' ? (
        <Tooltip content="From the Cash column in the ledger.">
          <span className="badge-cash-paid">Cash</span>
        </Tooltip>
      ) : null}
      {row.ledger_column === 'other' ? (
        <Tooltip content="From the Other column in the ledger.">
          <span className="badge-other-paid">Other</span>
        </Tooltip>
      ) : null}
      {row.is_rental_income ? (
        <Tooltip content="Excel Rental income — tracked separately from company float.">
          <span className="badge-rental-income">Rental income</span>
        </Tooltip>
      ) : null}
      {row.from_bank_statement ? (
        <Tooltip content="Imported from the company bank statement.">
          <span className="badge-bank-statement">Bank statement</span>
        </Tooltip>
      ) : null}
    </div>
  );
}

function ReviewBangStatic({ row }: { row: UnifiedTransaction }) {
  return (
    <Tooltip content={row.review_reasons || 'Incomplete import — needs review.'}>
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-base font-bold leading-none text-negative"
        aria-label="Needs review"
      >
        !
      </span>
    </Tooltip>
  );
}

function FeedbackButton({ row }: { row: UnifiedTransaction }) {
  const { openFeedback } = useFeedback();
  return (
    <Tooltip content="Feedback" hideHint>
      <button
        type="button"
        className="btn-icon"
        onClick={(event) => {
          event.stopPropagation();
          openFeedback({
            initialMessage: formatTransactionFeedback(row),
          });
        }}
        aria-label="Send feedback"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 2c-2.236 0-4.43.18-6.512.512C2.35 2.718 1.5 3.958 1.5 5.373v4.254c0 1.415.85 2.655 1.988 2.86 1.113.178 2.259.3 3.418.364V16.5a.75.75 0 0 0 1.28.53l2.754-2.753A32.978 32.978 0 0 0 10 14c2.236 0 4.43-.18 6.512-.512 1.138-.205 1.988-1.445 1.988-2.86V5.373c0-1.415-.85-2.655-1.988-2.86A33.001 33.001 0 0 0 10 2Zm0 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm6 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </Tooltip>
  );
}

function ReceiptCell({ row }: { row: UnifiedTransaction }) {
  if (!isUploadReceiptRef(row.receipt_ref)) {
    return <span className="muted-text text-xs">—</span>;
  }
  return (
    <a
      href={api.getUploadFileUrl(row.receipt_ref, { download: true })}
      download={row.source_file || undefined}
      className="btn-icon"
      aria-label="Download file"
      title="Download"
      onClick={(event) => event.stopPropagation()}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
        <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
      </svg>
    </a>
  );
}

export function TransactionTableHeader({ showActions = true }: { showActions?: boolean }) {
  return (
    <thead className="table-head">
      <tr>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Deposit = Inflow — Expense = Amount (Excel money columns).">
            Type
          </Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Excel Prop ID.">Prop ID</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">Date</th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Excel Section.">Section</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Excel Notes.">Notes</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Excel Amount (out) or Inflow (in).">Amount</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Running company-float balance after this row (like Excel Balance).">
            Balance
          </Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Excel Company — vendor or payee.">Company</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">Property</th>
        <th className="px-2 py-3 font-medium">Owner</th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="File this row was imported from.">Source file</Tooltip>
        </th>
        <th className="px-2 py-3 font-medium">
          <Tooltip content="Linked receipt (Excel Reciept), if uploaded.">Receipt</Tooltip>
        </th>
        {showActions ? <th className="px-2 py-3 font-medium">Actions</th> : null}
      </tr>
    </thead>
  );
}

export function TransactionTableColgroup({ showActions = true }: { showActions?: boolean }) {
  return (
    <colgroup>
      <col className="w-[11%]" />
      <col className="w-[6%]" />
      <col className="w-[7%]" />
      <col className="w-[8%]" />
      <col className="w-[10%]" />
      <col className="w-[8%]" />
      <col className="w-[8%]" />
      <col className="w-[8%]" />
      <col className="w-[9%]" />
      <col className="w-[8%]" />
      <col className="w-[7%]" />
      <col className="w-[5%]" />
      {showActions ? <col className="w-[5%]" /> : null}
    </colgroup>
  );
}

export function TransactionDisplayCells({
  row,
  reviewMarker,
  actions,
}: {
  row: UnifiedTransaction;
  reviewMarker?: ReactNode;
  actions?: ReactNode;
}) {
  const marker = reviewMarker ?? (row.needs_review ? <ReviewBangStatic row={row} /> : null);

  return (
    <>
      <td className="px-2 py-3">
        <TransactionTypeBadges row={row} reviewMarker={marker} />
      </td>
      <td
        className="px-2 py-3 font-mono text-xs font-medium truncate"
        title={row.client_prop_id}
      >
        {row.client_prop_id}
      </td>
      <td className="px-2 py-3 truncate">
        {row.transaction_date ? (
          formatDate(row.transaction_date)
        ) : row.needs_review ? (
          marker
        ) : (
          '—'
        )}
      </td>
      <td className="px-2 py-3 truncate" title={row.section || undefined}>
        {row.section}
      </td>
      <td className="px-2 py-3 muted-text truncate" title={row.notes || undefined}>
        {row.notes || '—'}
      </td>
      <td className={`px-2 py-3 tabular-nums truncate ${transactionAmountClassName(row)}`}>
        {Number(row.amount) <= 0 && row.needs_review ? (
          marker
        ) : (
          <>
            {row.kind === 'deposit' ? '+' : '−'}
            {formatCurrency(row.amount, row.currency)}
          </>
        )}
      </td>
      <td
        className={`px-2 py-3 tabular-nums font-medium truncate ${
          row.balance_after == null
            ? 'muted-text'
            : Number(row.balance_after) >= 0
              ? 'amount-deposit'
              : 'amount-expense'
        }`}
      >
        {row.balance_after == null
          ? '—'
          : formatCurrency(row.balance_after, row.currency)}
      </td>
      <td className="px-2 py-3 muted-text truncate" title={row.company || undefined}>
        {row.company || '—'}
      </td>
      <td className="px-2 py-3 font-medium truncate" title={row.property_name}>
        {row.property_name}
      </td>
      <td className="px-2 py-3 truncate" title={row.owner_name}>
        {row.owner_name}
      </td>
      <td
        className="px-2 py-3 text-xs muted-text truncate"
        title={row.source_file ?? undefined}
      >
        {row.source_file || '—'}
      </td>
      <td className="px-2 py-3">
        <ReceiptCell row={row} />
      </td>
      {actions !== undefined ? <td className="px-2 py-3">{actions}</td> : null}
    </>
  );
}

export interface TransactionTableProps {
  rows: UnifiedTransaction[];
  emptyMessage?: string;
  onRowClick?: (row: UnifiedTransaction) => void;
  /** When false, hides the Actions column (default true with feedback). */
  showActions?: boolean;
  renderActions?: (row: UnifiedTransaction) => ReactNode;
  className?: string;
}

export function TransactionTable({
  rows,
  emptyMessage = 'No transactions.',
  onRowClick,
  showActions = true,
  renderActions,
  className,
}: TransactionTableProps) {
  if (rows.length === 0) {
    return <p className="muted-text p-4">{emptyMessage}</p>;
  }

  return (
    <div className={className ?? 'overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700'}>
      <table className="table-shell">
        <TransactionTableColgroup showActions={showActions} />
        <TransactionTableHeader showActions={showActions} />
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.kind}-${row.id}`}
              className={`${transactionRowClassName(row)}${onRowClick ? ' table-row-link' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              <TransactionDisplayCells
                row={row}
                actions={
                  showActions
                    ? (renderActions?.(row) ?? (
                        <div className="flex items-center gap-1">
                          <FeedbackButton row={row} />
                        </div>
                      ))
                    : undefined
                }
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
