import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DepositFilters } from '../types';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';

function downloadCsv(rows: { [key: string]: string | number | null }[], filename: string) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          const text = value == null ? '' : String(value);
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function DepositsPage() {
  const [filters, setFilters] = useState<DepositFilters>({
    page: 1,
    page_size: 50,
  });

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const depositsQuery = useQuery({
    queryKey: ['deposits', filters],
    queryFn: () => api.getDeposits(filters),
  });

  const totalPages = useMemo(() => {
    if (!depositsQuery.data) return 1;
    return Math.max(1, Math.ceil(depositsQuery.data.total / depositsQuery.data.page_size));
  }, [depositsQuery.data]);

  if (depositsQuery.isLoading) return <LoadingState />;
  if (depositsQuery.isError) {
    return <ErrorState message="Could not load deposits from the API." />;
  }

  const data = depositsQuery.data!;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Deposits</h2>
          <p className="mt-1 text-sm text-slate-500">
            Filter and export imported bank deposit transactions.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              data.items.map((deposit) => ({
                date: deposit.transaction_date,
                property: deposit.property_name,
                owner: deposit.owner_name,
                account: deposit.account_number,
                amount: deposit.amount,
                currency: deposit.currency,
                reference: deposit.reference,
                description: deposit.description,
              })),
              'deposits.csv',
            )
          }
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Export CSV
        </button>
      </div>

      <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Property</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.property_id ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                property_id: event.target.value || undefined,
                page: 1,
              }))
            }
          >
            <option value="">All properties</option>
            {(propertiesQuery.data ?? []).map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Owner</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.owner_id ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                owner_id: event.target.value || undefined,
                page: 1,
              }))
            }
          >
            <option value="">All owners</option>
            {(ownersQuery.data ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">From date</span>
          <input
            type="date"
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.date_from ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                date_from: event.target.value || undefined,
                page: 1,
              }))
            }
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">To date</span>
          <input
            type="date"
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.date_to ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                date_to: event.target.value || undefined,
                page: 1,
              }))
            }
          />
        </label>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Property</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">Account</th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((deposit) => (
                <tr key={deposit.id} className="border-t border-slate-100">
                  <td className="px-5 py-3">{formatDate(deposit.transaction_date)}</td>
                  <td className="px-5 py-3 font-medium">{deposit.property_name}</td>
                  <td className="px-5 py-3">{deposit.owner_name}</td>
                  <td className="px-5 py-3">{deposit.account_number}</td>
                  <td className="px-5 py-3">{formatCurrency(deposit.amount, deposit.currency)}</td>
                  <td className="px-5 py-3 text-slate-500">{deposit.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.items.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No deposits match the current filters." />
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-500">
          <span>
            Showing {data.items.length} of {data.total} deposits
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={filters.page === 1}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: Math.max(1, (current.page ?? 1) - 1),
                }))
              }
              className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              Page {filters.page ?? 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={(filters.page ?? 1) >= totalPages}
              onClick={() =>
                setFilters((current) => ({
                  ...current,
                  page: (current.page ?? 1) + 1,
                }))
              }
              className="rounded-lg border border-slate-300 px-3 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
