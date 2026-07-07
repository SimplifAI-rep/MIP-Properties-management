import type {
  DepositFilters,
  DepositGap,
  DepositListResponse,
  DepositSummary,
  ExpenseCreate,
  ExpenseFilters,
  ExpenseListResponse,
  ExpenseSummary,
  OwnerDetail,
  OwnerSummary,
  Property,
  PropertyDetail,
  TransactionDraft,
  UploadAnalyzeResponse,
  UploadConfirmResponse,
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
  getOwners: () => request<OwnerSummary[]>('/owners'),
  getOwner: (id: string) => request<OwnerDetail>(`/owners/${id}`),
  getProperties: () => request<Property[]>('/properties'),
  getProperty: (id: string) => request<PropertyDetail>(`/properties/${id}`),
  getDeposits: (filters: DepositFilters = {}) =>
    request<DepositListResponse>(
      `/deposits${toQuery({
        property_id: filters.property_id,
        owner_id: filters.owner_id,
        date_from: filters.date_from,
        date_to: filters.date_to,
        min_amount: filters.min_amount,
        max_amount: filters.max_amount,
        page: filters.page,
        page_size: filters.page_size,
      })}`,
    ),
  getDepositSummary: () => request<DepositSummary>('/deposits/summary'),
  getDepositGaps: (year?: number, month?: number) =>
    request<DepositGap[]>(
      `/deposits/gaps${toQuery({ year, month })}`,
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
  getExpenseSummary: () => request<ExpenseSummary>('/expenses/summary'),
  createExpense: (payload: ExpenseCreate) =>
    request<import('../types').Expense>('/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  analyzeUpload: (file: File, propertyId: string, transactionType: 'deposit' | 'expense') => {
    const form = new FormData();
    form.append('file', file);
    form.append('property_id', propertyId);
    form.append('transaction_type', transactionType);
    return request<UploadAnalyzeResponse>('/uploads/analyze', {
      method: 'POST',
      body: form,
    });
  },
  confirmUpload: (uploadId: string, drafts: TransactionDraft[]) =>
    request<UploadConfirmResponse>(`/uploads/${uploadId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drafts }),
    }),
};
