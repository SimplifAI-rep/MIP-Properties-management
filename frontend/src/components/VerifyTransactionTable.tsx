import type { ReactNode } from 'react';
import { TransactionTable } from './TransactionTable';
import { VerifySpinner } from './verifyGroups';
import type { UnifiedTransaction } from '../utils/unifiedTransaction';

/**
 * Transactions in the verification flow look exactly like they do on the
 * Transactions page. Balance is the one column left out: reconcile payloads
 * carry no running company-float balance, so it would always be blank.
 */
export function VerifyTransactionTable({
  rows,
  emptyMessage,
  renderActions,
  pendingRowId,
  frameClassName = '',
}: {
  rows: UnifiedTransaction[];
  emptyMessage?: string;
  /** Per-row buttons. Omit for read-only lists (finished periods). */
  renderActions?: (row: UnifiedTransaction) => ReactNode;
  /** Row currently being saved — shows a spinner instead of its buttons. */
  pendingRowId?: string | null;
  /** Lists inside a VerifyGroupSection inherit its frame and pass nothing here. */
  frameClassName?: string;
}) {
  const long = rows.length > 10;
  return (
    <TransactionTable
      rows={rows}
      showActions={Boolean(renderActions)}
      showBalance={false}
      stickyHeader={long}
      actionsColWidth="w-[12%]"
      emptyMessage={emptyMessage}
      renderActions={
        renderActions
          ? (row) => (
              <div className="flex flex-wrap items-center gap-1">
                {pendingRowId === row.id ? <VerifySpinner /> : renderActions(row)}
              </div>
            )
          : undefined
      }
      className={`${frameClassName} overflow-auto${long ? ' max-h-[26rem]' : ''}`.trim()}
    />
  );
}
