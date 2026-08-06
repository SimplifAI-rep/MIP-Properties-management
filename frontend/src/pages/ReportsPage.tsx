import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  LoadingState,
} from '../components/ui/States';
import { MoneyValue } from '../components/ui/MoneyValue';
import { Tooltip } from '../components/ui/Tooltip';

type ReportView = 'owners' | 'properties';

export function ReportsPage() {
  const [view, setView] = useState<ReportView>('owners');

  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const owners = useMemo(
    () =>
      [...(ownersQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [ownersQuery.data],
  );

  const properties = useMemo(
    () =>
      [...(propertiesQuery.data ?? [])].sort((a, b) =>
        a.client_prop_id.localeCompare(b.client_prop_id, undefined, {
          sensitivity: 'base',
        }),
      ),
    [propertiesQuery.data],
  );

  const isLoading = ownersQuery.isLoading || propertiesQuery.isLoading;
  const isError = ownersQuery.isError || propertiesQuery.isError;

  if (isLoading) return <LoadingState />;
  if (isError) {
    return (
      <ErrorState
        message="We couldn't load report data. Please try again."
        error={ownersQuery.error ?? propertiesQuery.error}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">
          <Tooltip content="High-level summaries by owner and property. More report types will be added later.">
            Reports
          </Tooltip>
        </h2>
        <p className="page-desc">
          Basic balances and activity totals. Expandable reporting comes later.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={view === 'owners' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setView('owners')}
        >
          By owner
        </button>
        <button
          type="button"
          className={view === 'properties' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setView('properties')}
        >
          By property
        </button>
      </div>

      {view === 'owners' ? (
        <section className="panel overflow-hidden">
          {owners.length === 0 ? (
            <EmptyState message="No owners to report on yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead className="table-head">
                  <tr>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 font-medium">Properties</th>
                    <th className="px-4 py-2 font-medium">Deposits</th>
                    <th className="px-4 py-2 font-medium">Expenses</th>
                    <th className="px-4 py-2 font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {owners.map((owner) => (
                    <tr key={owner.id} className="table-row">
                      <td className="px-4 py-2">
                        <Link
                          to="/owners"
                          className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                        >
                          {owner.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{owner.property_count}</td>
                      <td className="px-4 py-2 amount-deposit">
                        {formatCurrency(owner.total_deposits)}
                        <span className="ml-1 muted-text">({owner.deposit_count})</span>
                      </td>
                      <td className="px-4 py-2 amount-expense">
                        {formatCurrency(owner.total_expenses)}
                        <span className="ml-1 muted-text">({owner.expense_count})</span>
                      </td>
                      <td
                        className="px-4 py-2"
                      >
                        <MoneyValue amount={owner.balance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="panel overflow-hidden">
          {properties.length === 0 ? (
            <EmptyState message="No properties to report on yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead className="table-head">
                  <tr>
                    <th className="px-4 py-2 font-medium">Prop ID</th>
                    <th className="px-4 py-2 font-medium">Property</th>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 font-medium">Incoming</th>
                    <th className="px-4 py-2 font-medium">Outgoing</th>
                    <th className="px-4 py-2 font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {properties.map((property) => (
                    <tr key={property.id} className="table-row">
                      <td className="px-4 py-2 font-medium">{property.client_prop_id}</td>
                      <td className="px-4 py-2">
                        <Link
                          to="/properties"
                          className="font-medium text-slate-900 hover:underline dark:text-slate-100"
                        >
                          {property.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{property.owner_name}</td>
                      <td className="px-4 py-2 amount-deposit">
                        {formatCurrency(property.total_incoming ?? property.total_deposits)}
                      </td>
                      <td className="px-4 py-2 amount-expense">
                        {formatCurrency(property.total_outgoing ?? '0')}
                      </td>
                      <td className="px-4 py-2">
                        <MoneyValue amount={property.net_balance ?? '0'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
