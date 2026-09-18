import { Fragment, useState, type ReactNode } from 'react';
import { formatCurrency, formatDate } from './ui/States';
import { TransactionTypeBadges } from './TransactionTable';
import {
  transactionAmountClassName,
  type UnifiedTransaction,
} from '../utils/unifiedTransaction';
import { Chevron } from './verifyGroups';

/**
 * Compact table for verification work: only what you need to answer
 * "does this line match?" — everything else lives in the row details.
 */

function rowDescription(row: UnifiedTransaction): string {
  return row.company || row.notes || row.section || '—';
}

function rowReference(row: UnifiedTransaction): string | null {
  if (row.transaction_ref) return row.transaction_ref;
  if (row.bank_asmachta) return `אסמכתא ${row.bank_asmachta}`;
  return null;
}

export function VerifySpinner({ label = 'Working…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs muted-text">
      <span
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 dark:border-slate-600 dark:border-t-slate-300"
        aria-hidden
      />
      {label}
    </span>
  );
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs muted-text">{label}</dt>
      <dd className="truncate text-xs">{value || '—'}</dd>
    </div>
  );
}

export interface VerifyTableProps {
  rows: UnifiedTransaction[];
  emptyMessage?: string;
  renderActions?: (row: UnifiedTransaction) => ReactNode;
  /** Row currently being saved — shows a spinner instead of its buttons. */
  pendingRowId?: string | null;
}

export function VerifyTable({
  rows,
  emptyMessage = 'None.',
  renderActions,
  pendingRowId,
}: VerifyTableProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="muted-text p-3 text-sm">{emptyMessage}</p>;
  }

  const showActions = Boolean(renderActions);

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col className="w-[16%]" />
        <col className="w-[46%]" />
        <col className="w-[20%]" />
        {showActions ? <col className="w-[18%]" /> : null}
      </colgroup>
      <thead className="table-head">
        <tr>
          <th className="px-3 py-2 text-left font-medium">Date</th>
          <th className="px-3 py-2 text-left font-medium">Description</th>
          <th className="px-3 py-2 text-right font-medium">Amount</th>
          {showActions ? (
            <th className="px-3 py-2 text-right font-medium">Action</th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const open = openId === row.id;
          const pending = pendingRowId === row.id;
          const reference = rowReference(row);
          return (
            <Fragment key={`${row.kind}-${row.id}`}>
              <tr className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                  {row.transaction_date ? formatDate(row.transaction_date) : '—'}
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-1.5 text-left"
                    onClick={() => setOpenId(open ? null : row.id)}
                    aria-expanded={open}
                    title={rowDescription(row)}
                  >
                    <Chevron open={open} />
                    <span className="truncate">{rowDescription(row)}</span>
                  </button>
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${transactionAmountClassName(
                    row,
                  )}`}
                >
                  {row.kind === 'deposit' ? '+' : '−'}
                  {formatCurrency(row.amount, row.currency)}
                </td>
                {showActions ? (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {pending ? <VerifySpinner /> : renderActions?.(row)}
                    </div>
                  </td>
                ) : null}
              </tr>
              {open ? (
                <tr className="border-t border-slate-100 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40">
                  <td colSpan={showActions ? 4 : 3} className="px-3 py-3">
                    <div className="space-y-2">
                      <TransactionTypeBadges row={row} />
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                        <DetailItem label="Reference" value={reference} />
                        <DetailItem label="Property" value={row.property_name} />
                        <DetailItem label="Owner" value={row.owner_name} />
                        <DetailItem label="Section" value={row.section} />
                        <DetailItem label="Notes" value={row.notes} />
                        <DetailItem label="Company" value={row.company} />
                        <DetailItem label="Source file" value={row.source_file} />
                        <DetailItem label="Prop ID" value={row.client_prop_id} />
                      </dl>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
