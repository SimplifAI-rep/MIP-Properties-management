import { useState } from 'react';
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

export function OwnersPage() {
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
    return <ErrorState message="Could not load property owners from the API." />;
  }

  const owners = ownersQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Property Owners</h2>
        <p className="page-desc">
          View owners, their properties, and aggregated deposit and expense totals.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <section className="panel">
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
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => {
                  const net =
                    Number(owner.total_deposits) - Number(owner.total_expenses);
                  return (
                    <tr
                      key={owner.id}
                      onClick={() => setSelectedId(owner.id)}
                      className={`table-row-interactive ${
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
            <p className="muted-text">Select an owner to view details.</p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading owner..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState message="Could not load owner details." />
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

              <div className="grid gap-3 sm:grid-cols-2">
                <Card
                  title="Properties"
                  value={String(detailQuery.data.property_count)}
                  tooltip="Properties linked to this owner."
                />
                <Card
                  title="Total deposits"
                  value={formatCurrency(detailQuery.data.total_deposits)}
                  subtitle={`${detailQuery.data.deposit_count} transactions`}
                  tooltip="Total deposits across linked properties."
                />
                <Card
                  title="Total expenses"
                  value={formatCurrency(detailQuery.data.total_expenses)}
                  subtitle={`${detailQuery.data.expense_count} transactions`}
                  tooltip="Total expenses across linked properties."
                />
                <Card
                  title="Net"
                  value={formatCurrency(
                    Number(detailQuery.data.total_deposits) -
                      Number(detailQuery.data.total_expenses),
                  )}
                  tooltip="Deposits minus expenses."
                />
              </div>

              <div>
                <h4 className="subheading">Properties</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.properties.map((property) => (
                    <li key={property.id} className="list-item">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {property.name}
                      </p>
                      {property.address ? (
                        <p className="muted-text">{property.address}</p>
                      ) : null}
                      <p className="mt-1 text-slate-600 dark:text-slate-300">
                        Deposits: {formatCurrency(property.total_deposits)} ({property.deposit_count})
                        · Expenses: {formatCurrency(property.total_expenses)} ({property.expense_count})
                      </p>
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
