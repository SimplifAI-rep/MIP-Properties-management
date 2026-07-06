import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ExpenseCreate, ExpenseFilters } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';

const CATEGORIES = [
  'maintenance',
  'tax',
  'insurance',
  'utilities',
  'management_fee',
  'other',
] as const;

const SOURCES = [
  'standing_order',
  'credit_card',
  'manual_owner',
  'manual_company',
] as const;

const PAYMENT_METHODS = [
  'bank_direct_debit',
  'credit_card',
  'bank_transfer',
  'owner_personal',
  'company_account',
] as const;

function label(value: string) {
  return value.replace(/_/g, ' ');
}

const emptyForm: ExpenseCreate = {
  property_id: '',
  transaction_date: '',
  amount: '',
  category: 'maintenance',
  source: 'manual_company',
  payment_method: 'company_account',
  description: '',
};

export function ExpensesPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ExpenseFilters>({
    page: 1,
    page_size: 50,
  });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ExpenseCreate>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const summaryQuery = useQuery({
    queryKey: ['expense-summary'],
    queryFn: api.getExpenseSummary,
  });
  const expensesQuery = useQuery({
    queryKey: ['expenses', filters],
    queryFn: () => api.getExpenses(filters),
  });

  const createMutation = useMutation({
    mutationFn: api.createExpense,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      setForm(emptyForm);
      setShowForm(false);
      setFormError(null);
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const totalPages = useMemo(() => {
    if (!expensesQuery.data) return 1;
    return Math.max(1, Math.ceil(expensesQuery.data.total / expensesQuery.data.page_size));
  }, [expensesQuery.data]);

  if (expensesQuery.isLoading) return <LoadingState />;
  if (expensesQuery.isError) {
    return <ErrorState message="Could not load expenses from the API." />;
  }

  const data = expensesQuery.data!;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Expenses</h2>
          <p className="mt-1 text-sm text-slate-500">
            Track property expenses by category, source, and payment method.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((current) => !current)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {showForm ? 'Cancel' : 'Add expense'}
        </button>
      </div>

      {summaryQuery.data ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card
            title="Total expenses"
            value={formatCurrency(summaryQuery.data.total_amount)}
            subtitle={`${summaryQuery.data.expense_count} transactions`}
          />
          <Card
            title="Properties with expenses"
            value={String(summaryQuery.data.property_count)}
            subtitle="Across all categories"
          />
          {summaryQuery.data.by_category.slice(0, 2).map((row) => (
            <Card
              key={row.category}
              title={label(row.category)}
              value={formatCurrency(row.total_amount)}
              subtitle={`${row.expense_count} expense(s)`}
            />
          ))}
        </section>
      ) : null}

      {showForm ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700">New manual expense</h3>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!form.property_id || !form.transaction_date || !form.amount) {
                setFormError('Property, date, and amount are required.');
                return;
              }
              createMutation.mutate(form);
            }}
          >
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Property</span>
              <select
                required
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.property_id}
                onChange={(event) =>
                  setForm((current) => ({ ...current, property_id: event.target.value }))
                }
              >
                <option value="">Select property</option>
                {(propertiesQuery.data ?? []).map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Date</span>
              <input
                required
                type="date"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.transaction_date}
                onChange={(event) =>
                  setForm((current) => ({ ...current, transaction_date: event.target.value }))
                }
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Amount (ILS)</span>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.amount}
                onChange={(event) =>
                  setForm((current) => ({ ...current, amount: event.target.value }))
                }
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Category</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {label(category)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Source</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.source}
                onChange={(event) =>
                  setForm((current) => ({ ...current, source: event.target.value }))
                }
              >
                {SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {label(source)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">Payment method</span>
              <select
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.payment_method}
                onChange={(event) =>
                  setForm((current) => ({ ...current, payment_method: event.target.value }))
                }
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {label(method)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2 xl:col-span-3">
              <span className="mb-1 block text-slate-500">Description</span>
              <input
                type="text"
                className="w-full rounded-lg border border-slate-300 px-3 py-2"
                value={form.description ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            {formError ? (
              <p className="text-sm text-red-600 md:col-span-2 xl:col-span-3">{formError}</p>
            ) : null}
            <div className="md:col-span-2 xl:col-span-3">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {createMutation.isPending ? 'Saving...' : 'Save expense'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-5">
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
          <span className="mb-1 block text-slate-500">Category</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.category ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                category: event.target.value || undefined,
                page: 1,
              }))
            }
          >
            <option value="">All categories</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {label(category)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Source</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.source ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                source: event.target.value || undefined,
                page: 1,
              }))
            }
          >
            <option value="">All sources</option>
            {SOURCES.map((source) => (
              <option key={source} value={source}>
                {label(source)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">Payment method</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2"
            value={filters.payment_method ?? ''}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                payment_method: event.target.value || undefined,
                page: 1,
              }))
            }
          >
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {label(method)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Property</th>
                <th className="px-5 py-3 font-medium">Category</th>
                <th className="px-5 py-3 font-medium">Source</th>
                <th className="px-5 py-3 font-medium">Payment</th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((expense) => (
                <tr key={expense.id} className="border-t border-slate-100">
                  <td className="px-5 py-3">{formatDate(expense.transaction_date)}</td>
                  <td className="px-5 py-3 font-medium">{expense.property_name}</td>
                  <td className="px-5 py-3 capitalize">{label(expense.category)}</td>
                  <td className="px-5 py-3 capitalize">{label(expense.source)}</td>
                  <td className="px-5 py-3 capitalize">{label(expense.payment_method)}</td>
                  <td className="px-5 py-3">{formatCurrency(expense.amount, expense.currency)}</td>
                  <td className="px-5 py-3 text-slate-500">
                    {expense.vendor_name ? `${expense.vendor_name} — ` : ''}
                    {expense.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.items.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No expenses match the current filters." />
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-500">
          <span>
            Showing {data.items.length} of {data.total} expenses
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
