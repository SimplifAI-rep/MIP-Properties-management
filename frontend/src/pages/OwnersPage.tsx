import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { useFeedback } from '../context/FeedbackContext';
import type { OwnerSummary } from '../types';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';

function formatOwnerFeedback(owner: OwnerSummary): string {
  return [
    'Feedback about this owner:',
    `Owner: ${owner.name}`,
    `Owner ID: ${owner.id}`,
    `Properties: ${owner.property_count}`,
    `Deposits: ${owner.total_deposits} (${owner.deposit_count})`,
    `Expenses: ${owner.total_expenses} (${owner.expense_count})`,
  ].join('\n');
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

export function OwnersPage() {
  const navigate = useNavigate();
  const { openFeedback } = useFeedback();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });

  const detailQuery = useQuery({
    queryKey: ['owner', selectedId],
    queryFn: () => api.getOwner(selectedId!),
    enabled: !!selectedId,
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Property Owners</h2>
        <p className="page-desc">
          View owners, their properties, and aggregated deposit and expense totals. Click a row to
          open filtered transactions.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
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
                    <Tooltip content="Deposits minus expenses.">Net</Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => {
                  const net =
                    Number(owner.total_deposits) - Number(owner.total_expenses);
                  return (
                    <tr
                      key={owner.id}
                      onClick={() =>
                        navigate('/transactions', {
                          state: ownerTransactionsState(owner.id),
                        })
                      }
                      className={`table-row-link ${
                        selectedId === owner.id ? 'table-row-selected' : ''
                      }`}
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
                          net >= 0 ? 'text-positive' : 'text-negative'
                        }`}
                      >
                        {formatCurrency(net)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(owner.id);
                            }}
                          >
                            Details
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

        <aside className="panel-padded">
          {!selectedId ? (
            <p className="muted-text">
              Click a row to open transactions, or Details to preview here.
            </p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading owner..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState
              message="We couldn't load this owner's details. Please try again."
              error={detailQuery.error}
              report={detailQuery.isError}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="detail-title">{detailQuery.data.name}</h3>
                {detailQuery.data.contact_email ? (
                  <p className="muted-text">{detailQuery.data.contact_email}</p>
                ) : null}
                {detailQuery.data.contact_phone ? (
                  <p className="muted-text">{detailQuery.data.contact_phone}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Link
                  to="/transactions"
                  state={ownerTransactionsState(detailQuery.data.id)}
                  className="btn-primary inline-flex"
                >
                  View transactions
                </Link>
                <Tooltip content="Feedback" hideHint>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() =>
                      openFeedback({
                        initialMessage: formatOwnerFeedback(detailQuery.data),
                      })
                    }
                    aria-label="Send feedback"
                  >
                    {feedbackIcon}
                  </button>
                </Tooltip>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Card
                  title="Properties"
                  value={String(detailQuery.data.property_count)}
                  tooltip="Properties linked to this owner."
                />
                <Link
                  to="/transactions"
                  state={ownerTransactionsState(detailQuery.data.id)}
                  className="block"
                >
                  <Card
                    title="Total deposits"
                    value={formatCurrency(detailQuery.data.total_deposits)}
                    subtitle={`${detailQuery.data.deposit_count} transactions`}
                    tooltip="Total deposits across linked properties."
                  />
                </Link>
                <Link
                  to="/transactions"
                  state={ownerTransactionsState(detailQuery.data.id)}
                  className="block"
                >
                  <Card
                    title="Total expenses"
                    value={formatCurrency(detailQuery.data.total_expenses)}
                    subtitle={`${detailQuery.data.expense_count} transactions`}
                    tooltip="Total expenses across linked properties."
                  />
                </Link>
                <Link
                  to="/transactions"
                  state={ownerTransactionsState(detailQuery.data.id)}
                  className="block"
                >
                  <Card
                    title="Net"
                    value={formatCurrency(
                      Number(detailQuery.data.total_deposits) -
                        Number(detailQuery.data.total_expenses),
                    )}
                    tooltip="Deposits minus expenses."
                  />
                </Link>
              </div>

              <div>
                <h4 className="subheading">Properties</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.properties.map((property) => (
                    <li key={property.id}>
                      <Link
                        to="/transactions"
                        state={propertyTransactionsState(property.id, property.client_prop_id)}
                        className="list-item block hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      >
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {property.name}
                        </p>
                        {property.address ? (
                          <p className="muted-text">{property.address}</p>
                        ) : null}
                        <p className="mt-1 text-slate-600 dark:text-slate-300">
                          Deposits: {formatCurrency(property.total_deposits)} (
                          {property.deposit_count}) · Expenses:{' '}
                          {formatCurrency(property.total_expenses)} ({property.expense_count})
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
