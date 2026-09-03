import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DepositCreate, ExpenseCreate } from '../types';
import {
  TransactionDisplayCells,
  TransactionTableColgroup,
  TransactionTableHeader,
} from '../components/TransactionTable';
import {
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  formatCurrency,
  LoadingState,
} from '../components/ui/States';
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import { DateInputDMY } from '../components/ui/DateInputDMY';
import {
  TransactionFilterFields,
  type TransactionEntityFilters,
} from '../components/ui/TransactionFilterFields';
import { Tooltip } from '../components/ui/Tooltip';
import { TransactionUploadPanel } from '../components/TransactionUploadPanel';
import { useFeedback } from '../context/FeedbackContext';
import {
  syncClientPropIdsFromProperties,
  syncPropertyIdsFromPropIds,
  useOwnerPropertyFilterOptions,
} from '../hooks/useOwnerPropertyFilterOptions';
import {
  formatTransactionFeedback,
  isCompanyFloatDeposit,
  isCompanyFloatExpense,
  mergeAndSortTransactions,
  transactionRowClassName,
  type TransactionKind,
  type UnifiedTransaction,
} from '../utils/unifiedTransaction';
import {
  EXPENSE_SOURCES as SOURCES,
  PAYMENT_METHODS as METHODS,
  SECTION_SUGGESTIONS,
} from '../constants/expenseOptions';
import { todayISO } from '../utils/dateFormat';
import { validationError } from '../utils/errors';
import { formatLabel } from '../utils/formatLabel';
import { invalidateTransactionData } from '../utils/invalidateQueries';
import {
  buildTxnListFilters,
  buildTxnSharedFilters,
} from '../utils/prefetchTransactions';
import { parseTransactionsLocationState } from '../utils/transactionsNav';

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
type PropertyStatusFilter = 'active' | 'inactive';

function label(value: string) {
  return formatLabel(value);
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

const PAGE_SIZE = 50;

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

function makeEmptyDepositForm(): DepositCreate {
  return {
    property_id: '',
    transaction_date: todayISO(),
    amount: '',
    currency: 'ILS',
    category: '',
    payment_method: 'company_account',
    source: 'manual_company',
    vendor_name: '',
    description: '',
    is_rental_income: false,
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
  // UTF-8 BOM so Excel (Windows) treats Hebrew/Unicode as UTF-8, not ANSI.
  const blob = new Blob(['\uFEFF' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;',
  });
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
  const [propertyStatuses, setPropertyStatuses] = useState<PropertyStatusFilter[]>(['active']);
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
  const [showDepositForm, setShowDepositForm] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [form, setForm] = useState<ExpenseCreate>(() => makeEmptyForm());
  const [depositForm, setDepositForm] = useState<DepositCreate>(() => makeEmptyDepositForm());
  const [formError, setFormError] = useState<unknown>(null);
  const [editForm, setEditForm] = useState<TransactionEditForm | null>(null);
  const [editError, setEditError] = useState<unknown>(null);
  const [highlightId, setHighlightId] = useState<string | undefined>();
  const [highlightKind, setHighlightKind] = useState<string | undefined>();
  const highlightClearRef = useRef<number | null>(null);

  useEffect(() => {
    const state = parseTransactionsLocationState(location.state);
    if (!state) return;

    if (state.showUpload) {
      setShowUpload(true);
      setShowForm(false);
      setShowDepositForm(false);
    }
    if (state.showForm) {
      setShowForm(true);
      setShowDepositForm(false);
      setShowUpload(false);
    }

    const nextPropertyIds = state.propertyIds?.length ? state.propertyIds : null;
    const nextClientPropIds = state.clientPropIds?.length ? state.clientPropIds : null;
    const nextOwnerIds = state.ownerIds?.length ? state.ownerIds : null;

    if (nextPropertyIds || nextClientPropIds) {
      setPropertyIds(nextPropertyIds ?? []);
      setClientPropIds(nextClientPropIds ?? []);
      if (!nextOwnerIds) setOwnerIds([]);
      // Deep links should show the linked property even if inactive.
      setPropertyStatuses(['active', 'inactive']);
      setPage(1);
    }
    if (nextOwnerIds) {
      setOwnerIds(nextOwnerIds);
      if (!nextPropertyIds && !nextClientPropIds) {
        setPropertyIds([]);
        setClientPropIds([]);
      }
      setPropertyStatuses(['active', 'inactive']);
      setPage(1);
    }
    if (state.dateFrom != null || state.dateTo != null) {
      setDateFrom(state.dateFrom);
      setDateTo(state.dateTo);
      setPage(1);
    }
    if (state.kinds && state.kinds.length > 0) {
      setKinds(state.kinds as TypeFilterKind[]);
      setPage(1);
    } else if (state.typeFilter === 'deposit') {
      setKinds(['deposit']);
      setPage(1);
    } else if (state.typeFilter === 'expense') {
      setKinds(['expense']);
      setPage(1);
    } else if (nextPropertyIds || nextClientPropIds || nextOwnerIds) {
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
      setAlertFilters(state.alertFilters as AlertFilterKind[]);
      setPage(1);
    }
    if (state.highlightId) {
      setHighlightId(state.highlightId);
      setHighlightKind(state.highlightKind);
    }
  }, [location.state]);

  const apiPropertyId = propertyIds.length === 1 ? propertyIds[0] : undefined;
  const apiPropertyIds = propertyIds.length > 1 ? propertyIds : undefined;
  const apiClientPropId = clientPropIds.length === 1 ? clientPropIds[0] : undefined;
  const apiClientPropIds = clientPropIds.length > 1 ? clientPropIds : undefined;
  const apiOwnerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
  const apiOwnerIds = ownerIds.length > 1 ? ownerIds : undefined;
  const apiPropertyStatus =
    propertyStatuses.length === 1 ? propertyStatuses[0] : undefined;
  const apiSection = sections.length === 1 ? sections[0] : undefined;
  const apiSource = sources.length === 1 ? sources[0] : undefined;

  const sharedFilters = buildTxnSharedFilters({
    property_id: apiPropertyId,
    property_ids: apiPropertyIds,
    client_prop_id: apiClientPropId,
    client_prop_ids: apiClientPropIds,
    owner_id: apiOwnerId,
    owner_ids: apiOwnerIds,
    property_status: apiPropertyStatus,
    date_from: dateFrom,
    date_to: dateTo,
  });

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

  // Server-page when only one stream is needed and multi-value client-only filters are idle.
  const useServerPaging =
    !(includeDeposits && includeExpenses) &&
    sections.length <= 1 &&
    sources.length <= 1 &&
    sourceFiles.length <= 1;

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

  const listFilters = buildTxnListFilters({
    ...sharedFilters,
    source_file: singleSourceFile,
    needs_review: needsReviewOnly,
  });

  const {
    properties,
    ownerOptions,
    propertyOptions,
    propIdOptions,
    propertiesQuery,
    ownersQuery,
  } = useOwnerPropertyFilterOptions();

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
    queryKey: [
      'deposits',
      listFilters,
      depositTypeFilter,
      useServerPaging ? 'page' : 'all',
      useServerPaging ? page : null,
    ],
    queryFn: () =>
      useServerPaging
        ? api.getDeposits({
            ...listFilters,
            is_rental_income: depositTypeFilter,
            page,
            page_size: PAGE_SIZE,
          })
        : api.getAllDeposits({
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
      useServerPaging ? 'page' : 'all',
      useServerPaging ? page : null,
    ],
    queryFn: () =>
      useServerPaging
        ? api.getExpenses({
            ...listFilters,
            category: apiSection,
            source: apiSource,
            paid_by_resident: expenseResidentFilter,
            paid_by_owner: expenseOwnerFilter,
            page,
            page_size: PAGE_SIZE,
          })
        : api.getAllExpenses({
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
      invalidateTransactionData(queryClient);
      setForm(makeEmptyForm());
      setShowForm(false);
      setFormError(null);
    },
    onError: (error: Error) => {
      setFormError(error);
    },
  });

  const createDepositMutation = useMutation({
    mutationFn: api.createDeposit,
    onSuccess: () => {
      invalidateTransactionData(queryClient);
      setDepositForm(makeEmptyDepositForm());
      setShowDepositForm(false);
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
      invalidateTransactionData(queryClient);
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
      invalidateTransactionData(queryClient);
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

  const propertyStatusOptions = useMemo(
    () => [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
    [],
  );

  const statusFilteredPropertyOptions = useMemo(() => {
    if (propertyStatuses.length !== 1) return propertyOptions;
    const status = propertyStatuses[0];
    const allowed = new Set(
      properties.filter((property) => property.status === status).map((property) => property.id),
    );
    return propertyOptions.filter((option) => allowed.has(option.value));
  }, [properties, propertyOptions, propertyStatuses]);

  const statusFilteredPropIdOptions = useMemo(() => {
    if (propertyStatuses.length !== 1) return propIdOptions;
    const status = propertyStatuses[0];
    const allowed = new Set(
      properties
        .filter((property) => property.status === status)
        .map((property) => property.client_prop_id),
    );
    return propIdOptions.filter((option) => allowed.has(option.value));
  }, [properties, propIdOptions, propertyStatuses]);

  const alertOptions = useMemo(
    () => [{ value: 'incomplete_import', label: 'Incomplete import' }],
    [],
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
    highlightPage,
  } = useMemo(() => {
      let merged = mergeAndSortTransactions(
        includeDeposits ? (depositsQuery.data?.items ?? []) : [],
        includeExpenses ? (expensesQuery.data?.items ?? []) : [],
      );

      if (kinds.length > 0) {
        const kindSet = new Set(kinds);
        merged = merged.filter((row) => rowTypeTags(row).some((tag) => kindSet.has(tag)));
      }
      if (alertFilters.includes('incomplete_import')) {
        merged = merged.filter((row) => Boolean(row.needs_review));
      }
      // property/owner/client-prop filters are applied server-side via listFilters.
      if (sections.length > 1) {
        const set = new Set(sections.map((value) => value.toLowerCase()));
        merged = merged.filter((row) => set.has(row.section.toLowerCase()));
      }
      if (sources.length > 1) {
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
      if (sourceFiles.length > 1) {
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

      // Multi section/source/file still need client totals from the loaded set.
      const clientSideFiltered =
        sections.length > 1 || sources.length > 1 || sourceFiles.length > 1;
      if (clientSideFiltered) {
        const depItems = merged.filter(isCompanyFloatDeposit);
        const expItems = merged.filter(isCompanyFloatExpense);
        cardInflow = depItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardExpenses = expItems.reduce((sum, row) => sum + Number(row.amount), 0);
        cardInflowCount = depItems.length;
        cardExpenseCount = expItems.length;
        inflowSubtitle = 'filtered rows';
        expenseSubtitle = 'filtered rows';
      } else if (laneOnly) {
        const depItems = merged.filter(isCompanyFloatDeposit);
        const expItems = merged.filter(isCompanyFloatExpense);
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

      const totalPagesCount = useServerPaging
        ? Math.max(
            1,
            Math.ceil(
              (includeDeposits
                ? (depositsQuery.data?.total ?? 0)
                : (expensesQuery.data?.total ?? 0)) / PAGE_SIZE,
            ),
          )
        : Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
      let highlightPageNum: number | undefined;
      if (!useServerPaging && highlightId) {
        const highlightIndex = merged.findIndex(
          (row) =>
            row.id === highlightId &&
            (!highlightKind || row.kind === highlightKind),
        );
        if (highlightIndex >= 0) {
          highlightPageNum = Math.floor(highlightIndex / PAGE_SIZE) + 1;
        }
      }
      const start = (page - 1) * PAGE_SIZE;
      const pageItems = useServerPaging
        ? merged
        : merged.slice(start, start + PAGE_SIZE);

      const serverListedTotal = useServerPaging
        ? includeDeposits
          ? (depositsQuery.data?.total ?? merged.length)
          : (expensesQuery.data?.total ?? merged.length)
        : merged.length;

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
        listedRowCount: serverListedTotal,
        highlightPage: highlightPageNum,
      };
    }, [
      alertFilters,
      depositRentalSummaryQuery.data,
      depositSummaryQuery.data,
      depositsQuery.data,
      expenseHeSheSummaryQuery.data,
      expenseOwnerPaidSummaryQuery.data,
      expenseSummaryQuery.data,
      expensesQuery.data,
      highlightId,
      highlightKind,
      includeDeposits,
      includeExpenses,
      kinds,
      page,
      sections,
      sourceFiles,
      sources,
      useServerPaging,
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

  useEffect(() => {
    if (highlightPage != null && highlightPage !== page) {
      setPage(highlightPage);
    }
  }, [highlightPage, page]);

  useEffect(() => {
    if (!highlightId) return;
    const rowId = `txn-${highlightKind ?? 'deposit'}-${highlightId}`;
    const el = document.getElementById(rowId);
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlightClearRef.current != null) {
      window.clearTimeout(highlightClearRef.current);
    }
    highlightClearRef.current = window.setTimeout(() => {
      setHighlightId(undefined);
      setHighlightKind(undefined);
      highlightClearRef.current = null;
    }, 3500);
    return () => {
      if (highlightClearRef.current != null) {
        window.clearTimeout(highlightClearRef.current);
        highlightClearRef.current = null;
      }
    };
  }, [highlightId, highlightKind, items]);

  function resetPage() {
    setPage(1);
  }

  const hasActiveFilters = Boolean(
    kinds.length !== 2 ||
      !kinds.includes('deposit') ||
      !kinds.includes('expense') ||
      propertyStatuses.length !== 1 ||
      propertyStatuses[0] !== 'active' ||
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
    setPropertyStatuses(['active']);
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
    setShowDepositForm(false);
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

  function syncEntityFilters(next: TransactionEntityFilters) {
    setOwnerIds(next.ownerIds);
    setPropertyIds(next.propertyIds);
    setClientPropIds(next.clientPropIds);
    setDateFrom(next.dateFrom);
    setDateTo(next.dateTo);
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
      <div className="flex flex-nowrap items-center justify-between gap-3">
        <h2 className="page-heading shrink-0">Transactions</h2>
        <div className="flex flex-nowrap items-center justify-end gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => {
              setShowUpload((current) => !current);
              if (!showUpload) {
                setShowForm(false);
                setShowDepositForm(false);
              }
            }}
            className="btn-secondary shrink-0"
          >
            {showUpload ? 'Cancel upload' : 'Import from file'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowDepositForm((current) => {
                const next = !current;
                if (next) {
                  setDepositForm(makeEmptyDepositForm());
                  setFormError(null);
                  setShowForm(false);
                  setShowUpload(false);
                }
                return next;
              });
            }}
            className="btn-primary shrink-0"
          >
            {showDepositForm ? 'Cancel' : 'Add deposit'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowForm((current) => {
                const next = !current;
                if (next) {
                  setForm(makeEmptyForm());
                  setFormError(null);
                  setShowDepositForm(false);
                  setShowUpload(false);
                }
                return next;
              });
            }}
            className="btn-primary shrink-0"
          >
            {showForm ? 'Cancel' : 'Add expense'}
          </button>
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                items.map((row) => ({
                  Ref: row.transaction_ref ?? '',
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
            className="btn-secondary shrink-0"
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
          properties={properties}
          onClose={() => setShowUpload(false)}
        />
      ) : null}

      {showDepositForm ? (
        <section className="panel p-4">
          <h3 className="subheading">New deposit</h3>
          <p className="mt-1 text-sm text-muted">
            Fields use the same names as your Excel sheet (Section, Notes, Method, Source,
            Company).
          </p>
          <form
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !depositForm.property_id ||
                !depositForm.transaction_date ||
                !depositForm.amount
              ) {
                setFormError(
                  validationError('Please choose a property, date, and amount.'),
                );
                return;
              }
              createDepositMutation.mutate({
                ...depositForm,
                category: depositForm.category?.trim() || 'Inflow',
                source: depositForm.source || 'manual_company',
                payment_method: depositForm.payment_method || 'company_account',
                vendor_name: depositForm.vendor_name?.trim() || undefined,
                description: depositForm.description?.trim() || undefined,
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
                value={depositForm.property_id}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    property_id: event.target.value,
                  }))
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
              value={depositForm.transaction_date || undefined}
              onChange={(iso) =>
                setDepositForm((current) => ({
                  ...current,
                  transaction_date: iso ?? '',
                }))
              }
            />
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Excel Inflow column — money entering the company float.">
                  Amount
                </Tooltip>
              </span>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                className="field"
                value={depositForm.amount}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
              />
            </label>
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Excel Section — what the inflow is for.">Section</Tooltip>
              </span>
              <input
                list="deposit-section-suggestions"
                type="text"
                className="field"
                placeholder="e.g. Owner inflow"
                value={depositForm.category ?? ''}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    category: event.target.value,
                  }))
                }
              />
              <datalist id="deposit-section-suggestions">
                {SECTION_SUGGESTIONS.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="How the money was received (for your records).">
                  Method
                </Tooltip>
              </span>
              <select
                className="field"
                value={depositForm.payment_method ?? 'company_account'}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    payment_method: event.target.value,
                  }))
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
                <Tooltip content="How this deposit was recorded (e.g. bank statement).">
                  Source
                </Tooltip>
              </span>
              <select
                className="field"
                value={depositForm.source ?? 'manual_company'}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    source: event.target.value,
                  }))
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
                <Tooltip content="Excel Company — payer or counterparty name.">
                  Company
                </Tooltip>
              </span>
              <input
                type="text"
                className="field"
                placeholder="Payer / company name"
                value={depositForm.vendor_name ?? ''}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    vendor_name: event.target.value,
                  }))
                }
              />
            </label>
            <label className="text-sm flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={Boolean(depositForm.is_rental_income)}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    is_rental_income: event.target.checked,
                  }))
                }
              />
              <span className="label-text mb-0">
                <Tooltip content="Mark as rental income (tracked rent, not company-float inflow).">
                  Rental income
                </Tooltip>
              </span>
            </label>
            <label className="text-sm md:col-span-2 xl:col-span-3">
              <span className="label-text">
                <Tooltip content="Excel Notes — free text about the row.">Notes</Tooltip>
              </span>
              <input
                type="text"
                className="field"
                placeholder="Optional notes"
                value={depositForm.description ?? ''}
                onChange={(event) =>
                  setDepositForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            {formError && showDepositForm ? (
              <div className="md:col-span-2 xl:col-span-3">
                <InlineError error={formError} />
              </div>
            ) : null}
            <div className="md:col-span-2 xl:col-span-3">
              <button
                type="submit"
                disabled={createDepositMutation.isPending}
                className="btn-primary"
              >
                {createDepositMutation.isPending ? 'Saving...' : 'Save deposit'}
              </button>
            </div>
          </form>
        </section>
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
            <label className="text-sm flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={form.payment_method === 'credit_card'}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    payment_method: event.target.checked
                      ? 'credit_card'
                      : current.payment_method === 'credit_card'
                        ? 'company_account'
                        : current.payment_method,
                    source: event.target.checked ? 'credit_card' : current.source,
                  }))
                }
              />
              <span className="label-text mb-0">
                <Tooltip content="Paid on the company credit card — awaits card statement verification (excluded from the bank gap as a merchant debit).">
                  Paid by card
                </Tooltip>
              </span>
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
            {formError && showForm ? (
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
        <TransactionFilterFields
          value={{
            ownerIds,
            propertyIds,
            clientPropIds,
            dateFrom,
            dateTo,
          }}
          onChange={syncEntityFilters}
          ownerOptions={ownerOptions}
          propertyOptions={statusFilteredPropertyOptions}
          propIdOptions={statusFilteredPropIdOptions}
          showAmounts={false}
          onSyncFromProperties={(nextPropertyIds) => ({
            propertyIds: nextPropertyIds,
            clientPropIds: syncClientPropIdsFromProperties(nextPropertyIds, properties),
          })}
          onSyncFromPropIds={(nextPropIds) => ({
            clientPropIds: nextPropIds,
            propertyIds: syncPropertyIdsFromPropIds(nextPropIds, properties),
          })}
          prepend={
            <>
              <SearchableMultiSelect
                label="Property status"
                tip="Show transactions for active and/or inactive properties. Default is active only."
                options={propertyStatusOptions}
                selected={propertyStatuses}
                onChange={(next) => {
                  setPropertyStatuses(next as PropertyStatusFilter[]);
                  setPropertyIds([]);
                  setClientPropIds([]);
              resetPage();
            }}
                placeholder="All statuses"
                searchPlaceholder="Search status…"
              />
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
            </>
          }
          append={
            <>
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
            </>
          }
        />
      </section>

      <section className="panel overflow-hidden">
        <div className="w-full min-w-0">
          <table className="table-shell">
            <TransactionTableColgroup />
            <TransactionTableHeader />
            <tbody>
              {items.map((row) => {
                const isEditing =
                  editForm?.id === row.id && editForm.kind === row.kind && editForm != null;
                const isHighlighted =
                  highlightId === row.id &&
                  (!highlightKind || highlightKind === row.kind);
                return (
                  <Fragment key={`${row.kind}-${row.id}`}>
                    <tr
                      id={`txn-${row.kind}-${row.id}`}
                      className={`${transactionRowClassName(row)}${
                        isEditing || isHighlighted ? ' table-row-selected' : ''
                      }${isHighlighted ? ' table-row-highlight' : ''}`}
                    >
                      <TransactionDisplayCells
                        row={row}
                        reviewMarker={row.needs_review ? reviewBang(row) : null}
                        actions={
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
                        }
                      />
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
