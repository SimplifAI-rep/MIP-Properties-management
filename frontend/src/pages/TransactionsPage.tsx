import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Deposit, Expense, ExpenseCreate } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import { DateInputDMY } from '../components/ui/DateInputDMY';
import { Tooltip } from '../components/ui/Tooltip';
import { TransactionUploadPanel } from '../components/TransactionUploadPanel';
import { useFeedback } from '../context/FeedbackContext';
import {
  EXPENSE_SOURCES as SOURCES,
  PAYMENT_METHODS as METHODS,
  SECTION_SUGGESTIONS,
} from '../constants/expenseOptions';
import { todayISO } from '../utils/dateFormat';
import { validationError } from '../utils/errors';

type TransactionKind = 'deposit' | 'expense';
/** Filters that match Excel money lanes + Deposit/Expense. */
type TypeFilterKind =
  | 'deposit'
  | 'expense'
  | 'rental_income'
  | 'he_she_paid'
  | 'owner_paid'
  | 'bank_statement'
  | 'nearly_cc';
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
  const tags: TypeFilterKind[] = [];
  if (row.kind === 'deposit') {
    tags.push(row.is_rental_income ? 'rental_income' : 'deposit');
  } else if (row.paid_by_resident) {
    tags.push('he_she_paid');
  } else if (row.paid_by_owner) {
    tags.push('owner_paid');
  } else {
    tags.push('expense');
  }
  if (row.from_bank_statement) tags.push('bank_statement');
  if (row.ledger_column === 'nearly_cc') tags.push('nearly_cc');
  return tags;
}

const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUploadReceiptRef(ref: string | null | undefined): ref is string {
  return Boolean(ref && UPLOAD_ID_RE.test(ref));
}

const PAGE_SIZE = 50;

function invalidateTransactionSummaries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['expenses'] });
  queryClient.invalidateQueries({ queryKey: ['deposits'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
  queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary-heshe'] });
  queryClient.invalidateQueries({ queryKey: ['expense-summary-owner'] });
  queryClient.invalidateQueries({ queryKey: ['deposit-summary-rental'] });
  queryClient.invalidateQueries({ queryKey: ['alerts'] });
  queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
}

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
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  const [alertFilters, setAlertFilters] = useState<AlertFilterKind[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [form, setForm] = useState<ExpenseCreate>(() => makeEmptyForm());
  const [formError, setFormError] = useState<unknown>(null);
  const [editForm, setEditForm] = useState<TransactionEditForm | null>(null);
  const [editError, setEditError] = useState<unknown>(null);

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
      kinds?: TypeFilterKind[];
      sections?: string[];
      sources?: string[];
      sourceFiles?: string[];
      alertFilters?: AlertFilterKind[];
    } | null;
    if (!state) return;

    if (state.showUpload) {
      setShowUpload(true);
      setShowForm(false);
    }
    if (state.showForm) {
      setShowForm(true);
      setShowUpload(false);
    }
    if (state.propertyId || state.clientPropId) {
      setPropertyIds(state.propertyId ? [state.propertyId] : []);
      setClientPropIds(state.clientPropId ? [state.clientPropId] : []);
      if (!state.ownerId) setOwnerIds([]);
      setPage(1);
    }
    if (state.ownerId) {
      setOwnerIds([state.ownerId]);
      if (!state.propertyId && !state.clientPropId) {
        setPropertyIds([]);
        setClientPropIds([]);
      }
      setPage(1);
    }
    if (state.dateFrom != null || state.dateTo != null) {
      setDateFrom(state.dateFrom);
      setDateTo(state.dateTo);
      setPage(1);
    }
    if (state.kinds && state.kinds.length > 0) {
      setKinds(state.kinds);
      setPage(1);
    } else if (state.typeFilter === 'deposit') {
      setKinds(['deposit']);
      setPage(1);
    } else if (state.typeFilter === 'expense') {
      setKinds(['expense']);
      setPage(1);
    } else if (state.propertyId || state.clientPropId || state.ownerId) {
      setKinds(['deposit', 'expense']);
    }
    if (state.sections) {
      setSections(state.sections);
      setPage(1);
    }
    if (state.sources) {
      setSources(state.sources);
      setPage(1);
    }
    if (state.sourceFiles) {
      setSourceFiles(state.sourceFiles);
      setPage(1);
    }
    if (state.alertFilters) {
      setAlertFilters(state.alertFilters);
      setPage(1);
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
    kinds.includes('bank_statement') ||
    alertFilters.includes('incomplete_import');
  const includeExpenses =
    kinds.length === 0 ||
    kinds.includes('expense') ||
    kinds.includes('he_she_paid') ||
    kinds.includes('owner_paid') ||
    kinds.includes('bank_statement') ||
    kinds.includes('nearly_cc') ||
    alertFilters.includes('incomplete_import');

  const singleSourceFile = sourceFiles.length === 1 ? sourceFiles[0] : undefined;
  const needsReviewOnly = alertFilters.includes('incomplete_import') ? true : undefined;

  // Narrow list fetches when a single Type lane is selected.
  const depositTypeFilter =
    kinds.length === 1 && kinds[0] === 'deposit'
      ? false
      : kinds.length === 1 && kinds[0] === 'rental_income'
        ? true
        : undefined;
  const expenseResidentFilter =
    kinds.length === 1 && kinds[0] === 'he_she_paid'
      ? true
      : kinds.length === 1 && kinds[0] === 'expense'
        ? false
        : undefined;
  const expenseOwnerFilter =
    kinds.length === 1 && kinds[0] === 'owner_paid'
      ? true
      : kinds.length === 1 && kinds[0] === 'expense'
        ? false
        : undefined;

  const listFilters = {
    ...sharedFilters,
    source_file: singleSourceFile,
    needs_review: needsReviewOnly,
  };

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary', sharedFilters, apiSection, apiSource, singleSourceFile],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        source_file: singleSourceFile,
        include_all: false,
      }),
    enabled: includeExpenses,
  });
  const depositSummaryQuery = useQuery({
    queryKey: ['deposit-summary', sharedFilters, singleSourceFile],
    queryFn: () =>
      api.getDepositSummary({
        ...sharedFilters,
        source_file: singleSourceFile,
        include_all: false,
      }),
    enabled: includeDeposits,
  });
  const depositRentalSummaryQuery = useQuery({
    queryKey: ['deposit-summary-rental', sharedFilters, singleSourceFile],
    queryFn: () =>
      api.getDepositSummary({
        ...sharedFilters,
        source_file: singleSourceFile,
        is_rental_income: true,
      }),
    enabled: includeDeposits && (kinds.length === 0 || kinds.includes('rental_income')),
  });
  const expenseHeSheSummaryQuery = useQuery({
    queryKey: ['expense-summary-heshe', sharedFilters, apiSection, apiSource, singleSourceFile],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        source_file: singleSourceFile,
        paid_by_resident: true,
      }),
    enabled: includeExpenses && (kinds.length === 0 || kinds.includes('he_she_paid')),
  });
  const expenseOwnerPaidSummaryQuery = useQuery({
    queryKey: ['expense-summary-owner', sharedFilters, apiSection, apiSource, singleSourceFile],
    queryFn: () =>
      api.getExpenseSummary({
        ...sharedFilters,
        category: apiSection,
        source: apiSource,
        source_file: singleSourceFile,
        paid_by_owner: true,
      }),
    enabled: includeExpenses && (kinds.length === 0 || kinds.includes('owner_paid')),
  });

  const depositsQuery = useQuery({
    queryKey: ['deposits', listFilters, depositTypeFilter],
    queryFn: () =>
      api.getAllDeposits({
        ...listFilters,
        is_rental_income: depositTypeFilter,
      }),
    enabled: includeDeposits,
  });

  const expensesQuery = useQuery({
    queryKey: [
      'expenses',
      listFilters,
      apiSection,
      apiSource,
      expenseResidentFilter,
      expenseOwnerFilter,
    ],
    queryFn: () =>
      api.getAllExpenses({
        ...listFilters,
        category: apiSection,
        source: apiSource,
        paid_by_resident: expenseResidentFilter,
        paid_by_owner: expenseOwnerFilter,
      }),
    enabled: includeExpenses,
  });

  const createMutation = useMutation({
    mutationFn: api.createExpense,
    onSuccess: () => {
      invalidateTransactionSummaries(queryClient);
      setForm(makeEmptyForm());
      setShowForm(false);
      setFormError(null);
    },
    onError: (error: Error) => {
      setFormError(error);
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
      invalidateTransactionSummaries(queryClient);
      setEditForm(null);
      setEditError(null);
    },
    onError: (error: Error) => setEditError(error),
  });

  const deleteTransactionMutation = useMutation({
    mutationFn: async (payload: { kind: TransactionKind; id: string }) => {
      if (payload.kind === 'expense') {
        return api.deleteExpense(payload.id);
      }
      return api.deleteDeposit(payload.id);
    },
    onSuccess: () => {
      invalidateTransactionSummaries(queryClient);
      setEditForm(null);
      setEditError(null);
    },
    onError: (error: Error) => setEditError(error),
  });

  const typeOptions = useMemo(
    () => [
      { value: 'deposit', label: 'Deposit (Inflow)' },
      { value: 'expense', label: 'Expense (Amount)' },
      { value: 'rental_income', label: 'Rental income' },
      { value: 'he_she_paid', label: 'He/She paid' },
      { value: 'owner_paid', label: 'Owner paid' },
      { value: 'bank_statement', label: 'Bank statement' },
      { value: 'nearly_cc', label: 'Nearly CC' },
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

  const sourceFileOptions = useMemo(() => {
    const names = new Set<string>();
    for (const row of depositsQuery.data?.items ?? []) {
      if (row.source_file) names.add(row.source_file);
    }
    for (const row of expensesQuery.data?.items ?? []) {
      if (row.source_file) names.add(row.source_file);
    }
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value }));
  }, [depositsQuery.data, expensesQuery.data]);

  const {
    items,
    total,
    totalPages,
    depositTotal,
    expenseTotal,
    depositCount,
    expenseTotalCount,
    netTotal,
    inflowSubtitle,
    expenseSubtitle,
    outsideSelectedCount,
    moneyRowCount,
    listedRowCount,
  } = useMemo(() => {
      const deposits = includeDeposits
        ? (depositsQuery.data?.items ?? []).map(depositToUnified)
        : [];
      const expenses = includeExpenses
        ? (expensesQuery.data?.items ?? []).map(expenseToUnified)
        : [];
      let merged = [...deposits, ...expenses].sort((a, b) => {
        // Newest date first. Missing date goes to the end.
        // Missing amount keeps its date position (or end if date is also missing).
        const aHasDate = Boolean(a.transaction_date);
        const bHasDate = Boolean(b.transaction_date);
        if (aHasDate !== bHasDate) return aHasDate ? -1 : 1;
        const aTime = a.transaction_date ? new Date(a.transaction_date).getTime() : 0;
        const bTime = b.transaction_date ? new Date(b.transaction_date).getTime() : 0;
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
      if (sourceFiles.length > 0) {
        const fileSet = new Set(sourceFiles);
        merged = merged.filter((row) => Boolean(row.source_file && fileSet.has(row.source_file)));
      }

      // Card money totals: Excel Dashboard (Inflow=non-rental, Expenses=non-He/She/Owner-paid).
      // Matching = same Inflow/Expense rows + selected outside-total Type lanes.
      const wantsInflow = kinds.length === 0 || kinds.includes('deposit');
      const wantsExpense = kinds.length === 0 || kinds.includes('expense');
      const wantsRental = kinds.length === 0 || kinds.includes('rental_income');
      const wantsHeShe = kinds.length === 0 || kinds.includes('he_she_paid');
      const wantsOwnerPaid = kinds.length === 0 || kinds.includes('owner_paid');
      const laneOnly =
        kinds.length > 0 &&
        !wantsInflow &&
        !wantsExpense &&
        !wantsRental &&
        !wantsHeShe &&
        !wantsOwnerPaid &&
        (kinds.includes('bank_statement') || kinds.includes('nearly_cc'));

      const apiInflow = Number(depositSummaryQuery.data?.total_amount ?? 0);
      const apiExpenses = Number(expenseSummaryQuery.data?.total_amount ?? 0);
      const apiInflowCount = depositSummaryQuery.data?.deposit_count ?? 0;
      const apiExpenseCount = expenseSummaryQuery.data?.expense_count ?? 0;
      const rentalCount = depositRentalSummaryQuery.data?.deposit_count ?? 0;
      const heSheCount = expenseHeSheSummaryQuery.data?.expense_count ?? 0;
      const ownerPaidCount = expenseOwnerPaidSummaryQuery.data?.expense_count ?? 0;

      let cardInflow = 0;
      let cardExpenses = 0;
      let cardInflowCount = 0;
      let cardExpenseCount = 0;
      let inflowSubtitle = 'Inflow (Excel)';
      let expenseSubtitle = 'Amount (Excel)';

      if (wantsInflow) {
        cardInflow += apiInflow;
        cardInflowCount += apiInflowCount;
      }
      if (wantsExpense) {
        cardExpenses += apiExpenses;
        cardExpenseCount += apiExpenseCount;
      }

      // Multi-select entity filters (2+) / multi source-file are client-side on the full loaded set.
      const multiEntity =
        propertyIds.length > 1 ||
        clientPropIds.length > 1 ||
        ownerIds.length > 1 ||
        sections.length > 1;
      const clientSideFiltered =
        multiEntity || sources.length > 0 || sourceFiles.length > 1;
      if (clientSideFiltered) {
        const depItems = merged.filter(
          (row) => row.kind === 'deposit' && !row.is_rental_income,
        );
        const expItems = merged.filter(
          (row) =>
            row.kind === 'expense' && !row.paid_by_resident && !row.paid_by_owner,
        );
        cardInflow = depItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardExpenses = expItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardInflowCount = depItems.length;
        cardExpenseCount = expItems.length;
        inflowSubtitle = 'filtered rows';
        expenseSubtitle = 'filtered rows';
      } else if (laneOnly) {
        const depItems = merged.filter(
          (row) => row.kind === 'deposit' && !row.is_rental_income,
        );
        const expItems = merged.filter(
          (row) =>
            row.kind === 'expense' && !row.paid_by_resident && !row.paid_by_owner,
        );
        cardInflow = depItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardExpenses = expItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardInflowCount = depItems.length;
        cardExpenseCount = expItems.length;
        inflowSubtitle = kinds.includes('bank_statement') ? 'Bank statement' : 'filtered rows';
        expenseSubtitle = kinds.includes('nearly_cc')
          ? 'Nearly CC'
          : kinds.includes('bank_statement')
            ? 'Bank statement'
            : 'filtered rows';
      }

      let matchingCount = cardInflowCount + cardExpenseCount;
      let outsideSelectedCount = 0;
      if (clientSideFiltered || laneOnly || alertFilters.includes('incomplete_import')) {
        const outsideItems = merged.filter(
          (row) =>
            (row.kind === 'deposit' && row.is_rental_income) ||
            (row.kind === 'expense' && (row.paid_by_resident || row.paid_by_owner)),
        );
        outsideSelectedCount = outsideItems.length;
        matchingCount = merged.length;
      } else {
        if (wantsRental) outsideSelectedCount += rentalCount;
        if (wantsHeShe) outsideSelectedCount += heSheCount;
        if (wantsOwnerPaid) outsideSelectedCount += ownerPaidCount;
        matchingCount = cardInflowCount + cardExpenseCount + outsideSelectedCount;
      }

      const totalPagesCount = Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
      const start = (page - 1) * PAGE_SIZE;
      const pageItems = merged.slice(start, start + PAGE_SIZE);

      return {
        items: pageItems,
        total: matchingCount,
        totalPages: totalPagesCount,
        depositTotal: cardInflow,
        expenseTotal: cardExpenses,
        depositCount: cardInflowCount,
        expenseTotalCount: cardExpenseCount,
        netTotal: cardInflow - cardExpenses,
        inflowSubtitle,
        expenseSubtitle,
        outsideSelectedCount,
        moneyRowCount: cardInflowCount + cardExpenseCount,
        listedRowCount: merged.length,
      };
    }, [
      alertFilters,
      clientPropIds,
      depositRentalSummaryQuery.data,
      depositSummaryQuery.data,
      depositsQuery.data,
      expenseHeSheSummaryQuery.data,
      expenseOwnerPaidSummaryQuery.data,
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
      sourceFiles,
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
      sources.length ||
      sourceFiles.length,
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
    setSourceFiles([]);
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
      setEditError(validationError('Please choose a property (Prop ID).'));
      return;
    }
    if (!editForm.transaction_date || !editForm.amount || Number(editForm.amount) <= 0) {
      setEditError(validationError('Please enter a date and an amount greater than 0.'));
      return;
    }
    updateTransactionMutation.mutate(editForm);
  }

  function deleteEdit() {
    if (!editForm) return;
    const kindLabel = editForm.kind === 'deposit' ? 'deposit' : 'expense';
    const confirmed = window.confirm(
      `Delete this ${kindLabel}? This cannot be undone.`,
    );
    if (!confirmed) return;
    deleteTransactionMutation.mutate({ kind: editForm.kind, id: editForm.id });
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
    return (
      <ErrorState
        message="We couldn't load transactions. Please try again in a moment."
        error={
          propertiesQuery.error ??
          ownersQuery.error ??
          depositsQuery.error ??
          expensesQuery.error
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="page-heading">Transactions</h2>
          <p className="page-desc">
            Same ledger as your Excel: Prop ID, Date, Section, Notes, Amount, and Balance — plus
            Property and Owner for easier browsing. Newest dates first; rows without a date appear
            at the end. Incomplete imports (missing date/amount) stay in Alerts until fixed or
            dismissed. He/She paid and rental income are marked like in the spreadsheet.
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
          subtitle={`${depositCount} row(s) · ${inflowSubtitle}`}
          tooltip="Matches Excel Dashboard Inflow (sum of Inflow column). Rental income can be filtered in the list but is never included in this total."
        />
        <Card
          title="Expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseTotalCount} row(s) · ${expenseSubtitle}`}
          tooltip="Matches Excel Dashboard Expenses (sum of Amount column). He/She paid can be filtered in the list but is never included in this total. Credit-card imports are included in the app but not on the Excel Dashboard."
        />
        <Card
          title="Balance"
          value={formatCurrency(netTotal)}
          subtitle="Inflow minus Expenses (excludes Rental / He-She)"
          tooltip="Same as Excel Dashboard Balance: Inflow − Expenses. Rental income and He/She paid are excluded even when filtered."
        />
        <Card
          title="Matching"
          value={total}
          subtitle={
            outsideSelectedCount > 0
              ? `${moneyRowCount} in Inflow/Expenses + ${outsideSelectedCount} outside totals`
              : `${moneyRowCount} = Inflow + Expenses rows`
          }
          tooltip="Matching is Inflow rows + Expenses rows, plus Rental / He-She / Owner-paid when those Type filters are selected. Money totals still exclude those labels."
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
            Fields use the same names as your Excel sheet (Section, Notes, Method, Source, Company).
          </p>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!form.property_id || !form.transaction_date || !form.amount) {
                setFormError(
                  validationError('Please choose a property, date, and amount.'),
                );
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
                payment_method: form.payment_method || 'company_account',
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
            <DateInputDMY
              label="Date"
              required
              value={form.transaction_date || undefined}
              onChange={(iso) =>
                setForm((current) => ({ ...current, transaction_date: iso ?? '' }))
              }
            />
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
                <Tooltip content="How this expense was recorded (e.g. standing order).">
                  Source
                </Tooltip>
              </span>
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
              <div className="md:col-span-2 xl:col-span-3">
                <InlineError error={formError} />
              </div>
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
          tip="Deposit/Expense match Excel Inflow/Amount. Rental, He/She, Owner paid, Bank statement, and Nearly CC are separate lanes you can filter."
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
          tip="Filter to incomplete import rows (missing date and/or amount). Those also appear under Alerts until dismissed or fixed."
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
        <SearchableMultiSelect
          label="Source file"
          tip="Original import/upload filename for the row."
          options={sourceFileOptions}
          selected={sourceFiles}
          onChange={(next) => {
            setSourceFiles(next);
            resetPage();
          }}
          placeholder="All source files"
          searchPlaceholder="Search file…"
        />
      </section>

      <section className="panel overflow-hidden">
        <div className="w-full min-w-0">
          <table className="table-shell">
            <colgroup>
              <col className="w-[11%]" />
              <col className="w-[6%]" />
              <col className="w-[7%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[7%]" />
              <col className="w-[5%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead className="table-head">
              <tr>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Deposit = Inflow · Expense = Amount (Excel money columns).">
                    Type
                  </Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Excel Prop ID.">Prop ID</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">Date</th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Excel Section.">Section</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Excel Notes.">Notes</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Excel Amount (out) or Inflow (in).">Amount</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Running company-float balance after this row (like Excel Balance).">
                    Balance
                  </Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Excel Company — vendor or payee.">Company</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">Property</th>
                <th className="px-2 py-3 font-medium">Owner</th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="File this row was imported from.">Source file</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">
                  <Tooltip content="Linked receipt (Excel Reciept), if uploaded.">Receipt</Tooltip>
                </th>
                <th className="px-2 py-3 font-medium">Actions</th>
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
                      <td className="px-2 py-3">
                        <div className="flex flex-wrap items-center gap-1">
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
                      <td className="px-2 py-3 font-mono text-xs font-medium truncate" title={row.client_prop_id}>
                        {row.client_prop_id}
                      </td>
                      <td className="px-2 py-3 truncate">
                        {row.transaction_date ? (
                          formatDate(row.transaction_date)
                        ) : row.needs_review ? (
                          reviewBang(row)
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-2 py-3 truncate" title={row.section || undefined}>
                        {row.section}
                      </td>
                      <td className="px-2 py-3 muted-text truncate" title={row.notes || undefined}>
                        {row.notes || '—'}
                      </td>
                      <td
                        className={`px-2 py-3 tabular-nums truncate ${
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
                          reviewBang(row)
                        ) : (
                          <>
                            {row.kind === 'deposit' ? '+' : '−'}
                            {formatCurrency(row.amount, row.currency)}
                          </>
                        )}
                      </td>
                      <td
                        className={`px-2 py-3 tabular-nums font-medium truncate ${
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
                      <td className="px-2 py-3 muted-text truncate" title={row.company || undefined}>
                        {row.company || '—'}
                      </td>
                      <td className="px-2 py-3 font-medium truncate" title={row.property_name}>
                        {row.property_name}
                      </td>
                      <td className="px-2 py-3 truncate" title={row.owner_name}>
                        {row.owner_name}
                      </td>
                      <td
                        className="px-2 py-3 text-xs muted-text truncate"
                        title={row.source_file ?? undefined}
                      >
                        {row.source_file || '—'}
                      </td>
                  <td className="px-2 py-3">
                    {isUploadReceiptRef(row.receipt_ref) ? (
                      <a
                        href={api.getUploadFileUrl(row.receipt_ref!, { download: true })}
                        download={row.source_file || undefined}
                        className="btn-icon"
                        aria-label="Download file"
                        title="Download"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                          <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                        </svg>
                      </a>
                    ) : (
                      <span className="muted-text text-xs">—</span>
                    )}
                  </td>
                      <td className="px-2 py-3">
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <Tooltip content="Close" hideHint>
                              <button
                                type="button"
                                className="btn-icon"
                                onClick={cancelEdit}
                                aria-label="Close edit"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                >
                                  <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
                                </svg>
                              </button>
                            </Tooltip>
                          ) : (
                            <Tooltip content="Edit" hideHint>
                              <button
                                type="button"
                                className="btn-icon"
                                onClick={() => openEdit(row)}
                                aria-label="Edit transaction"
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                >
                                  <path d="m2.695 14.762-1.262 3.155a.5.5 0 0 0 .65.65l3.155-1.262a4 4 0 0 0 1.343-.886L17.5 5.501a2.121 2.121 0 0 0-3-3L3.58 13.419a4 4 0 0 0-.885 1.343Z" />
                                </svg>
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content="Feedback" hideHint>
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() =>
                                openFeedback({
                                  initialMessage: formatTransactionFeedback(row),
                                })
                              }
                              aria-label="Send feedback"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="h-4 w-4"
                                aria-hidden="true"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M10 2c-2.236 0-4.43.18-6.512.512C2.35 2.718 1.5 3.958 1.5 5.373v4.254c0 1.415.85 2.655 1.988 2.86 1.113.178 2.259.3 3.418.364V16.5a.75.75 0 0 0 1.28.53l2.754-2.753A32.978 32.978 0 0 0 10 14c2.236 0 4.43-.18 6.512-.512 1.138-.205 1.988-1.445 1.988-2.86V5.373c0-1.415-.85-2.655-1.988-2.86A33.001 33.001 0 0 0 10 2Zm0 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM7 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm6 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
                                  clipRule="evenodd"
                                />
                              </svg>
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                    {isEditing ? (
                      <tr className="bg-slate-50/80 dark:bg-slate-900/40">
                        <td colSpan={13} className="p-0">
                          <div className="box-border max-w-full px-4 py-4">
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
                                      {editForm.payment_method &&
                                      !(METHODS as readonly string[]).includes(
                                        editForm.payment_method,
                                      ) ? (
                                        <option value={editForm.payment_method}>
                                          {label(editForm.payment_method)}
                                        </option>
                                      ) : null}
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
                                      {editForm.source &&
                                      !(SOURCES as readonly string[]).includes(editForm.source) ? (
                                        <option value={editForm.source}>
                                          {label(editForm.source)}
                                        </option>
                                      ) : null}
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
                                <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                  <InlineError error={editError} />
                                </div>
                              ) : null}
                              <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                <button
                                  type="button"
                                  className="btn-primary"
                                  disabled={
                                    updateTransactionMutation.isPending ||
                                    deleteTransactionMutation.isPending
                                  }
                                  onClick={saveEdit}
                                >
                                  {updateTransactionMutation.isPending
                                    ? 'Saving…'
                                    : 'Save changes'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  disabled={
                                    updateTransactionMutation.isPending ||
                                    deleteTransactionMutation.isPending
                                  }
                                  onClick={cancelEdit}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  className="btn-danger ml-auto"
                                  disabled={
                                    updateTransactionMutation.isPending ||
                                    deleteTransactionMutation.isPending
                                  }
                                  onClick={deleteEdit}
                                >
                                  {deleteTransactionMutation.isPending
                                    ? 'Deleting…'
                                    : 'Delete'}
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
        {items.length === 0 ? (
          <div className="p-5">
            <EmptyState message="No transactions match the current filters." />
          </div>
        ) : null}
        <div className="table-footer">
          <span>
            Showing {items.length} of {listedRowCount} loaded
            {total !== listedRowCount ? ` · ${total} match filters` : ''}
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
