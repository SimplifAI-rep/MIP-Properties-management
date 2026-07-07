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
        <h2 className="text-2xl font-bold text-slate-900">Property Owners</h2>
        <p className="mt-1 text-sm text-slate-500">
          View owners, their properties, and aggregated deposit and expense totals.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Properties</th>
                  <th className="px-5 py-3 font-medium">Deposits</th>
                  <th className="px-5 py-3 font-medium">Expenses</th>
                  <th className="px-5 py-3 font-medium">Net</th>
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
                      className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                        selectedId === owner.id ? 'bg-slate-50' : ''
                      }`}
                    >
                      <td className="px-5 py-3 font-medium">{owner.name}</td>
                      <td className="px-5 py-3">{owner.property_count}</td>
                      <td className="px-5 py-3">
                        {formatCurrency(owner.total_deposits)}
                        <span className="ml-1 text-xs text-slate-400">
                          ({owner.deposit_count})
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {formatCurrency(owner.total_expenses)}
                        <span className="ml-1 text-xs text-slate-400">
                          ({owner.expense_count})
                        </span>
                      </td>
                      <td
                        className={`px-5 py-3 font-medium ${
                          net >= 0 ? 'text-emerald-700' : 'text-red-600'
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

        <aside className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {!selectedId ? (
            <p className="text-sm text-slate-500">Select an owner to view details.</p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading owner..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState message="Could not load owner details." />
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{detailQuery.data.name}</h3>
                {detailQuery.data.contact_email ? (
                  <p className="text-sm text-slate-500">{detailQuery.data.contact_email}</p>
                ) : null}
                {detailQuery.data.contact_phone ? (
                  <p className="text-sm text-slate-500">{detailQuery.data.contact_phone}</p>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Card title="Properties" value={String(detailQuery.data.property_count)} />
                <Card
                  title="Total deposits"
                  value={formatCurrency(detailQuery.data.total_deposits)}
                  subtitle={`${detailQuery.data.deposit_count} transactions`}
                />
                <Card
                  title="Total expenses"
                  value={formatCurrency(detailQuery.data.total_expenses)}
                  subtitle={`${detailQuery.data.expense_count} transactions`}
                />
                <Card
                  title="Net"
                  value={formatCurrency(
                    Number(detailQuery.data.total_deposits) -
                      Number(detailQuery.data.total_expenses),
                  )}
                />
              </div>

              <div>
                <h4 className="text-sm font-semibold text-slate-700">Properties</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.properties.map((property) => (
                    <li
                      key={property.id}
                      className="rounded-lg border border-slate-100 px-3 py-2"
                    >
                      <p className="font-medium text-slate-900">{property.name}</p>
                      {property.address ? (
                        <p className="text-slate-500">{property.address}</p>
                      ) : null}
                      <p className="mt-1 text-slate-600">
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
