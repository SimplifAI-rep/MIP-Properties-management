import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { useFeedback } from '../context/FeedbackContext';
import type { OwnerDetail, OwnerSummary } from '../types';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';
import { depositToUnified, expenseToUnified } from '../utils/unifiedTransaction';

const OWNER_COL_COUNT = 6;

function formatOwnerFeedback(owner: OwnerSummary): string {
  return [
    'Feedback about this owner:',
    `Owner: ${owner.name}`,
    `Owner ID: ${owner.id}`,
    `Properties: ${owner.property_count}`,
    `Deposits: ${owner.total_deposits} (${owner.deposit_count})`,
    `Expenses: ${owner.total_expenses} (${owner.expense_count})`,
    `Balance: ${owner.balance}`,
  ].join('\n');
}

function recentOwnerTransactions(detail: OwnerDetail) {
  const deposits = detail.recent_deposits ?? [];
  const expenses = detail.recent_expenses ?? [];
  return [...deposits.map(depositToUnified), ...expenses.map(expenseToUnified)]
    .sort((a, b) => {
      const aHasDate = Boolean(a.transaction_date);
      const bHasDate = Boolean(b.transaction_date);
      if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;
      const aTime = a.transaction_date ? new Date(a.transaction_date).getTime() : 0;
      const bTime = b.transaction_date ? new Date(b.transaction_date).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);
}

const feedbackIcon = (
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
);

function OwnerExpandedDetails({
  detail,
  isLoading,
  isError,
  error,
  onNavigateTransactions,
  onFeedback,
}: {
  detail: OwnerDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onNavigateTransactions: () => void;
  onFeedback: (owner: OwnerSummary) => void;
}) {
  if (isLoading) {
    return <LoadingState label="Loading owner..." />;
  }
  if (isError || !detail) {
    return (
      <ErrorState
        message="We couldn't load this owner's details. Please try again."
        error={error}
        report={isError}
      />
    );
  }

  return (
    <div className="space-y-4" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <h3 className="detail-title">{detail.name}</h3>
            <span className="text-base text-slate-600 dark:text-slate-300">
              Deposits:{' '}
              <span className="amount-deposit text-lg font-semibold">
                {formatCurrency(detail.total_deposits)}
              </span>
            </span>
            <span className="text-base text-slate-600 dark:text-slate-300">
              Expenses:{' '}
              <span className="amount-expense text-lg font-semibold">
                {formatCurrency(detail.total_expenses)}
              </span>
            </span>
            <span
              className={`text-lg font-semibold ${
                Number(detail.balance ?? 0) >= 0 ? 'amount-deposit' : 'amount-expense'
              }`}
            >
              Balance: {formatCurrency(detail.balance ?? '0')}
            </span>
          </div>
          {detail.contact_email ? <p className="muted-text">{detail.contact_email}</p> : null}
          {detail.contact_phone ? <p className="muted-text">{detail.contact_phone}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/transactions"
            state={ownerTransactionsState(detail.id)}
            className="btn-primary inline-flex"
          >
            View transactions
          </Link>
          <Tooltip content="Feedback" hideHint>
            <button
              type="button"
              className="btn-icon"
              onClick={() => onFeedback(detail)}
              aria-label="Send feedback"
            >
              {feedbackIcon}
            </button>
          </Tooltip>
        </div>
      </div>

      <div>
        <h4 className="subheading">Properties</h4>
        {detail.properties.length === 0 ? (
          <p className="mt-2 muted-text">No properties linked.</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 text-sm">
            {detail.properties.map((property) => (
              <li key={property.id}>
                <Link
                  to="/transactions"
                  state={propertyTransactionsState(property.id, property.client_prop_id)}
                  className="list-item block hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {property.client_prop_id} — {property.name}
                  </p>
                  {property.address ? <p className="muted-text">{property.address}</p> : null}
                  <p className="mt-1 text-slate-600 dark:text-slate-300">
                    Balance: {formatCurrency(property.balance ?? '0')} · Deposits:{' '}
                    {formatCurrency(property.total_deposits)} ({property.deposit_count}) ·
                    Expenses: {formatCurrency(property.total_expenses)} ({property.expense_count})
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="w-full min-w-0">
        <h4 className="subheading">Recent transactions</h4>
        <div className="mt-2 w-full min-w-0">
          <TransactionTable
            rows={recentOwnerTransactions(detail)}
            emptyMessage="No recent transactions."
            showActions={false}
            onRowClick={onNavigateTransactions}
            className="w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
          />
        </div>
      </div>
    </div>
  );
}

export function OwnersPage() {
  const navigate = useNavigate();
  const { openFeedback } = useFeedback();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });

  const detailQuery = useQuery({
    queryKey: ['owner', expandedId],
    queryFn: () => api.getOwner(expandedId!),
    enabled: !!expandedId,
  });

  if (ownersQuery.isLoading) return <LoadingState />;
  if (ownersQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load property owners. Please try again in a moment."
        error={ownersQuery.error}
      />
    );
  }

  const owners = ownersQuery.data ?? [];

  function toggleExpand(ownerId: string) {
    setExpandedId((current) => (current === ownerId ? null : ownerId));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Property Owners</h2>
        <p className="page-desc">
          View owners, their properties, and aggregated deposit and expense totals. Click a row to
          open filtered transactions, or Details to expand under the row.
        </p>
      </div>

      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Properties linked to this owner.">Properties</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Total deposits across linked properties.">Deposits</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Total expenses across linked properties.">Expenses</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Same as Transactions Balance: Inflow − Expenses across linked properties. Rental income and He/She paid are excluded.">
                    Balance
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {owners.map((owner) => {
                const balance = Number(owner.balance ?? 0);
                const expanded = expandedId === owner.id;
                return (
                  <Fragment key={owner.id}>
                    <tr
                      onClick={() =>
                        navigate('/transactions', {
                          state: ownerTransactionsState(owner.id),
                        })
                      }
                      className={`table-row-link ${expanded ? 'table-row-selected' : ''}`}
                    >
                      <td className="px-5 py-3 font-medium">{owner.name}</td>
                      <td className="px-5 py-3">{owner.property_count}</td>
                      <td className="px-5 py-3">
                        {formatCurrency(owner.total_deposits)}
                        <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                          ({owner.deposit_count})
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {formatCurrency(owner.total_expenses)}
                        <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                          ({owner.expense_count})
                        </span>
                      </td>
                      <td
                        className={`px-5 py-3 font-medium ${
                          balance >= 0 ? 'text-positive' : 'text-negative'
                        }`}
                      >
                        {formatCurrency(owner.balance ?? '0')}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            aria-expanded={expanded}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpand(owner.id);
                            }}
                          >
                            {expanded ? 'Close' : 'Details'}
                          </button>
                          <Tooltip content="Feedback" hideHint>
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={(event) => {
                                event.stopPropagation();
                                openFeedback({
                                  initialMessage: formatOwnerFeedback(owner),
                                });
                              }}
                              aria-label="Send feedback"
                            >
                              {feedbackIcon}
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="bg-slate-50/80 dark:bg-slate-900/40">
                        <td colSpan={OWNER_COL_COUNT} className="w-full px-5 py-4">
                          <OwnerExpandedDetails
                            detail={detailQuery.data}
                            isLoading={detailQuery.isLoading}
                            isError={detailQuery.isError}
                            error={detailQuery.error}
                            onNavigateTransactions={() =>
                              navigate('/transactions', {
                                state: ownerTransactionsState(owner.id),
                              })
                            }
                            onFeedback={(item) =>
                              openFeedback({
                                initialMessage: formatOwnerFeedback(item),
                              })
                            }
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {owners.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No property owners found." />
          </div>
        ) : null}
      </section>
    </div>
  );
}
