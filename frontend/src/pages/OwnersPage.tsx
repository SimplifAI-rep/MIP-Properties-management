import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import { EntityFeedbackButton } from '../components/ui/EntityFeedbackButton';
import { MoneyValue } from '../components/ui/MoneyValue';
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import type { OwnerDetail, OwnerSummary } from '../types';
import { getUserErrorMessage } from '../utils/errors';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';
import { mergeAndSortTransactions } from '../utils/transactionView';

const OWNER_COL_COUNT = 7;

type OwnerStatusFilter = 'active' | 'inactive';

function formatOwnerFeedback(owner: OwnerSummary): string {
  return [
    'Feedback about this owner:',
    `Owner: ${owner.name}`,
    `Owner ID: ${owner.id}`,
    `Status: ${owner.status === 'inactive' ? 'Inactive' : 'Active'}`,
    `Properties: ${owner.property_count}`,
    `Deposits: ${owner.total_deposits} (${owner.deposit_count})`,
    `Expenses: ${owner.total_expenses} (${owner.expense_count})`,
    `Balance: ${owner.balance}`,
  ].join('\n');
}

function isOwnerInactive(owner: OwnerSummary): boolean {
  return owner.status === 'inactive';
}

function recentOwnerTransactions(detail: OwnerDetail) {
  return mergeAndSortTransactions(
    detail.recent_deposits ?? [],
    detail.recent_expenses ?? [],
    5,
  );
}

function OwnerExpandedDetails({
  detail,
  isLoading,
  isError,
  error,
  onNavigateTransactions,
}: {
  detail: OwnerDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onNavigateTransactions: () => void;
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
            {isOwnerInactive(detail) ? (
              <span className="badge-neutral" title="All linked properties are inactive">
                Inactive
              </span>
            ) : null}
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
            <span className="text-lg font-semibold">
              Balance: <MoneyValue amount={detail.balance ?? '0'} />
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
          <EntityFeedbackButton message={formatOwnerFeedback(detail)} />
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
                    Balance: <MoneyValue amount={property.balance ?? '0'} /> · Deposits:{' '}
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
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ownerFilterIds, setOwnerFilterIds] = useState<string[]>([]);
  const [ownerStatuses, setOwnerStatuses] = useState<OwnerStatusFilter[]>(['active']);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });

  const createMutation = useMutation({
    mutationFn: api.createOwner,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['owners'] });
      setNewName('');
      setNewEmail('');
      setNewPhone('');
      setCreateMessage(`Added ${created.name}.`);
      setCreateError(null);
    },
    onError: (error) => {
      setCreateError(getUserErrorMessage(error));
      setCreateMessage(null);
    },
  });

  const detailQuery = useQuery({
    queryKey: ['owner', expandedId],
    queryFn: () => api.getOwner(expandedId!),
    enabled: !!expandedId,
  });

  const allOwners = ownersQuery.data ?? [];
  const statusFilteredOwners = useMemo(() => {
    if (ownerStatuses.length === 0 || ownerStatuses.length === 2) return allOwners;
    const status = ownerStatuses[0];
    return allOwners.filter((owner) =>
      status === 'inactive' ? isOwnerInactive(owner) : !isOwnerInactive(owner),
    );
  }, [allOwners, ownerStatuses]);
  const ownerOptions = useMemo(
    () =>
      statusFilteredOwners.map((owner) => ({
        value: owner.id,
        label: isOwnerInactive(owner) ? `${owner.name} (inactive)` : owner.name,
      })),
    [statusFilteredOwners],
  );
  const owners = useMemo(() => {
    if (!ownerFilterIds.length) return statusFilteredOwners;
    const selected = new Set(ownerFilterIds);
    return statusFilteredOwners.filter((owner) => selected.has(owner.id));
  }, [statusFilteredOwners, ownerFilterIds]);

  const ownerStatusOptions = useMemo(
    () => [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
    [],
  );

  if (ownersQuery.isLoading) return <LoadingState />;
  if (ownersQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load property owners. Please try again in a moment."
        error={ownersQuery.error}
      />
    );
  }

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

      <section className="panel p-4 sm:p-5 space-y-3">
        <h3 className="section-title text-sm">Add an owner</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="text-sm">
            <span className="label-text">Name</span>
            <input
              className="field"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Owner name"
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Email (optional)</span>
            <input
              className="field"
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Phone (optional)</span>
            <input
              className="field"
              value={newPhone}
              onChange={(event) => setNewPhone(event.target.value)}
              placeholder="Phone"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-primary"
              disabled={createMutation.isPending}
              onClick={() => {
                const name = newName.trim();
                if (!name) {
                  setCreateError('Enter an owner name.');
                  setCreateMessage(null);
                  return;
                }
                createMutation.mutate({
                  name,
                  contact_email: newEmail.trim() || null,
                  contact_phone: newPhone.trim() || null,
                });
              }}
            >
              {createMutation.isPending ? 'Adding…' : 'Add owner'}
            </button>
          </div>
        </div>
        {createMessage ? <p className="text-sm text-positive">{createMessage}</p> : null}
        {createError ? <p className="text-sm text-negative">{createError}</p> : null}
      </section>

      <div className="filter-panel max-w-3xl md:grid-cols-2">
        <SearchableMultiSelect
          label="Owner status"
          tip="Active owners have at least one active property. Inactive means every linked property is inactive."
          options={ownerStatusOptions}
          selected={ownerStatuses}
          onChange={(next) => {
            setOwnerStatuses(next as OwnerStatusFilter[]);
            setOwnerFilterIds([]);
          }}
          placeholder="All statuses"
          searchPlaceholder="Search status…"
        />
        <SearchableMultiSelect
          label="Filter owners"
          tip="Show only selected owners in the table."
          options={ownerOptions}
          selected={ownerFilterIds}
          onChange={setOwnerFilterIds}
          placeholder="All owners"
          searchPlaceholder="Search owner…"
        />
      </div>

      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Inactive only when every linked property is inactive.">
                    Status
                  </Tooltip>
                </th>
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
                const expanded = expandedId === owner.id;
                const inactive = isOwnerInactive(owner);
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
                      <td className="px-5 py-3">
                        {inactive ? (
                          <span
                            className="badge-neutral"
                            title="All linked properties are inactive"
                          >
                            Inactive
                          </span>
                        ) : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
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
                      <td className="px-5 py-3 font-medium">
                        <MoneyValue amount={owner.balance ?? '0'} />
                      </td>
                      <td className="px-5 py-3">
                        <div
                          className="flex flex-wrap items-center gap-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            aria-expanded={expanded}
                            onClick={() => toggleExpand(owner.id)}
                          >
                            {expanded ? 'Close' : 'Details'}
                          </button>
                          <EntityFeedbackButton message={formatOwnerFeedback(owner)} />
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
