import type {
  DepositFilters,
  DepositGap,
  DepositListResponse,
  DepositSummary,
  ExpenseCreate,
  ExpenseFilters,
  ExpenseListResponse,
  ExpenseSummary,
  ExpenseUpdate,
  DepositUpdate,
  OwnerDetail,
  OwnerSummary,
  Property,
  PropertyDetail,
  TransactionDraft,
  UploadAnalyzeResponse,
  UploadConfirmResponse,
  AlertListResponse,
  AlertSummary,
  AlertResolveRequest,
  AlertItem,
  DepositCreate,
  FixIncompletePayload,
  FixIncompleteResponse,
  ClientDataStatusResponse,
  ClientDataImportJobAccepted,
  ClientDataImportJobStatus,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  getHealth: () => request<{ status: string }>('/health'),
  getTransactionYears: () => request<{ years: number[] }>('/meta/transaction-years'),
  getOwners: () => request<OwnerSummary[]>('/owners'),
  getOwner: (id: string) => request<OwnerDetail>(`/owners/${id}`),
  getProperties: () => request<Property[]>('/properties'),
  getProperty: (id: string) => request<PropertyDetail>(`/properties/${id}`),
  getDeposits: (filters: DepositFilters = {}) =>
    request<DepositListResponse>(
      `/deposits${toQuery({
        property_id: filters.property_id,
        client_prop_id: filters.client_prop_id,
        owner_id: filters.owner_id,
        date_from: filters.date_from,
        date_to: filters.date_to,
        min_amount: filters.min_amount,
        max_amount: filters.max_amount,
        page: filters.page,
        page_size: filters.page_size,
      })}`,
    ),
  getDepositSummary: (
    filters: {
      property_id?: string;
      client_prop_id?: string;
      owner_id?: string;
      date_from?: string;
      date_to?: string;
      min_amount?: string;
      max_amount?: string;
      include_all?: boolean;
    } = {},
  ) =>
    request<DepositSummary>(
      `/deposits/summary${toQuery({
        property_id: filters.property_id,
        client_prop_id: filters.client_prop_id,
        owner_id: filters.owner_id,
        date_from: filters.date_from,
        date_to: filters.date_to,
        min_amount: filters.min_amount,
        max_amount: filters.max_amount,
        include_all: filters.include_all ? 'true' : undefined,
      })}`,
    ),
  getDepositGaps: (filters: {
    year?: number;
    month?: number;
    date_from?: string;
    date_to?: string;
  } = {}) =>
    request<DepositGap[]>(
      `/deposits/gaps${toQuery({
        year: filters.year,
        month: filters.month,
        date_from: filters.date_from,
        date_to: filters.date_to,
      })}`,
    ),
  postAIQuery: (question: string) =>
    request<import('../types').AIQueryResponse>('/ai/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    }),
  getExpenses: (filters: ExpenseFilters = {}) =>
    request<ExpenseListResponse>(
      `/expenses${toQuery({
        property_id: filters.property_id,
        client_prop_id: filters.client_prop_id,
        owner_id: filters.owner_id,
        category: filters.category,
        source: filters.source,
        payment_method: filters.payment_method,
        date_from: filters.date_from,
        date_to: filters.date_to,
        page: filters.page,
        page_size: filters.page_size,
      })}`,
    ),
  getExpenseSummary: (
    filters: {
      property_id?: string;
      client_prop_id?: string;
      owner_id?: string;
      category?: string;
      source?: string;
      payment_method?: string;
      date_from?: string;
      date_to?: string;
      min_amount?: string;
      max_amount?: string;
      include_all?: boolean;
    } = {},
  ) =>
    request<ExpenseSummary>(
      `/expenses/summary${toQuery({
        property_id: filters.property_id,
        client_prop_id: filters.client_prop_id,
        owner_id: filters.owner_id,
        category: filters.category,
        source: filters.source,
        payment_method: filters.payment_method,
        date_from: filters.date_from,
        date_to: filters.date_to,
        min_amount: filters.min_amount,
        max_amount: filters.max_amount,
        include_all: filters.include_all ? 'true' : undefined,
      })}`,
    ),
  createExpense: (payload: ExpenseCreate) =>
    request<import('../types').Expense>('/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateExpense: (id: string, payload: ExpenseUpdate) =>
    request<import('../types').Expense>(`/expenses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateDeposit: (id: string, payload: DepositUpdate) =>
    request<import('../types').Deposit>(`/deposits/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  analyzeUpload: (
    file: File,
    options?: {
      propertyId?: string;
      transactionType?: 'deposit' | 'expense' | 'auto';
    },
  ) => {
    const form = new FormData();
    form.append('file', file);
    if (options?.propertyId) {
      form.append('property_id', options.propertyId);
    }
    if (options?.transactionType) {
      form.append('transaction_type', options.transactionType);
    }
    return request<UploadAnalyzeResponse>('/uploads/analyze', {
      method: 'POST',
      body: form,
    });
  },
  getUploadFileUrl: (uploadId: string, options?: { download?: boolean }) => {
    const base = `${API_BASE}/uploads/${uploadId}/file`;
    return options?.download ? `${base}?download=1` : base;
  },
  confirmUpload: (uploadId: string, drafts: TransactionDraft[]) =>
    request<UploadConfirmResponse>(`/uploads/${uploadId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drafts }),
    }),
  getAlerts: () => request<AlertListResponse>('/alerts'),
  getAlertSummary: () => request<AlertSummary>('/alerts/summary'),
  dismissAlert: (alertId: string) =>
    request<AlertItem>(`/alerts/${encodeURIComponent(alertId)}/dismiss`, {
      method: 'POST',
    }),
  resolveAlert: (alertId: string, payload: AlertResolveRequest) =>
    request<AlertItem>(`/alerts/${encodeURIComponent(alertId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  fixIncompleteTransaction: (payload: FixIncompletePayload) =>
    request<FixIncompleteResponse>('/alerts/fix-incomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  createDeposit: (payload: DepositCreate) =>
    request<import('../types').Deposit>('/deposits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  getClientDataStatus: () => request<ClientDataStatusResponse>('/imports/client-data/status'),
  getClientDataSkipReportUrl: (reportId: string) =>
    `${API_BASE}/imports/client-data/reports/${reportId}`,
  submitFeedback: (payload: {
    message: string;
    name?: string;
    email?: string;
    page_url?: string;
  }) =>
    request<{ ok: boolean; detail: string }>('/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  importClientData: (payload: {
    clientList: File;
    management: File;
    bank?: File;
    creditCard1?: File;
    creditCard2?: File;
    reset?: boolean;
    confirmReset?: boolean;
  }) => {
    const form = new FormData();
    form.append('client_list', payload.clientList);
    form.append('management', payload.management);
    if (payload.bank) form.append('bank', payload.bank);
    if (payload.creditCard1) form.append('credit_card_1', payload.creditCard1);
    if (payload.creditCard2) form.append('credit_card_2', payload.creditCard2);
    form.append('reset', payload.reset ? 'true' : 'false');
    form.append('confirm_reset', payload.confirmReset ? 'true' : 'false');
    return request<ClientDataImportJobAccepted>('/imports/client-data', {
      method: 'POST',
      body: form,
    });
  },
  getClientDataImportJob: (jobId: string) =>
    request<ClientDataImportJobStatus>(`/imports/client-data/jobs/${jobId}`),
};
