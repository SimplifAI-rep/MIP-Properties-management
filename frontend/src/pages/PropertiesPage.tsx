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
        <h2 className="page-heading">Properties</h2>
        <p className="page-desc">View properties, linked bank accounts, and recent deposits.</p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <section className="panel">
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">ID</th>
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
                    className={`table-row-interactive ${
                      selectedId === property.id ? 'table-row-selected' : ''
                    }`}
                  >
                    <td className="px-5 py-3 font-mono text-xs">{property.client_prop_id}</td>
                    <td className="px-5 py-3 font-medium">
                      {property.name}
                      {property.city ? (
                        <span className="mt-0.5 block text-xs font-normal opacity-70">{property.city}</span>
                      ) : null}
                    </td>
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
              <EmptyState message="No properties found. Import client Excel data from Data import." />
            </div>
          ) : null}
        </section>

        <aside className="panel-padded">
          {!selectedId ? (
            <p className="muted-text">Select a property to view details.</p>
          ) : detailQuery.isLoading ? (
            <LoadingState label="Loading property..." />
          ) : detailQuery.isError || !detailQuery.data ? (
            <ErrorState message="Could not load property details." />
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="detail-title">{detailQuery.data.name}</h3>
                <p className="muted-text">{detailQuery.data.address}</p>
              </div>
              <Card title="Owner" value={detailQuery.data.owner.name} />
              <div>
                <h4 className="subheading">Bank Accounts</h4>
                <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                  {detailQuery.data.bank_accounts.map((account) => (
                    <li key={account.id} className="list-item-muted">
                      <p className="font-medium">{account.bank_name}</p>
                      <p>{account.account_number}</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="subheading">Recent Deposits</h4>
                <ul className="mt-2 space-y-2 text-sm">
                  {detailQuery.data.recent_deposits.map((deposit) => (
                    <li key={deposit.id} className="list-item">
                      <p className="font-medium">{formatCurrency(deposit.amount)}</p>
                      <p className="muted-text">
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
