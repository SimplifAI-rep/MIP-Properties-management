import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import { DateInputDMY } from '../components/ui/DateInputDMY';
import { Tooltip } from '../components/ui/Tooltip';
import { TransactionUploadPanel } from '../components/TransactionUploadPanel';
import { useFeedback } from '../context/FeedbackContext';
import { todayISO } from '../utils/dateFormat';

type TransactionKind = 'deposit' | 'expense';
/** Filters that match Excel money lanes + Deposit/Expense. */
type TypeFilterKind = 'deposit' | 'expense' | 'rental_income' | 'he_she_paid';
type AlertFilterKind = 'incomplete_import';
type TypeFilter = 'all' | TransactionKind;

interface UnifiedTransaction {
  id: string;
  kind: TransactionKind;
  property_id: string;
  transaction_date: string | null;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  amount: string;
  currency: string;
  /** Excel "Section" (expense category / deposit account cue). */
  section: string;
  /** Excel "Notes". */
  notes: string | null;
  /** Excel "Company" when present. */
  company: string | null;
  payment_method?: string | null;
  source?: string | null;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
  is_rental_income?: boolean;
  from_bank_statement?: boolean;
  needs_review?: boolean;
  review_reasons?: string | null;
}

interface TransactionEditForm {
  kind: TransactionKind;
  id: string;
  property_id: string;
  transaction_date?: string;
  amount: string;
  section: string;
  notes: string;
  company: string;
  payment_method: string;
  source: string;
  is_rental_income: boolean;
}


function rowTypeTags(row: UnifiedTransaction): TypeFilterKind[] {
  if (row.kind === 'deposit') {
    return row.is_rental_income ? ['rental_income'] : ['deposit'];
  }
  return row.paid_by_resident ? ['he_she_paid'] : ['expense'];
}

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUploadReceiptRef(ref: string | null | undefined): ref is string {
  return Boolean(ref && UPLOAD_ID_RE.test(ref));
}

/** Common Method values — Excel uses free text; these cover manual entry. */
const METHODS = [
  'bank_direct_debit',
  'credit_card',
  'bank_transfer',
  'owner_personal',
  'company_account',
  'cash',
] as const;

const SOURCES = [
  'standing_order',
  'credit_card',
  'manual_owner',
  'manual_company',
] as const;

/** Soft suggestions for Section (Excel free-text); users can type anything. */
const SECTION_SUGGESTIONS = [
  'Cleaning',
  'Maintenance',
  'Utilities',
  'Insurance',
  'Tax',
  'Management fee',
  'Other',
] as const;

const PAGE_SIZE = 50;
const FETCH_SIZE = 2000;

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function makeEmptyForm(): ExpenseCreate {
  return {
    property_id: '',
    transaction_date: todayISO(),
    amount: '',
    category: '',
    source: 'manual_company',
    payment_method: 'company_account',
    vendor_name: '',
    description: '',
  };
}

function expenseNotes(expense: Expense): string | null {
  const desc = expense.description?.trim() || null;
  const section = expense.category?.trim() || '';
  if (!desc) return null;
  // Import stores description as "Section | Notes" — show Notes only when possible.
  if (section && desc.toLowerCase().startsWith(section.toLowerCase())) {
    const rest = desc.slice(section.length).replace(/^\s*\|\s*/, '').trim();
    return rest || null;
  }
  return desc;
}

function depositToUnified(deposit: Deposit): UnifiedTransaction {
  return {
    id: deposit.id,
    kind: 'deposit',
    property_id: deposit.property_id,
    transaction_date: deposit.transaction_date,
    client_prop_id: deposit.client_prop_id,
    property_name: deposit.property_name,
    owner_name: deposit.owner_name,
    amount: deposit.amount,
    currency: deposit.currency,
    section: deposit.is_rental_income
      ? 'Rental income'
      : label(deposit.source || 'Inflow'),
    notes: deposit.description,
    company: null,
    source: deposit.source,
    receipt_ref: deposit.receipt_ref ?? null,
    source_file: deposit.source_file ?? null,
    balance_after: deposit.balance_after ?? null,
    is_rental_income: Boolean(deposit.is_rental_income),
    from_bank_statement: deposit.source === 'bank_statement',
    needs_review: Boolean(deposit.needs_review),
    review_reasons: deposit.review_reasons ?? null,
  };
}

function expenseToUnified(expense: Expense): UnifiedTransaction {
  return {
    id: expense.id,
    kind: 'expense',
    property_id: expense.property_id,
    transaction_date: expense.transaction_date,
    client_prop_id: expense.client_prop_id,
    property_name: expense.property_name,
    owner_name: expense.owner_name,
    amount: expense.amount,
    currency: expense.currency,
    section: expense.category || 'other',
    notes: expenseNotes(expense),
    company: expense.vendor_name,
    payment_method: expense.payment_method,
    source: expense.source,
    receipt_ref: expense.receipt_ref ?? null,
    source_file: expense.source_file ?? null,
    balance_after: expense.balance_after ?? null,
    paid_by_resident: Boolean(expense.paid_by_resident),
    paid_by_company: Boolean(expense.paid_by_company),
    paid_by_owner: Boolean(expense.paid_by_owner),
    ledger_column: expense.ledger_column ?? null,
    from_bank_statement: expense.source === 'bank_statement',
    needs_review: Boolean(expense.needs_review),
    review_reasons: expense.review_reasons ?? null,
  };
}

function rowToEditForm(row: UnifiedTransaction): TransactionEditForm {
  return {
    kind: row.kind,
    id: row.id,
    property_id: row.property_id,
    transaction_date: row.transaction_date ?? undefined,
    amount: Number(row.amount) > 0 ? row.amount : '',
    section: row.kind === 'expense' ? row.section : '',
    notes: row.notes ?? '',
    company: row.company ?? '',
    payment_method: row.payment_method || 'company_account',
    source: row.source || (row.kind === 'deposit' ? 'management_ledger' : 'manual_company'),
    is_rental_income: Boolean(row.is_rental_income),
  };
}

function formatTransactionFeedback(row: UnifiedTransaction): string {
  const lines = [
    'Feedback about this transaction:',
    '',
    '',
    '',
    '--- Transaction ---',
    `Type: ${row.kind === 'deposit' ? 'Deposit' : 'Expense'}`,
    `ID: ${row.id}`,
    `Prop ID: ${row.client_prop_id}`,
    `Property: ${row.property_name}`,
    `Owner: ${row.owner_name}`,
    `Date: ${row.transaction_date ?? 'Missing date'}`,
    `Section: ${row.section}`,
    `Notes: ${row.notes || '—'}`,
    `Amount: ${row.amount} ${row.currency}`,
    `Company: ${row.company || '—'}`,
  ];
  if (row.kind === 'expense') {
    if (row.payment_method) lines.push(`Method: ${row.payment_method}`);
    if (row.source) lines.push(`Source: ${row.source}`);
    if (row.paid_by_resident) lines.push('Flag: He/She paid');
    if (row.paid_by_owner) lines.push('Flag: Owner paid');
    if (row.paid_by_company) lines.push('Flag: MIP paid');
    if (row.ledger_column) lines.push(`Ledger column: ${row.ledger_column}`);
  } else {
    if (row.is_rental_income) lines.push('Flag: Rental income');
    if (row.source) lines.push(`Source: ${row.source}`);
  }
  if (row.needs_review) {
    lines.push(`Needs review: yes (${row.review_reasons || 'unspecified'})`);
  }
  if (row.source_file) lines.push(`Source file: ${row.source_file}`);
  lines.push('-------------------');
  return lines.join('\n');
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

export function TransactionsPage() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const { openFeedback } = useFeedback();
  const [kinds, setKinds] = useState<TypeFilterKind[]>(['deposit', 'expense']);
  const [page, setPage] = useState(1);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [clientPropIds, setClientPropIds] = useState<string[]>([]);
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string | undefined>();
  const [dateTo, setDateTo] = useState<string | undefined>();
  const [sections, setSections] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [alertFilters, setAlertFilters] = useState<AlertFilterKind[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [receiptViewer, setReceiptViewer] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [form, setForm] = useState<ExpenseCreate>(() => makeEmptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<TransactionEditForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [tableViewportWidth, setTableViewportWidth] = useState<number | undefined>();

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const sync = () => setTableViewportWidth(el.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
      setPropertyIds(state.propertyId ? [state.propertyId] : []);
      setClientPropIds(state.clientPropId ? [state.clientPropId] : []);
      setOwnerIds([]);
      setPage(1);
    } else if (state?.ownerId) {
      setOwnerIds([state.ownerId]);
      setPropertyIds([]);
      setClientPropIds([]);
      setPage(1);
    }
    if (state?.dateFrom != null || state?.dateTo != null) {
      setDateFrom(state.dateFrom);
      setDateTo(state.dateTo);
      setPage(1);
    }
    if (state?.typeFilter === 'deposit') {
      setKinds(['deposit']);
      setPage(1);
    } else if (state?.typeFilter === 'expense') {
      setKinds(['expense']);
      setPage(1);
    } else if (state?.propertyId || state?.clientPropId || state?.ownerId) {
      setKinds(['deposit', 'expense']);
    }
  }, [location.state]);

  const apiPropertyId = propertyIds.length === 1 ? propertyIds[0] : undefined;
  const apiClientPropId = clientPropIds.length === 1 ? clientPropIds[0] : undefined;
  const apiOwnerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
  const apiSection = sections.length === 1 ? sections[0] : undefined;
  const apiSource = sources.length === 1 ? sources[0] : undefined;

  const sharedFilters = {
    property_id: apiPropertyId,
    client_prop_id: apiClientPropId,
    owner_id: apiOwnerId,
    date_from: dateFrom,
    date_to: dateTo,
  };

  const includeDeposits =
    kinds.length === 0 ||
    kinds.includes('deposit') ||
    kinds.includes('rental_income') ||
    alertFilters.includes('incomplete_import');
  const includeExpenses =
    kinds.length === 0 ||
    kinds.includes('expense') ||
    kinds.includes('he_she_paid') ||
    alertFilters.includes('incomplete_import');

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary', sharedFilters, apiSection, apiSource],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        include_all: false,
      }),
    enabled: includeExpenses,
  });
  const depositSummaryQuery = useQuery({
    queryKey: ['deposit-summary', sharedFilters],
    queryFn: () =>
      api.getDepositSummary({
        ...sharedFilters,
        include_all: false,
      }),
    enabled: includeDeposits,
  });
  // Full deposit total including rental — used when Rental income is selected in Type
  const depositAllSummaryQuery = useQuery({
    queryKey: ['deposit-summary-all', sharedFilters],
    queryFn: () =>
      api.getDepositSummary({
        ...sharedFilters,
        include_all: true,
      }),
    enabled: kinds.includes('rental_income'),
  });
  const expenseAllSummaryQuery = useQuery({
    queryKey: ['expense-summary-all', sharedFilters, apiSection, apiSource],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        include_all: true,
      }),
    enabled: kinds.includes('he_she_paid'),
  });

  const depositsQuery = useQuery({
    queryKey: ['deposits', sharedFilters],
    queryFn: () =>
      api.getDeposits({
        ...sharedFilters,
        page: 1,
        page_size: FETCH_SIZE,
      }),
    enabled: includeDeposits,
  });

  const expensesQuery = useQuery({
    queryKey: ['expenses', sharedFilters, apiSection, apiSource],
    queryFn: () =>
      api.getExpenses({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        page: 1,
        page_size: FETCH_SIZE,
      }),
    enabled: includeExpenses,
  });

  const createMutation = useMutation({
    mutationFn: api.createExpense,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      setForm(makeEmptyForm());
      setShowForm(false);
      setFormError(null);
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const updateTransactionMutation = useMutation({
    mutationFn: async (payload: TransactionEditForm) => {
      if (payload.kind === 'expense') {
        const section = payload.section.trim() || 'other';
        const notes = payload.notes.trim();
        return api.updateExpense(payload.id, {
          property_id: payload.property_id,
          transaction_date: payload.transaction_date || null,
          amount: payload.amount || '0',
          category: section,
          source: payload.source || 'manual_company',
          payment_method: payload.payment_method || 'company_account',
          vendor_name: payload.company.trim() || null,
          notes: notes || null,
          description: notes ? `${section} | ${notes}` : section,
        });
      }
      return api.updateDeposit(payload.id, {
        property_id: payload.property_id,
        transaction_date: payload.transaction_date || null,
        amount: payload.amount || '0',
        description: payload.notes.trim() || null,
        is_rental_income: payload.is_rental_income,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
      setEditForm(null);
      setEditError(null);
    },
    onError: (error: Error) => setEditError(error.message),
  });

  const typeOptions = useMemo(
    () => [
      { value: 'deposit', label: 'Deposit (Inflow)' },
      { value: 'expense', label: 'Expense (Amount)' },
      { value: 'rental_income', label: 'Rental income' },
      { value: 'he_she_paid', label: 'He/She paid' },
    ],
    [],
  );

  const alertOptions = useMemo(
    () => [{ value: 'incomplete_import', label: 'Incomplete import' }],
    [],
  );

  const propIdOptions = useMemo(
    () =>
      (propertiesQuery.data ?? []).map((property) => ({
        value: property.client_prop_id,
        label:
          property.status !== 'active'
            ? `${property.client_prop_id} (inactive)`
            : property.client_prop_id,
      })),
    [propertiesQuery.data],
  );

  const propertyOptions = useMemo(
    () =>
      (propertiesQuery.data ?? []).map((property) => ({
        value: property.id,
        label: `${property.client_prop_id} — ${property.name}`,
      })),
    [propertiesQuery.data],
  );

  const ownerOptions = useMemo(
    () =>
      (ownersQuery.data ?? []).map((owner) => ({
        value: owner.id,
        label: owner.name,
      })),
    [ownersQuery.data],
  );

  const sectionOptions = useMemo(() => {
    const fromSummary = (expenseSummaryQuery.data?.by_category ?? [])
      .map((row) => row.category)
      .filter(Boolean);
    const fromRows = (expensesQuery.data?.items ?? [])
      .map((row) => row.category)
      .filter(Boolean);
    const merged = [...new Set([...SECTION_SUGGESTIONS, ...fromSummary, ...fromRows])].sort(
      (a, b) => a.localeCompare(b),
    );
    return merged.map((value) => ({ value, label: value }));
  }, [expenseSummaryQuery.data, expensesQuery.data]);

  const sourceOptions = useMemo(
    () => SOURCES.map((value) => ({ value, label: label(value) })),
    [],
  );

  const { items, total, totalPages, depositTotal, expenseTotal, depositCount, expenseTotalCount, netTotal, cardSubtitle } =
    useMemo(() => {
      const deposits = includeDeposits
        ? (depositsQuery.data?.items ?? []).map(depositToUnified)
        : [];
      const expenses = includeExpenses
        ? (expensesQuery.data?.items ?? []).map(expenseToUnified)
        : [];
      let merged = [...deposits, ...expenses].sort((a, b) => {
        const aTime = a.transaction_date ? new Date(a.transaction_date).getTime() : 0;
        const bTime = b.transaction_date ? new Date(b.transaction_date).getTime() : 0;
        if (a.needs_review !== b.needs_review) return a.needs_review ? -1 : 1;
        return bTime - aTime;
      });

      if (kinds.length > 0) {
        const kindSet = new Set(kinds);
        merged = merged.filter((row) => rowTypeTags(row).some((tag) => kindSet.has(tag)));
      }
      if (alertFilters.includes('incomplete_import')) {
        merged = merged.filter((row) => Boolean(row.needs_review));
      }
      if (clientPropIds.length > 0) {
        const set = new Set(clientPropIds);
        merged = merged.filter((row) => set.has(row.client_prop_id));
      }
      if (propertyIds.length > 0) {
        const props = propertiesQuery.data ?? [];
        merged = merged.filter((row) =>
          props.some(
            (property) =>
              propertyIds.includes(property.id) && property.client_prop_id === row.client_prop_id,
          ),
        );
      }
      if (ownerIds.length > 0) {
        const owners = ownersQuery.data ?? [];
        const allowedNames = new Set(
          owners.filter((owner) => ownerIds.includes(owner.id)).map((owner) => owner.name),
        );
        merged = merged.filter((row) => allowedNames.has(row.owner_name));
      }
      if (sections.length > 0) {
        const set = new Set(sections.map((value) => value.toLowerCase()));
        merged = merged.filter((row) => set.has(row.section.toLowerCase()));
      }
      if (sources.length > 0) {
        const sourceSet = new Set(sources);
        const expenseSourceById = new Map(
          (expensesQuery.data?.items ?? []).map((row) => [row.id, row.source]),
        );
        merged = merged.filter((row) => {
          if (row.kind !== 'expense') return true;
          const source = expenseSourceById.get(row.id);
          return source ? sourceSet.has(source) : false;
        });
      }

      // Card totals: match Excel Dashboard (Inflow=non-rental deposits, Expenses=non-He/She).
      // Prefer API summaries so we are not capped by the 2000-row fetch window.
      const wantsInflow = kinds.length === 0 || kinds.includes('deposit');
      const wantsExpense = kinds.length === 0 || kinds.includes('expense');
      const wantsRental = kinds.includes('rental_income');
      const wantsHeShe = kinds.includes('he_she_paid');

      const apiInflow = Number(depositSummaryQuery.data?.total_amount ?? 0);
      const apiExpenses = Number(expenseSummaryQuery.data?.total_amount ?? 0);
      const apiInflowCount = depositSummaryQuery.data?.deposit_count ?? 0;
      const apiExpenseCount = expenseSummaryQuery.data?.expense_count ?? 0;
      const apiAllDeposits = Number(depositAllSummaryQuery.data?.total_amount ?? 0);
      const apiAllDepositCount = depositAllSummaryQuery.data?.deposit_count ?? 0;
      const apiAllExpenses = Number(expenseAllSummaryQuery.data?.total_amount ?? 0);
      const apiAllExpenseCount = expenseAllSummaryQuery.data?.expense_count ?? 0;

      const rentalTotal = Math.max(0, apiAllDeposits - apiInflow);
      const rentalCount = Math.max(0, apiAllDepositCount - apiInflowCount);
      const heSheTotal = Math.max(0, apiAllExpenses - apiExpenses);
      const heSheCount = Math.max(0, apiAllExpenseCount - apiExpenseCount);

      let cardInflow = 0;
      let cardExpenses = 0;
      let cardInflowCount = 0;
      let cardExpenseCount = 0;
      const parts: string[] = [];

      if (wantsInflow) {
        cardInflow += apiInflow;
        cardInflowCount += apiInflowCount;
        parts.push('Inflow (Excel)');
      }
      if (wantsRental) {
        cardInflow += rentalTotal;
        cardInflowCount += rentalCount;
        parts.push('Rental income');
      }
      if (wantsExpense) {
        cardExpenses += apiExpenses;
        cardExpenseCount += apiExpenseCount;
        parts.push('Amount (Excel)');
      }
      if (wantsHeShe) {
        cardExpenses += heSheTotal;
        cardExpenseCount += heSheCount;
        parts.push('He/She paid');
      }

      // Multi-select entity filters (2+) are applied client-side only — fall back to page sum
      const multiEntity =
        propertyIds.length > 1 || clientPropIds.length > 1 || ownerIds.length > 1 || sections.length > 1;
      if (multiEntity || sources.length > 0) {
        const depItems = merged.filter((row) => row.kind === 'deposit');
        const expItems = merged.filter((row) => row.kind === 'expense');
        cardInflow = depItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardExpenses = expItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardInflowCount = depItems.length;
        cardExpenseCount = expItems.length;
        parts.length = 0;
        parts.push('filtered rows');
      }

      const totalCount = merged.length;
      const totalPagesCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
      const start = (page - 1) * PAGE_SIZE;
      const pageItems = merged.slice(start, start + PAGE_SIZE);

      return {
        items: pageItems,
        total: totalCount,
        totalPages: totalPagesCount,
        depositTotal: cardInflow,
        expenseTotal: cardExpenses,
        depositCount: cardInflowCount,
        expenseTotalCount: cardExpenseCount,
        netTotal: cardInflow - cardExpenses,
        cardSubtitle: parts.join(' + ') || 'current filters',
      };
    }, [
      alertFilters,
      clientPropIds,
      depositAllSummaryQuery.data,
      depositSummaryQuery.data,
      depositsQuery.data,
      expenseAllSummaryQuery.data,
      expenseSummaryQuery.data,
      expensesQuery.data,
      includeDeposits,
      includeExpenses,
      kinds,
      ownerIds,
      ownersQuery.data,
      page,
      propertiesQuery.data,
      propertyIds,
      sections,
      sources,
    ]);

  const isLoading =
    propertiesQuery.isLoading ||
    ownersQuery.isLoading ||
    (includeDeposits && depositsQuery.isLoading) ||
    (includeExpenses && expensesQuery.isLoading);
  const isError =
    propertiesQuery.isError ||
    ownersQuery.isError ||
    (includeDeposits && depositsQuery.isError) ||
    (includeExpenses && expensesQuery.isError);

  function resetPage() {
    setPage(1);
  }

  const hasActiveFilters = Boolean(
    kinds.length !== 2 ||
      !kinds.includes('deposit') ||
      !kinds.includes('expense') ||
      alertFilters.length ||
      propertyIds.length ||
      clientPropIds.length ||
      ownerIds.length ||
      dateFrom ||
      dateTo ||
      sections.length ||
      sources.length,
  );

  function clearFilters() {
    setKinds(['deposit', 'expense']);
    setAlertFilters([]);
    setPropertyIds([]);
    setClientPropIds([]);
    setOwnerIds([]);
    setDateFrom(undefined);
    setDateTo(undefined);
    setSections([]);
    setSources([]);
    setPage(1);
  }

  function openEdit(row: UnifiedTransaction) {
    setEditForm(rowToEditForm(row));
    setEditError(null);
    setShowForm(false);
    setShowUpload(false);
  }

  function cancelEdit() {
    setEditForm(null);
    setEditError(null);
  }

  function saveEdit() {
    if (!editForm) return;
    if (!editForm.property_id) {
      setEditError('Prop ID / Property is required.');
      return;
    }
    if (!editForm.transaction_date || !editForm.amount || Number(editForm.amount) <= 0) {
      setEditError('Date and amount greater than 0 are required.');
      return;
    }
    updateTransactionMutation.mutate(editForm);
  }

  function patchEdit(patch: Partial<TransactionEditForm>) {
    setEditForm((current) => (current ? { ...current, ...patch } : current));
  }

  function reviewBang(row: UnifiedTransaction) {
    return (
      <Tooltip content="Incomplete import — click to edit inline.">
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-base font-bold leading-none text-negative hover:bg-rose-500/10"
          aria-label="Needs review — edit transaction"
          onClick={() => openEdit(row)}
        >
          !
        </button>
      </Tooltip>
    );
  }

  function syncPropIdsFromProperties(nextPropertyIds: string[]) {
    setPropertyIds(nextPropertyIds);
    const props = propertiesQuery.data ?? [];
    setClientPropIds(
      nextPropertyIds
        .map((id) => props.find((property) => property.id === id)?.client_prop_id)
        .filter((value): value is string => Boolean(value)),
    );
    resetPage();
  }

  function syncPropertiesFromPropIds(nextPropIds: string[]) {
    setClientPropIds(nextPropIds);
    const props = propertiesQuery.data ?? [];
    setPropertyIds(
      nextPropIds
        .map((propId) => props.find((property) => property.client_prop_id === propId)?.id)
        .filter((value): value is string => Boolean(value)),
    );
    resetPage();
  }

  if (isLoading) return <LoadingState />;
  if (isError) {
    return <ErrorState message="Could not load transactions from the API." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="page-heading">Transactions</h2>
          <p className="page-desc">
            Same ledger as your Excel: Prop ID, Date, Section, Notes, Amount, and Balance — plus
            Property and Owner for easier browsing. Deposits (Inflow) in green, expenses (Amount) in
            red. He/She paid and rental income are marked like in the spreadsheet.
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
              setShowForm((current) => {
                const next = !current;
                if (next) {
                  setForm(makeEmptyForm());
                  setFormError(null);
                  setShowUpload(false);
                }
                return next;
              });
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
                  'Prop ID': row.client_prop_id,
                  Date: row.transaction_date,
                  Section: row.section,
                  Notes: row.notes ?? '',
                  Type: row.kind === 'deposit' ? 'Deposit' : 'Expense',
                  Amount: row.kind === 'expense' ? row.amount : '',
                  Inflow: row.kind === 'deposit' ? row.amount : '',
                  Company: row.company ?? '',
                  Balance: row.balance_after ?? '',
                  Property: row.property_name,
                  Owner: row.owner_name,
                  'Source file': row.source_file ?? '',
                  'He/She paid': row.paid_by_resident ? 'yes' : '',
                  'Owner paid': row.paid_by_owner ? 'yes' : '',
                  'Rental income': row.is_rental_income ? 'yes' : '',
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
          title="Inflow"
          value={formatCurrency(depositTotal)}
          subtitle={`${depositCount} row(s) · ${cardSubtitle}`}
          tooltip="Matches Excel Dashboard Inflow (sum of Inflow column). Rental income is separate unless selected in Type."
        />
        <Card
          title="Expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseTotalCount} row(s) · ${cardSubtitle}`}
          tooltip="Matches Excel Dashboard Expenses (sum of Amount column). He/She paid is separate unless selected in Type. Credit-card imports are included in the app but not on the Excel Dashboard."
        />
        <Card
          title="Balance"
          value={formatCurrency(netTotal)}
          subtitle="Inflow minus Expenses (current Type filters)"
          tooltip="Same as Excel Dashboard Balance: Inflow − Expenses."
        />
        <Card
          title="Showing"
          value={items.length}
          subtitle={`${total} matching transaction(s)`}
          tooltip="Rows on this page after filters."
        />
      </section>

      {showUpload ? (
        <TransactionUploadPanel
          properties={propertiesQuery.data ?? []}
          onClose={() => setShowUpload(false)}
        />
      ) : null}

      {showForm ? (
        <section className="panel p-4">
          <h3 className="subheading">New expense</h3>
          <p className="mt-1 text-sm text-muted">
            Fields use the same names as your Excel sheet (Section, Notes, Method, Company).
          </p>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!form.property_id || !form.transaction_date || !form.amount) {
                setFormError('Prop ID / Property, Date, and Amount are required.');
                return;
              }
              const section = form.category.trim() || 'other';
              createMutation.mutate({
                ...form,
                category: section,
                description: form.description?.trim()
                  ? `${section} | ${form.description.trim()}`
                  : section,
                vendor_name: form.vendor_name?.trim() || undefined,
                source: form.source || 'manual_company',
              });
            }}
          >
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Same as Prop ID in Excel — pick the property sheet.">
                  Prop ID / Property
                </Tooltip>
              </span>
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
              <span className="label-text">
                <Tooltip content="Excel Amount column — money leaving the company float.">
                  Amount
                </Tooltip>
              </span>
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
              <span className="label-text">
                <Tooltip content="Excel Section — what the expense is for.">Section</Tooltip>
              </span>
              <input
                list="section-suggestions"
                type="text"
                className="field"
                placeholder="e.g. Cleaning"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              />
              <datalist id="section-suggestions">
                {SECTION_SUGGESTIONS.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Excel Method — how it was paid.">Method</Tooltip>
              </span>
              <select
                className="field"
                value={form.payment_method}
                onChange={(event) =>
                  setForm((current) => ({ ...current, payment_method: event.target.value }))
                }
              >
                {METHODS.map((item) => (
                  <option key={item} value={item}>
                    {label(item)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Excel Company — vendor or payee name.">Company</Tooltip>
              </span>
              <input
                type="text"
                className="field"
                placeholder="Vendor / company name"
                value={form.vendor_name ?? ''}
                onChange={(event) =>
                  setForm((current) => ({ ...current, vendor_name: event.target.value }))
                }
              />
            </label>
            <label className="text-sm md:col-span-2 xl:col-span-3">
              <span className="label-text">
                <Tooltip content="Excel Notes — free text about the row.">Notes</Tooltip>
              </span>
              <input
                type="text"
                className="field"
                placeholder="Optional notes"
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

      <section className="filter-panel md:grid-cols-2 xl:grid-cols-4">
        <SearchableMultiSelect
          label="Type"
          tip="Deposit/Expense match Excel Inflow/Amount. Rental income and He/She paid are separate Excel columns — not in Dashboard totals."
          options={typeOptions}
          selected={kinds}
          onChange={(next) => {
            setKinds(next as TypeFilterKind[]);
            resetPage();
          }}
          placeholder="All types"
          searchPlaceholder="Search type…"
        />
        <SearchableMultiSelect
          label="Alerts"
          tip="Show only rows with open incomplete-import alerts (missing date and/or amount)."
          options={alertOptions}
          selected={alertFilters}
          onChange={(next) => {
            setAlertFilters(next as AlertFilterKind[]);
            resetPage();
          }}
          placeholder="All rows"
          searchPlaceholder="Search alerts…"
        />
        <SearchableMultiSelect
          label="Prop ID"
          tip="Excel Prop ID — select one or more."
          options={propIdOptions}
          selected={clientPropIds}
          onChange={syncPropertiesFromPropIds}
          placeholder="All Prop IDs"
          searchPlaceholder="Search Prop ID…"
        />
        <SearchableMultiSelect
          label="Property"
          tip="Select one or more properties."
          options={propertyOptions}
          selected={propertyIds}
          onChange={syncPropIdsFromProperties}
          placeholder="All properties"
          searchPlaceholder="Search property…"
        />
        <SearchableMultiSelect
          label="Owner"
          tip="Select one or more owners."
          options={ownerOptions}
          selected={ownerIds}
          onChange={(next) => {
            setOwnerIds(next);
            resetPage();
          }}
          placeholder="All owners"
          searchPlaceholder="Search owner…"
        />
        <DateInputDMY
          label="From date"
          value={dateFrom}
          onChange={(iso) => {
            setDateFrom(iso);
            resetPage();
          }}
        />
        <DateInputDMY
          label="To date"
          value={dateTo}
          onChange={(iso) => {
            setDateTo(iso);
            resetPage();
          }}
        />
        <SearchableMultiSelect
          label="Section"
          tip="Excel Section — select one or more."
          options={sectionOptions}
          selected={sections}
          onChange={(next) => {
            setSections(next);
            resetPage();
          }}
          placeholder="All sections"
          searchPlaceholder="Search section…"
        />
        <SearchableMultiSelect
          label="Source"
          tip="How the expense was recorded."
          options={sourceOptions}
          selected={sources}
          onChange={(next) => {
            setSources(next);
            resetPage();
          }}
          placeholder="All sources"
          searchPlaceholder="Search source…"
        />
      </section>

      <section className="panel overflow-hidden">
        <div ref={tableScrollRef} className="overflow-x-auto">
          <table className="table-shell">
            <thead className="table-head">
              <tr>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Deposit = Inflow · Expense = Amount (Excel money columns).">
                    Type
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Excel Prop ID.">Prop ID</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Excel Section.">Section</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Excel Notes.">Notes</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Excel Amount (out) or Inflow (in).">Amount</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Running company-float balance after this row (like Excel Balance).">
                    Balance
                  </Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Excel Company — vendor or payee.">Company</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Property</th>
                <th className="px-5 py-3 font-medium">Owner</th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="File this row was imported from.">Source file</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">
                  <Tooltip content="Linked receipt (Excel Reciept), if uploaded.">Receipt</Tooltip>
                </th>
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const isEditing =
                  editForm?.id === row.id && editForm.kind === row.kind && editForm != null;
                return (
                  <Fragment key={`${row.kind}-${row.id}`}>
                    <tr
                      className={`${
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
                      }${isEditing ? ' table-row-selected' : ''}`}
                    >
                      <td className="px-5 py-3 whitespace-nowrap">
                        <div className="flex flex-nowrap items-center gap-1.5">
                          {row.needs_review ? reviewBang(row) : null}
                          <span
                            className={row.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}
                          >
                            {row.kind === 'deposit' ? 'Deposit' : 'Expense'}
                          </span>
                          {row.paid_by_resident ? (
                            <Tooltip content="Excel He/She paid — excluded from company float.">
                              <span className="badge-resident-paid">He/She paid</span>
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
                            <Tooltip content="Excel Rental income — tracked separately from company float.">
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
                      <td className="px-5 py-3 font-mono text-xs font-medium">
                        {row.client_prop_id}
                      </td>
                      <td className="px-5 py-3">
                        {row.transaction_date ? (
                          formatDate(row.transaction_date)
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {row.needs_review ? reviewBang(row) : null}
                            <span className="muted-text">Missing date</span>
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">{row.section}</td>
                      <td className="px-5 py-3 muted-text">{row.notes || '—'}</td>
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
                        {Number(row.amount) <= 0 && row.needs_review ? (
                          <span className="inline-flex items-center gap-1.5">
                            {reviewBang(row)}
                            <span className="muted-text">Missing amount</span>
                          </span>
                        ) : (
                          <>
                            {row.kind === 'deposit' ? '+' : '−'}
                            {formatCurrency(row.amount, row.currency)}
                          </>
                        )}
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
                      <td className="px-5 py-3 muted-text">{row.company || '—'}</td>
                      <td className="px-5 py-3 font-medium">{row.property_name}</td>
                      <td className="px-5 py-3">{row.owner_name}</td>
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
                                label: `${row.kind} · ${row.property_name} · ${
                                  row.transaction_date
                                    ? formatDate(row.transaction_date)
                                    : 'no date'
                                }`,
                              })
                            }
                          >
                            View
                          </button>
                        ) : (
                          <span className="muted-text text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          {isEditing ? (
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              onClick={cancelEdit}
                            >
                              Close
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              onClick={() => openEdit(row)}
                            >
                              Edit
                            </button>
                          )}
                          <Tooltip content="Send feedback about this row (details included in the email).">
                            <button
                              type="button"
                              className="btn-secondary text-xs"
                              onClick={() =>
                                openFeedback({
                                  initialMessage: formatTransactionFeedback(row),
                                })
                              }
                            >
                              Feedback
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                    {isEditing ? (
                      <tr className="bg-slate-50/80 dark:bg-slate-900/40">
                        <td
                          colSpan={13}
                          className="p-0"
                          style={
                            tableViewportWidth
                              ? {
                                  position: 'sticky',
                                  left: 0,
                                  width: tableViewportWidth,
                                  maxWidth: tableViewportWidth,
                                }
                              : undefined
                          }
                        >
                          <div className="box-border px-5 py-4" style={{ width: tableViewportWidth }}>
                            <div className="grid max-w-full gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                              <label className="text-sm min-w-0">
                                <span className="label-text">Prop ID / Property</span>
                                <select
                                  className="field"
                                  value={editForm.property_id}
                                  onChange={(event) =>
                                    patchEdit({ property_id: event.target.value })
                                  }
                                >
                                  {(propertiesQuery.data ?? []).map((property) => (
                                    <option key={property.id} value={property.id}>
                                      {property.client_prop_id} — {property.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <DateInputDMY
                                label="Date"
                                value={editForm.transaction_date}
                                onChange={(iso) => patchEdit({ transaction_date: iso })}
                                className="text-sm min-w-0"
                              />
                              <label className="text-sm min-w-0">
                                <span className="label-text">Amount</span>
                                <input
                                  type="number"
                                  min="0.01"
                                  step="0.01"
                                  className="field"
                                  value={editForm.amount}
                                  onChange={(event) => patchEdit({ amount: event.target.value })}
                                />
                              </label>
                              {row.kind === 'expense' ? (
                                <>
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Section</span>
                                    <input
                                      list="inline-section-suggestions"
                                      type="text"
                                      className="field"
                                      value={editForm.section}
                                      onChange={(event) =>
                                        patchEdit({ section: event.target.value })
                                      }
                                    />
                                  </label>
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Method</span>
                                    <select
                                      className="field"
                                      value={editForm.payment_method}
                                      onChange={(event) =>
                                        patchEdit({ payment_method: event.target.value })
                                      }
                                    >
                                      {METHODS.map((item) => (
                                        <option key={item} value={item}>
                                          {label(item)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Company</span>
                                    <input
                                      type="text"
                                      className="field"
                                      value={editForm.company}
                                      onChange={(event) =>
                                        patchEdit({ company: event.target.value })
                                      }
                                    />
                                  </label>
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Source</span>
                                    <select
                                      className="field"
                                      value={editForm.source}
                                      onChange={(event) =>
                                        patchEdit({ source: event.target.value })
                                      }
                                    >
                                      {SOURCES.map((item) => (
                                        <option key={item} value={item}>
                                          {label(item)}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </>
                              ) : (
                                <label className="text-sm flex items-end gap-2 pb-2 min-w-0">
                                  <input
                                    type="checkbox"
                                    checked={editForm.is_rental_income}
                                    onChange={(event) =>
                                      patchEdit({ is_rental_income: event.target.checked })
                                    }
                                  />
                                  <span className="label-text mb-0">Rental income</span>
                                </label>
                              )}
                              <label className="text-sm min-w-0 sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                <span className="label-text">Notes</span>
                                <input
                                  type="text"
                                  className="field"
                                  value={editForm.notes}
                                  onChange={(event) => patchEdit({ notes: event.target.value })}
                                />
                              </label>
                              {editError ? (
                                <p className="text-negative text-sm sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                  {editError}
                                </p>
                              ) : null}
                              <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                <button
                                  type="button"
                                  className="btn-primary"
                                  disabled={updateTransactionMutation.isPending}
                                  onClick={saveEdit}
                                >
                                  {updateTransactionMutation.isPending
                                    ? 'Saving…'
                                    : 'Save changes'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={cancelEdit}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <datalist id="inline-section-suggestions">
            {SECTION_SUGGESTIONS.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
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
