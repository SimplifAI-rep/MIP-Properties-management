import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { useFeedback } from '../context/FeedbackContext';
import type { Property } from '../types';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';

function formatPropertyFeedback(property: Property): string {
  return [
    'Feedback about this property:',
    `Property: ${property.name}`,
    `Prop ID: ${property.client_prop_id}`,
    `Property UUID: ${property.id}`,
    `Owner: ${property.owner_name}`,
    `Status: ${property.status}`,
    `Incoming: ${property.total_incoming ?? '0'}`,
    `Outgoing: ${property.total_outgoing ?? '0'}`,
    `Net: ${property.net_balance ?? '0'}`,
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

export function PropertiesPage() {
  const navigate = useNavigate();
  const { openFeedback } = useFeedback();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const detailQuery = useQuery({
    queryKey: ['property', selectedId],
    queryFn: () => api.getProperty(selectedId!),
    enabled: !!selectedId,
  });

  if (propertiesQuery.isLoading) return <LoadingState />;
  if (propertiesQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load properties. Please try again in a moment."
        error={propertiesQuery.error}
      />
    );
  }

  const properties = propertiesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Properties</h2>
        <p className="page-desc">
          View properties, company-float incoming/outgoing/net, and linked accounts. Click a row to
          open filtered transactions.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <section className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">
                    <Tooltip content="Client property ID from the source files.">ID</Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium">Property</th>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">
                    <Tooltip content="Company-float deposits (excludes rental income).">
                      Incoming
                    </Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium">
                    <Tooltip content="Company-float expenses (excludes resident/owner paid).">
                      Outgoing
                    </Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium">
                    <Tooltip content="Incoming minus outgoing.">Net</Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium">
                    <Tooltip content="Active or inactive in the imported client data.">
                      Status
                    </Tooltip>
                  </th>
                  <th className="px-5 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {properties.map((property) => (
                  <tr
                    key={property.id}
                    onClick={() =>
                      navigate('/transactions', {
                        state: propertyTransactionsState(property.id, property.client_prop_id),
                      })
                    }
                    className={`table-row-link ${
                      selectedId === property.id ? 'table-row-selected' : ''
                    }`}
                  >
                    <td className="px-5 py-3 font-mono text-xs">{property.client_prop_id}</td>
                    <td className="px-5 py-3 font-medium">
                      {property.name}
                      {property.city ? (
                        <span className="mt-0.5 block text-xs font-normal opacity-70">
                          {property.city}
                        </span>
                      ) : null}
                    </td>
                    <td
                      className="px-5 py-3"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate('/transactions', {
                          state: ownerTransactionsState(property.owner_id),
                        });
                      }}
                    >
                      <span className="nav-text-link">{property.owner_name}</span>
                    </td>
                    <td className="px-5 py-3 amount-deposit">
                      {formatCurrency(property.total_incoming ?? '0')}
                    </td>
                    <td className="px-5 py-3 amount-expense">
                      {formatCurrency(property.total_outgoing ?? '0')}
                    </td>
                    <td
                      className={`px-5 py-3 font-medium ${
                        Number(property.net_balance ?? 0) >= 0
                          ? 'amount-deposit'
                          : 'amount-expense'
                      }`}
                    >
                      {formatCurrency(property.net_balance ?? '0')}
                    </td>
                    <td className="px-5 py-3 capitalize">{property.status}</td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          className="btn-secondary text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(property.id);
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
                                initialMessage: formatPropertyFeedback(property),
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
                ))}
              </tbody>
            </table>
          </div>
          {properties.length === 0 ? (
            <div className="p-5">
              <EmptyState message="No properties found. Import client Excel data from Data import." />
            </div>
          ) : null}
        </section>

        <aside className="panel-padded">
          {!selectedId ? (
            <p className="muted-text">
              Click a row to open transactions, or Details to preview here.
            </p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading property..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState
              message="We couldn't load this property's details. Please try again."
              error={detailQuery.error}
              report={detailQuery.isError}
            />
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="detail-title">{detailQuery.data.name}</h3>
                <p className="muted-text">{detailQuery.data.address}</p>
                <p className="mt-1 font-mono text-xs text-muted">
                  Prop ID: {detailQuery.data.client_prop_id}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/transactions"
                  state={propertyTransactionsState(
                    detailQuery.data.id,
                    detailQuery.data.client_prop_id,
                  )}
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
                        initialMessage: formatPropertyFeedback(detailQuery.data),
                      })
                    }
                    aria-label="Send feedback"
                  >
                    {feedbackIcon}
                  </button>
                </Tooltip>
              </div>
              <Link
                to="/transactions"
                state={ownerTransactionsState(detailQuery.data.owner_id)}
                className="block"
              >
                <Card title="Owner" value={detailQuery.data.owner.name} />
              </Link>
              <div className="grid gap-3 sm:grid-cols-1">
                <Link
                  to="/transactions"
                  state={propertyTransactionsState(
                    detailQuery.data.id,
                    detailQuery.data.client_prop_id,
                    null,
                    'deposit',
                  )}
                  className="block"
                >
                  <Card
                    title="Incoming"
                    value={formatCurrency(detailQuery.data.total_incoming ?? '0')}
                    tooltip="Company-float deposits (excludes rental income)."
                  />
                </Link>
                <Link
                  to="/transactions"
                  state={propertyTransactionsState(
                    detailQuery.data.id,
                    detailQuery.data.client_prop_id,
                    null,
                    'expense',
                  )}
                  className="block"
                >
                  <Card
                    title="Outgoing"
                    value={formatCurrency(detailQuery.data.total_outgoing ?? '0')}
                    tooltip="Company-float expenses (excludes resident/owner paid)."
                  />
                </Link>
                <Link
                  to="/transactions"
                  state={propertyTransactionsState(
                    detailQuery.data.id,
                    detailQuery.data.client_prop_id,
                  )}
                  className="block"
                >
                  <Card
                    title="Net"
                    value={formatCurrency(detailQuery.data.net_balance ?? '0')}
                    tooltip="Incoming minus outgoing."
                  />
                </Link>
              </div>
              <div>
                <h4 className="subheading">
                  <Tooltip content="Bank accounts linked for deposit matching.">
                    Bank Accounts
                  </Tooltip>
                </h4>
                <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                  {detailQuery.data.bank_accounts.length === 0 ? (
                    <li className="muted-text">No bank accounts linked.</li>
                  ) : (
                    detailQuery.data.bank_accounts.map((account) => (
                      <li key={account.id} className="list-item-muted">
                        <p className="font-medium">{account.bank_name}</p>
                        <p>{account.account_number}</p>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <h4 className="subheading">Recent Deposits</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.recent_deposits.length === 0 ? (
                    <li className="muted-text">No recent deposits.</li>
                  ) : (
                    detailQuery.data.recent_deposits.map((deposit) => (
                      <li key={deposit.id}>
                        <Link
                          to="/transactions"
                          state={propertyTransactionsState(
                            detailQuery.data.id,
                            detailQuery.data.client_prop_id,
                          )}
                          className="list-item block hover:bg-slate-50 dark:hover:bg-slate-800/60"
                        >
                          <p className="font-medium">{formatCurrency(deposit.amount)}</p>
                          <p className="muted-text">
                            {formatDate(deposit.transaction_date)} · {deposit.description}
                          </p>
                        </Link>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
