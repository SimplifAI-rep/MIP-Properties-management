import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Deposit, Expense, ExpenseCreate } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';
import { TransactionUploadPanel } from '../components/TransactionUploadPanel';

type TransactionKind = 'deposit' | 'expense';
type TypeFilter = 'all' | TransactionKind;

interface UnifiedTransaction {
  id: string;
  kind: TransactionKind;
  transaction_date: string;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  amount: string;
  currency: string;
  details: string;
  description: string | null;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
  is_rental_income?: boolean;
  from_bank_statement?: boolean;
}

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

const PAGE_SIZE = 50;
const FETCH_SIZE = 200;
/** When a Prop ID / property filter is active, load enough rows to merge locally. */
const FILTERED_FETCH_SIZE = 2000;

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function depositToUnified(deposit: Deposit): UnifiedTransaction {
  return {
    id: deposit.id,
    kind: 'deposit',
    transaction_date: deposit.transaction_date,
    client_prop_id: deposit.client_prop_id,
    property_name: deposit.property_name,
    owner_name: deposit.owner_name,
    amount: deposit.amount,
    currency: deposit.currency,
    details: deposit.account_number ?? deposit.source,
    description: deposit.description,
    is_rental_income: Boolean(deposit.is_rental_income),
    from_bank_statement: deposit.source === 'bank_statement',
  };
}

function expenseToUnified(expense: Expense): UnifiedTransaction {
  return {
    id: expense.id,
    kind: 'expense',
    transaction_date: expense.transaction_date,
    client_prop_id: expense.client_prop_id,
    property_name: expense.property_name,
    owner_name: expense.owner_name,
    amount: expense.amount,
    currency: expense.currency,
    details: `${label(expense.category)} · ${label(expense.source)}`,
    description: expense.vendor_name
      ? `${expense.vendor_name}${expense.description ? ` — ${expense.description}` : ''}`
      : expense.description,
    paid_by_resident: Boolean(expense.paid_by_resident),
    paid_by_company: Boolean(expense.paid_by_company),
    paid_by_owner: Boolean(expense.paid_by_owner),
    ledger_column: expense.ledger_column ?? null,
    from_bank_statement: expense.source === 'bank_statement',
  };
}

function downloadCsv(rows: Record<string, string | number | null>[], filename: string) {
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

const emptyForm: ExpenseCreate = {
  property_id: '',
  transaction_date: '',
  amount: '',
  category: 'maintenance',
  source: 'manual_company',
  payment_method: 'company_account',
  description: '',
};

export function TransactionsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(1);
  const [propertyId, setPropertyId] = useState<string | undefined>();
  const [clientPropId, setClientPropId] = useState<string | undefined>();
  const [ownerId, setOwnerId] = useState<string | undefined>();
  const [dateFrom, setDateFrom] = useState<string | undefined>();
  const [dateTo, setDateTo] = useState<string | undefined>();
  const [category, setCategory] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [form, setForm] = useState<ExpenseCreate>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const state = location.state as { showUpload?: boolean; showForm?: boolean } | null;
    if (state?.showUpload) {
      setShowUpload(true);
      setShowForm(false);
    }
    if (state?.showForm) {
      setShowForm(true);
      setShowUpload(false);
    }
  }, [location.state]);

  const sharedFilters = {
    property_id: propertyId,
    client_prop_id: clientPropId,
    owner_id: ownerId,
    date_from: dateFrom,
    date_to: dateTo,
  };

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const depositSummaryQuery = useQuery({
    queryKey: ['deposit-summary'],
    queryFn: () => api.getDepositSummary(),
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary'],
    queryFn: () => api.getExpenseSummary(),
  });

  const hasEntityFilter = Boolean(propertyId || clientPropId || ownerId);
  const allModePageSize = hasEntityFilter ? FILTERED_FETCH_SIZE : FETCH_SIZE;

  const depositsQuery = useQuery({
    queryKey: ['deposits', typeFilter, sharedFilters, page, allModePageSize],
    queryFn: () =>
      api.getDeposits({
        ...sharedFilters,
        page: typeFilter === 'all' ? 1 : page,
        page_size: typeFilter === 'all' ? allModePageSize : PAGE_SIZE,
      }),
    enabled: typeFilter !== 'expense',
  });

  const expensesQuery = useQuery({
    queryKey: ['expenses', typeFilter, sharedFilters, category, source, page, allModePageSize],
    queryFn: () =>
      api.getExpenses({
        ...sharedFilters,
        category,
        source,
        page: typeFilter === 'all' ? 1 : page,
        page_size: typeFilter === 'all' ? allModePageSize : PAGE_SIZE,
      }),
    enabled: typeFilter !== 'deposit',
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

  const { items, total, totalPages } = useMemo(() => {
    if (typeFilter === 'deposit' && depositsQuery.data) {
      return {
        items: depositsQuery.data.items.map(depositToUnified),
        total: depositsQuery.data.total,
        totalPages: Math.max(1, Math.ceil(depositsQuery.data.total / PAGE_SIZE)),
      };
    }
    if (typeFilter === 'expense' && expensesQuery.data) {
      return {
        items: expensesQuery.data.items.map(expenseToUnified),
        total: expensesQuery.data.total,
        totalPages: Math.max(1, Math.ceil(expensesQuery.data.total / PAGE_SIZE)),
      };
    }
    if (typeFilter === 'all') {
      const deposits = (depositsQuery.data?.items ?? []).map(depositToUnified);
      const expenses = (expensesQuery.data?.items ?? []).map(expenseToUnified);
      const merged = [...deposits, ...expenses].sort(
        (a, b) =>
          new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime(),
      );
      // Prefer API totals so capped fetches don't under-report
      const depositTotal = depositsQuery.data?.total ?? deposits.length;
      const expenseTotal = expensesQuery.data?.total ?? expenses.length;
      const mergedTotal = depositTotal + expenseTotal;
      const start = (page - 1) * PAGE_SIZE;
      return {
        items: merged.slice(start, start + PAGE_SIZE),
        total: mergedTotal,
        totalPages: Math.max(1, Math.ceil(mergedTotal / PAGE_SIZE)),
      };
    }
    return { items: [], total: 0, totalPages: 1 };
  }, [typeFilter, depositsQuery.data, expensesQuery.data, page]);

  const isLoading =
    (typeFilter !== 'expense' && depositsQuery.isLoading) ||
    (typeFilter !== 'deposit' && expensesQuery.isLoading);

  const isError =
    (typeFilter !== 'expense' && depositsQuery.isError) ||
    (typeFilter !== 'deposit' && expensesQuery.isError);

  const resetPage = () => setPage(1);

  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="Could not load transactions from the API." />;
  }

  const depositTotal = Number(depositSummaryQuery.data?.total_amount ?? 0);
  const expenseTotal = Number(expenseSummaryQuery.data?.total_amount ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="page-heading">Transactions</h2>
          <p className="page-desc">
            View deposits and expenses together. Deposits are highlighted in green, expenses in
            red. Resident-paid, rental income, and bank-statement rows are marked with badges.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setShowUpload((current) => !current);
              if (!showUpload) setShowForm(false);
            }}
            className="btn-secondary"
          >
            {showUpload ? 'Cancel upload' : 'Import from file'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowForm((current) => !current);
              if (!showForm) setShowUpload(false);
            }}
            className="btn-primary"
          >
            {showForm ? 'Cancel' : 'Add expense'}
          </button>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                items.map((row) => ({
                  type: row.kind,
                  prop_id: row.client_prop_id,
                  date: row.transaction_date,
                  property: row.property_name,
                  owner: row.owner_name,
                  amount: row.amount,
                  currency: row.currency,
                  details: row.details,
                  description: row.description,
                  paid_by_resident: row.paid_by_resident ? 'yes' : '',
                  paid_by_company: row.paid_by_company ? 'yes' : '',
                  paid_by_owner: row.paid_by_owner ? 'yes' : '',
                  ledger_column: row.ledger_column ?? '',
                  rental_income: row.is_rental_income ? 'yes' : '',
                  bank_statement: row.from_bank_statement ? 'yes' : '',
                })),
                'transactions.csv',
              )
            }
            className="btn-secondary"
          >
            Export CSV
          </button>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card
          title="Total deposits"
          value={formatCurrency(depositTotal)}
          subtitle={`${depositSummaryQuery.data?.deposit_count ?? 0} transactions`}
        />
        <Card
          title="Total expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseSummaryQuery.data?.expense_count ?? 0} transactions`}
        />
        <Card title="Net" value={formatCurrency(depositTotal - expenseTotal)} subtitle="Deposits minus expenses" />
        <Card title="Showing" value={items.length} subtitle={`${total} matching transaction(s)`} />
      </section>

      <div className="flex flex-wrap gap-2">
        {(['all', 'deposit', 'expense'] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => {
              setTypeFilter(filter);
              resetPage();
            }}
            className={typeFilter === filter ? 'type-filter-active' : 'type-filter-inactive'}
          >
            {filter === 'all' ? 'All' : filter === 'deposit' ? 'Deposits' : 'Expenses'}
          </button>
        ))}
      </div>

      {showUpload ? (
        <TransactionUploadPanel
          properties={propertiesQuery.data ?? []}
          onClose={() => setShowUpload(false)}
        />
      ) : null}

      {showForm ? (
        <section className="panel p-4">
          <h3 className="subheading">New manual expense</h3>
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
              <span className="label-text">Property</span>
              <select
                required
                className="field"
                value={form.property_id}
                onChange={(event) =>
                  setForm((current) => ({ ...current, property_id: event.target.value }))
                }
              >
                <option value="">Select property</option>
                {(propertiesQuery.data ?? []).map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.client_prop_id} — {property.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">Date</span>
              <input
                required
                type="date"
                className="field"
                value={form.transaction_date}
                onChange={(event) =>
                  setForm((current) => ({ ...current, transaction_date: event.target.value }))
                }
              />
            </label>
            <label className="text-sm">
              <span className="label-text">Amount (ILS)</span>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                className="field"
                value={form.amount}
                onChange={(event) =>
                  setForm((current) => ({ ...current, amount: event.target.value }))
                }
              />
            </label>
            <label className="text-sm">
              <span className="label-text">Category</span>
              <select
                className="field"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              >
                {CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">Source</span>
              <select
                className="field"
                value={form.source}
                onChange={(event) =>
                  setForm((current) => ({ ...current, source: event.target.value }))
                }
              >
                {SOURCES.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">Payment method</span>
              <select
                className="field"
                value={form.payment_method}
                onChange={(event) =>
                  setForm((current) => ({ ...current, payment_method: event.target.value }))
                }
              >
                {PAYMENT_METHODS.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2 xl:col-span-3">
              <span className="label-text">Description</span>
              <input
                type="text"
                className="field"
                value={form.description ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            {formError ? (
              <p className="text-negative text-sm md:col-span-2 xl:col-span-3">{formError}</p>
            ) : null}
            <div className="md:col-span-2 xl:col-span-3">
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Saving...' : 'Save expense'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section
        className={`filter-panel ${
          typeFilter === 'expense' || typeFilter === 'all'
            ? 'md:grid-cols-2 xl:grid-cols-7'
            : 'md:grid-cols-2 xl:grid-cols-5'
        }`}
      >
        <label className="text-sm">
          <span className="label-text">Prop ID</span>
          <select
            className="field"
            value={clientPropId ?? ''}
            onChange={(event) => {
              const value = event.target.value || undefined;
              setClientPropId(value);
              // Keep property filter in sync when choosing a Prop ID
              if (value) {
                const match = (propertiesQuery.data ?? []).find(
                  (property) => property.client_prop_id === value,
                );
                setPropertyId(match?.id);
              } else if (propertyId) {
                // Clearing Prop ID should not force-clear property unless it was set via Prop ID
                setPropertyId(undefined);
              }
              resetPage();
            }}
          >
            <option value="">All Prop IDs</option>
            {(propertiesQuery.data ?? []).map((property) => (
              <option key={property.id} value={property.client_prop_id}>
                {property.client_prop_id}
                {property.status !== 'active' ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="label-text">Property</span>
          <select
            className="field"
            value={propertyId ?? ''}
            onChange={(event) => {
              const value = event.target.value || undefined;
              setPropertyId(value);
              if (value) {
                const match = (propertiesQuery.data ?? []).find((property) => property.id === value);
                setClientPropId(match?.client_prop_id);
              } else {
                setClientPropId(undefined);
              }
              resetPage();
            }}
          >
            <option value="">All properties</option>
            {(propertiesQuery.data ?? []).map((property) => (
              <option key={property.id} value={property.id}>
                {property.client_prop_id} — {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="label-text">Owner</span>
          <select
            className="field"
            value={ownerId ?? ''}
            onChange={(event) => {
              setOwnerId(event.target.value || undefined);
              resetPage();
            }}
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
          <span className="label-text">From date</span>
          <input
            type="date"
            className="field"
            value={dateFrom ?? ''}
            onChange={(event) => {
              setDateFrom(event.target.value || undefined);
              resetPage();
            }}
          />
        </label>
        <label className="text-sm">
          <span className="label-text">To date</span>
          <input
            type="date"
            className="field"
            value={dateTo ?? ''}
            onChange={(event) => {
              setDateTo(event.target.value || undefined);
              resetPage();
            }}
          />
        </label>
        {typeFilter === 'expense' || typeFilter === 'all' ? (
          <>
            <label className="text-sm">
              <span className="label-text">Category</span>
              <select
                className="field"
                value={category ?? ''}
                onChange={(event) => {
                  setCategory(event.target.value || undefined);
                  resetPage();
                }}
              >
                <option value="">All categories</option>
                {CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">Source</span>
              <select
                className="field"
                value={source ?? ''}
                onChange={(event) => {
                  setSource(event.target.value || undefined);
                  resetPage();
                }}
              >
                <option value="">All sources</option>
                {SOURCES.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Prop ID</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Property</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">Details</th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={`${row.kind}-${row.id}`}
                  className={
                    row.paid_by_resident
                      ? 'row-resident-paid'
                      : row.paid_by_owner
                        ? 'row-owner-paid'
                        : row.paid_by_company
                          ? 'row-mip-paid'
                          : row.ledger_column === 'nearly_cc'
                            ? 'row-nearly-cc'
                            : row.ledger_column === 'cash'
                              ? 'row-cash-paid'
                              : row.ledger_column === 'other'
                                ? 'row-other-paid'
                                : row.is_rental_income
                                  ? 'row-rental-income'
                                  : row.kind === 'deposit'
                                    ? 'row-deposit'
                                    : 'row-expense'
                  }
                >
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
                        {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
                      </span>
                      {row.paid_by_resident ? (
                        <span
                          className="badge-resident-paid"
                          title="Paid directly by resident (He/She paid)"
                        >
                          Resident paid
                        </span>
                      ) : null}
                      {row.paid_by_owner ? (
                        <span
                          className="badge-owner-paid"
                          title="Paid by the property owner (אהרון שילם)"
                        >
                          Owner paid
                        </span>
                      ) : null}
                      {row.paid_by_company ? (
                        <span
                          className="badge-mip-paid"
                          title="Paid by the company (MIP)"
                        >
                          MIP paid
                        </span>
                      ) : null}
                      {row.ledger_column === 'nearly_cc' ? (
                        <span className="badge-nearly-cc" title="From Nearly CC column">
                          Nearly CC
                        </span>
                      ) : null}
                      {row.ledger_column === 'cash' ? (
                        <span className="badge-cash-paid" title="From Cash column">
                          Cash
                        </span>
                      ) : null}
                      {row.ledger_column === 'other' ? (
                        <span className="badge-other-paid" title="From Other column">
                          Other
                        </span>
                      ) : null}
                      {row.is_rental_income ? (
                        <span
                          className="badge-rental-income"
                          title="Rental income (not company float)"
                        >
                          Rental income
                        </span>
                      ) : null}
                      {row.from_bank_statement ? (
                        <span
                          className="badge-bank-statement"
                          title="Imported from company bank statement"
                        >
                          Bank statement
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs font-medium">{row.client_prop_id}</td>
                  <td className="px-5 py-3">{formatDate(row.transaction_date)}</td>
                  <td className="px-5 py-3 font-medium">{row.property_name}</td>
                  <td className="px-5 py-3">{row.owner_name}</td>
                  <td className="px-5 py-3">{row.details}</td>
                  <td
                    className={`px-5 py-3 ${
                      row.paid_by_resident
                        ? 'amount-resident-paid'
                        : row.paid_by_owner
                          ? 'amount-owner-paid'
                          : row.paid_by_company
                            ? 'amount-mip-paid'
                            : row.ledger_column === 'nearly_cc'
                              ? 'amount-nearly-cc'
                              : row.ledger_column === 'cash'
                                ? 'amount-cash-paid'
                                : row.ledger_column === 'other'
                                  ? 'amount-other-paid'
                                  : row.is_rental_income
                                    ? 'amount-rental-income'
                                    : row.kind === 'deposit'
                                      ? 'amount-deposit'
                                      : 'amount-expense'
                    }`}
                  >
                    {row.kind === 'deposit' ? '+' : '−'}
                    {formatCurrency(row.amount, row.currency)}
                  </td>
                  <td className="px-5 py-3 muted-text">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No transactions match the current filters." />
          </div>
        ) : null}
        <div className="table-footer">
          <span>
            Showing {items.length} of {total} transactions
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              className="btn-pagination"
            >
              Previous
            </button>
            <span>
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
              className="btn-pagination"
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
