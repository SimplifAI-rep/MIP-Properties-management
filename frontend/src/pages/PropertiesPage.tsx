import { useState } from 'react';
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

export function PropertiesPage() {
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
    return <ErrorState message="Could not load properties from the API." />;
  }

  const properties = propertiesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Properties</h2>
        <p className="mt-1 text-sm text-slate-500">
          View properties, linked bank accounts, and recent deposits.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Property</th>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Deposits</th>
                  <th className="px-5 py-3 font-medium">Total</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {properties.map((property) => (
                  <tr
                    key={property.id}
                    onClick={() => setSelectedId(property.id)}
                    className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                      selectedId === property.id ? 'bg-slate-50' : ''
                    }`}
                  >
                    <td className="px-5 py-3 font-medium">{property.name}</td>
                    <td className="px-5 py-3">{property.owner_name}</td>
                    <td className="px-5 py-3">{property.deposit_count}</td>
                    <td className="px-5 py-3">{formatCurrency(property.total_deposits)}</td>
                    <td className="px-5 py-3 capitalize">{property.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {properties.length === 0 ? (
            <div className="p-5">
              <EmptyState message="No properties found. Run the seed and import scripts first." />
            </div>
          ) : null}
        </section>

        <aside className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {!selectedId ? (
            <p className="text-sm text-slate-500">Select a property to view details.</p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading property..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState message="Could not load property details." />
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{detailQuery.data.name}</h3>
                <p className="text-sm text-slate-500">{detailQuery.data.address}</p>
              </div>
              <Card title="Owner" value={detailQuery.data.owner.name} />
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Bank Accounts</h4>
                <ul className="mt-2 space-y-2 text-sm text-slate-600">
                  {detailQuery.data.bank_accounts.map((account) => (
                    <li key={account.id} className="rounded-lg bg-slate-50 px-3 py-2">
                      <p className="font-medium">{account.bank_name}</p>
                      <p>{account.account_number}</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Recent Deposits</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.recent_deposits.map((deposit) => (
                    <li key={deposit.id} className="rounded-lg border border-slate-100 px-3 py-2">
                      <p className="font-medium">{formatCurrency(deposit.amount)}</p>
                      <p className="text-slate-500">
                        {formatDate(deposit.transaction_date)} · {deposit.description}
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
