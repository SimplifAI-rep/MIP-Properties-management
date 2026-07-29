import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  InlineError,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { useFeedback } from '../context/FeedbackContext';
import type { Property, PropertyDetail } from '../types';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';
import { depositToUnified } from '../utils/unifiedTransaction';
import { getUserErrorMessage } from '../utils/errors';

const PROPERTY_COL_COUNT = 8;

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
    `Balance: ${property.net_balance ?? '0'}`,
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

function statusBadgeClass(status: string) {
  return status === 'active' ? 'badge-deposit' : 'badge-neutral';
}

function PropertyStatusSelect({
  property,
  disabled,
  onChange,
}: {
  property: Pick<Property, 'id' | 'status'>;
  disabled?: boolean;
  onChange: (status: 'active' | 'inactive') => void;
}) {
  const value = property.status === 'active' ? 'active' : 'inactive';
  return (
    <label className="inline-flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
      <span className={`${statusBadgeClass(value)} pointer-events-none`}>
        {value === 'active' ? 'Active' : 'Inactive'}
      </span>
      <select
        className="field py-1 text-xs"
        value={value}
        disabled={disabled}
        aria-label="Property status"
        onChange={(event) => onChange(event.target.value as 'active' | 'inactive')}
        onClick={(event) => event.stopPropagation()}
      >
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>
    </label>
  );
}

function PropertyExpandedDetails({
  detail,
  isLoading,
  isError,
  error,
  statusError,
  statusPending,
  onStatusChange,
  onNavigateTransactions,
  onFeedback,
}: {
  detail: PropertyDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  statusError: unknown;
  statusPending: boolean;
  onStatusChange: (status: 'active' | 'inactive') => void;
  onNavigateTransactions: () => void;
  onFeedback: (property: Property) => void;
}) {
  if (isLoading) {
    return <LoadingState label="Loading property..." />;
  }
  if (isError || !detail) {
    return (
      <ErrorState
        message="We couldn't load this property's details. Please try again."
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
              Incoming:{' '}
              <span className="amount-deposit text-lg font-semibold">
                {formatCurrency(detail.total_incoming ?? '0')}
              </span>
            </span>
            <span className="text-base text-slate-600 dark:text-slate-300">
              Outgoing:{' '}
              <span className="amount-expense text-lg font-semibold">
                {formatCurrency(detail.total_outgoing ?? '0')}
              </span>
            </span>
            <span
              className={`text-lg font-semibold ${
                Number(detail.net_balance ?? 0) >= 0 ? 'amount-deposit' : 'amount-expense'
              }`}
            >
              Balance: {formatCurrency(detail.net_balance ?? '0')}
            </span>
          </div>
          {detail.address ? <p className="muted-text">{detail.address}</p> : null}
          <p className="mt-1 font-mono text-xs text-muted">Prop ID: {detail.client_prop_id}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Link
              to="/transactions"
              state={ownerTransactionsState(detail.owner_id)}
              className="nav-text-link text-sm"
            >
              Owner: {detail.owner.name}
            </Link>
            <div>
              <span className="label-text">Status</span>
              <div className="mt-1">
                <PropertyStatusSelect
                  property={detail}
                  disabled={statusPending}
                  onChange={onStatusChange}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/transactions"
            state={propertyTransactionsState(detail.id, detail.client_prop_id)}
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

      {statusError ? (
        <InlineError
          message={getUserErrorMessage(
            statusError,
            'Could not update property status. Please try again.',
          )}
          error={statusError}
        />
      ) : null}

      <div>
        <h4 className="subheading">
          <Tooltip content="Bank accounts linked for deposit matching.">Bank accounts</Tooltip>
        </h4>
        <ul className="mt-2 flex flex-wrap gap-2 text-sm text-slate-600 dark:text-slate-300">
          {detail.bank_accounts.length === 0 ? (
            <li className="muted-text">No bank accounts linked.</li>
          ) : (
            detail.bank_accounts.map((account) => (
              <li key={account.id} className="list-item-muted">
                <p className="font-medium">{account.bank_name}</p>
                <p>{account.account_number}</p>
              </li>
            ))
          )}
        </ul>
      </div>

      <div className="w-full min-w-0">
        <h4 className="subheading">Recent deposits</h4>
        <div className="mt-2 w-full min-w-0">
          <TransactionTable
            rows={(detail.recent_deposits ?? []).map(depositToUnified)}
            emptyMessage="No recent deposits."
            showActions={false}
            onRowClick={onNavigateTransactions}
            className="w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
          />
        </div>
      </div>
    </div>
  );
}

export function PropertiesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openFeedback } = useFeedback();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const detailQuery = useQuery({
    queryKey: ['property', expandedId],
    queryFn: () => api.getProperty(expandedId!),
    enabled: !!expandedId,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'inactive' }) =>
      api.updatePropertyStatus(id, status),
    onSuccess: (updated) => {
      setStatusError(null);
      queryClient.setQueryData<Property[]>(['properties'], (current) =>
        (current ?? []).map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      queryClient.setQueryData(['property', updated.id], (current: Property | undefined) =>
        current ? { ...current, status: updated.status } : current,
      );
      queryClient.invalidateQueries({ queryKey: ['property', updated.id] });
      queryClient.invalidateQueries({ queryKey: ['owners'] });
    },
    onError: (error) => setStatusError(error),
  });

  function setStatus(property: Pick<Property, 'id' | 'status'>, status: 'active' | 'inactive') {
    if (property.status === status) return;
    statusMutation.mutate({ id: property.id, status });
  }

  function toggleExpand(propertyId: string) {
    setStatusError(null);
    setExpandedId((current) => (current === propertyId ? null : propertyId));
  }

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
          View properties, company-float incoming/outgoing/balance, and linked accounts. Click a row
          to open filtered transactions, or Details to expand under the row.
        </p>
      </div>

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
                  <Tooltip content="Same as Transactions Balance: Inflow − Expenses. Rental income and He/She paid are excluded.">
                    Balance
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Set active or inactive. Data import also refreshes this from the current client list.">
                    Status
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {properties.map((property) => {
                const expanded = expandedId === property.id;
                return (
                  <Fragment key={property.id}>
                    <tr
                      onClick={() =>
                        navigate('/transactions', {
                          state: propertyTransactionsState(property.id, property.client_prop_id),
                        })
                      }
                      className={`table-row-link ${expanded ? 'table-row-selected' : ''}`}
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
                      <td className="px-5 py-3" onClick={(event) => event.stopPropagation()}>
                        <PropertyStatusSelect
                          property={property}
                          disabled={statusMutation.isPending}
                          onChange={(status) => setStatus(property, status)}
                        />
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            className="btn-secondary shrink-0 text-xs"
                            aria-expanded={expanded}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpand(property.id);
                            }}
                          >
                            {expanded ? 'Close' : 'Details'}
                          </button>
                          <Tooltip content="Feedback" hideHint className="inline-flex shrink-0">
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
                    {expanded ? (
                      <tr className="bg-slate-50/80 dark:bg-slate-900/40">
                        <td colSpan={PROPERTY_COL_COUNT} className="w-full px-5 py-4">
                          <PropertyExpandedDetails
                            detail={detailQuery.data}
                            isLoading={detailQuery.isLoading}
                            isError={detailQuery.isError}
                            error={detailQuery.error}
                            statusError={statusError}
                            statusPending={statusMutation.isPending}
                            onStatusChange={(status) => {
                              if (detailQuery.data) setStatus(detailQuery.data, status);
                            }}
                            onNavigateTransactions={() =>
                              navigate('/transactions', {
                                state: propertyTransactionsState(
                                  property.id,
                                  property.client_prop_id,
                                ),
                              })
                            }
                            onFeedback={(item) =>
                              openFeedback({
                                initialMessage: formatPropertyFeedback(item),
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
        {properties.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No properties found. Import client Excel data from Data import." />
          </div>
        ) : null}
      </section>
    </div>
  );
}
