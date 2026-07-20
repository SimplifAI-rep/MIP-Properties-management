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
import { Tooltip } from '../components/ui/Tooltip';
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
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
  is_rental_income?: boolean;
  from_bank_statement?: boolean;
}

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUploadReceiptRef(ref: string | null | undefined): ref is string {
  return Boolean(ref && UPLOAD_ID_RE.test(ref));
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
    receipt_ref: deposit.receipt_ref ?? null,
    source_file: deposit.source_file ?? null,
    balance_after: deposit.balance_after ?? null,
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
    receipt_ref: expense.receipt_ref ?? null,
    source_file: expense.source_file ?? null,
    balance_after: expense.balance_after ?? null,
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
  const [receiptViewer, setReceiptViewer] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [form, setForm] = useState<ExpenseCreate>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const state = location.state as {
      showUpload?: boolean;
      showForm?: boolean;
      propertyId?: string;
      clientPropId?: string;
      ownerId?: string;
      dateFrom?: string;
      dateTo?: string;
      typeFilter?: TypeFilter;
    } | null;
    if (state?.showUpload) {
      setShowUpload(true);
      setShowForm(false);
    }
    if (state?.showForm) {
      setShowForm(true);
      setShowUpload(false);
    }
    if (state?.propertyId || state?.clientPropId) {
      setPropertyId(state.propertyId);
      setClientPropId(state.clientPropId);
      setOwnerId(undefined);
      setPage(1);
    } else if (state?.ownerId) {
      setOwnerId(state.ownerId);
      setPropertyId(undefined);
      setClientPropId(undefined);
      setPage(1);
    }
    if (state?.dateFrom != null || state?.dateTo != null) {
      setDateFrom(state.dateFrom);
      setDateTo(state.dateTo);
      setPage(1);
    }
    if (state?.typeFilter) {
      setTypeFilter(state.typeFilter);
      setPage(1);
    } else if (state?.propertyId || state?.clientPropId || state?.ownerId) {
      setTypeFilter('all');
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
    queryKey: ['deposit-summary', sharedFilters, typeFilter],
    queryFn: () =>
      api.getDepositSummary({
        ...sharedFilters,
        // Match Excel: rental income is tracked but not part of company float totals
        include_all: false,
      }),
    enabled: typeFilter !== 'expense',
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary', sharedFilters, category, source, typeFilter],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category,
        source,
        // Match Excel: He/She paid and owner-paid are informational only
        include_all: false,
      }),
    enabled: typeFilter !== 'deposit',
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
    (typeFilter !== 'deposit' && expensesQuery.isLoading) ||
    (typeFilter !== 'expense' && depositSummaryQuery.isLoading) ||
    (typeFilter !== 'deposit' && expenseSummaryQuery.isLoading);

  const isError =
    (typeFilter !== 'expense' && depositsQuery.isError) ||
    (typeFilter !== 'deposit' && expensesQuery.isError) ||
    (typeFilter !== 'expense' && depositSummaryQuery.isError) ||
    (typeFilter !== 'deposit' && expenseSummaryQuery.isError);

  const resetPage = () => setPage(1);

  const hasActiveFilters = Boolean(
    typeFilter !== 'all' ||
      propertyId ||
      clientPropId ||
      ownerId ||
      dateFrom ||
      dateTo ||
      category ||
      source,
  );

  function clearFilters() {
    setTypeFilter('all');
    setPropertyId(undefined);
    setClientPropId(undefined);
    setOwnerId(undefined);
    setDateFrom(undefined);
    setDateTo(undefined);
    setCategory(undefined);
    setSource(undefined);
    setPage(1);
  }

  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="Could not load transactions from the API." />;
  }

  const depositTotal =
    typeFilter === 'expense' ? 0 : Number(depositSummaryQuery.data?.total_amount ?? 0);
  const expenseTotal =
    typeFilter === 'deposit' ? 0 : Number(expenseSummaryQuery.data?.total_amount ?? 0);
  const depositCount =
    typeFilter === 'expense' ? 0 : (depositSummaryQuery.data?.deposit_count ?? 0);
  const expenseCount =
    typeFilter === 'deposit' ? 0 : (expenseSummaryQuery.data?.expense_count ?? 0);
  const netTotal = depositTotal - expenseTotal;

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
                  source_file: row.source_file ?? '',
                  balance_after: row.balance_after ?? '',
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
          subtitle={`${depositCount} matching deposit(s), excluding rental income`}
          tooltip="Filtered deposits, excluding rental income."
        />
        <Card
          title="Total expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseCount} matching expense(s), excluding He/She & owner paid`}
          tooltip="Filtered expenses, excluding resident/owner paid."
        />
        <Card
          title="Net"
          value={formatCurrency(netTotal)}
          subtitle="Deposits minus expenses (current filters)"
          tooltip="Deposits minus expenses for current filters."
        />
        <Card
          title="Showing"
          value={items.length}
          subtitle={`${total} matching transaction(s)`}
          tooltip="Rows on this page, not the full ledger."
        />
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

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Filters</p>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!hasActiveFilters}
          onClick={clearFilters}
        >
          Clear
        </button>
      </div>

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

      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-shell">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Client property ID from the source files.">Prop ID</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Property</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Account for deposits, or category/source for expenses.">
                    Details
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Amount</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Running company-float net for this property after this row.">
                    Balance
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="File this transaction was imported from.">Source file</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Linked receipt image or PDF, if uploaded.">Receipt</Tooltip>
                </th>
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
                  <td className="px-5 py-3 whitespace-nowrap">
                    <div className="flex flex-nowrap items-center gap-1.5">
                      <span className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
                        {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
                      </span>
                      {row.paid_by_resident ? (
                        <Tooltip content="Paid by the resident — excluded from company float.">
                          <span className="badge-resident-paid">Resident paid</span>
                        </Tooltip>
                      ) : null}
                      {row.paid_by_owner ? (
                        <Tooltip content="Paid by the owner — excluded from company float.">
                          <span className="badge-owner-paid">Owner paid</span>
                        </Tooltip>
                      ) : null}
                      {row.paid_by_company ? (
                        <Tooltip content="Paid by the company (MIP) — counts in company float.">
                          <span className="badge-mip-paid">MIP paid</span>
                        </Tooltip>
                      ) : null}
                      {row.ledger_column === 'nearly_cc' ? (
                        <Tooltip content="From the Nearly credit-card column.">
                          <span className="badge-nearly-cc">Nearly CC</span>
                        </Tooltip>
                      ) : null}
                      {row.ledger_column === 'cash' ? (
                        <Tooltip content="From the Cash column in the ledger.">
                          <span className="badge-cash-paid">Cash</span>
                        </Tooltip>
                      ) : null}
                      {row.ledger_column === 'other' ? (
                        <Tooltip content="From the Other column in the ledger.">
                          <span className="badge-other-paid">Other</span>
                        </Tooltip>
                      ) : null}
                      {row.is_rental_income ? (
                        <Tooltip content="Tenant rent — tracked separately from company float.">
                          <span className="badge-rental-income">Rental income</span>
                        </Tooltip>
                      ) : null}
                      {row.from_bank_statement ? (
                        <Tooltip content="Imported from the company bank statement.">
                          <span className="badge-bank-statement">Bank statement</span>
                        </Tooltip>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs font-medium">{row.client_prop_id}</td>
                  <td className="px-5 py-3">{formatDate(row.transaction_date)}</td>
                  <td className="px-5 py-3 font-medium">{row.property_name}</td>
                  <td className="px-5 py-3">{row.owner_name}</td>
                  <td className="px-5 py-3">{row.details}</td>
                  <td
                    className={`px-5 py-3 whitespace-nowrap tabular-nums ${
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
                  <td
                    className={`px-5 py-3 whitespace-nowrap tabular-nums font-medium ${
                      row.balance_after == null
                        ? 'muted-text'
                        : Number(row.balance_after) >= 0
                          ? 'amount-deposit'
                          : 'amount-expense'
                    }`}
                  >
                    {row.balance_after == null
                      ? '—'
                      : formatCurrency(row.balance_after, row.currency)}
                  </td>
                  <td className="px-5 py-3 muted-text">{row.description}</td>
                  <td
                    className="px-5 py-3 text-xs muted-text max-w-[14rem] truncate"
                    title={row.source_file ?? undefined}
                  >
                    {row.source_file || '—'}
                  </td>
                  <td className="px-5 py-3">
                    {isUploadReceiptRef(row.receipt_ref) ? (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() =>
                          setReceiptViewer({
                            url: api.getUploadFileUrl(row.receipt_ref!),
                            label: `${row.kind} · ${row.property_name} · ${formatDate(row.transaction_date)}`,
                          })
                        }
                      >
                        View
                      </button>
                    ) : (
                      <span className="muted-text text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {receiptViewer ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Receipt viewer"
            onClick={() => setReceiptViewer(null)}
          >
            <div
              className="panel flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 p-4"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="subheading">Receipt</h3>
                  <p className="page-desc">{receiptViewer.label}</p>
                </div>
                <div className="flex gap-2">
                  <a
                    href={receiptViewer.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary text-xs"
                  >
                    Open in new tab
                  </a>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => setReceiptViewer(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-black/5">
                <iframe
                  title="Receipt document"
                  src={receiptViewer.url}
                  className="h-[70vh] w-full"
                />
              </div>
            </div>
          </div>
        ) : null}
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
