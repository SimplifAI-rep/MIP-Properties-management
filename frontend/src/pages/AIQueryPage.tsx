import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AIQueryFilters, AIQueryResponse } from '../types';
import { TransactionTable } from '../components/TransactionTable';
import { DateInputDMY } from '../components/ui/DateInputDMY';
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import { ErrorState, formatCurrency, formatDate, LoadingState } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { downloadAIQueryExcel } from '../utils/exportExcel';
import { getUserErrorMessage } from '../utils/errors';
import { aiIntentToTransactionsState } from '../utils/transactionsNav';
import {
  looksLikeTransactionList,
  recordToUnified,
  type UnifiedTransaction,
} from '../utils/unifiedTransaction';

const EXAMPLE_PROMPTS = [
  'Show all deposits for Rothschild 12 in Q1 2026',
  'Which properties had no deposit in March 2026?',
  'Total deposits per owner this year',
  'What were the electricity expenses in January 2026?',
  'Total expenses per property this year',
  'How many expenses were recorded in 2026?',
  'Show transactions from source file Bank Account example.xlsx',
  'List incomplete imports that need review',
  'Show rental income deposits this year',
  'List He/She paid expenses in 2026',
  'Show credit card expenses from July 2026',
  'Expenses for Prop ID BUFFER',
];

function renderCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function AggregateResultTable({ data }: { data: Record<string, unknown>[] }) {
  if (data.length === 0) {
    return <p className="muted-text">No rows returned.</p>;
  }

  const columns = Object.keys(data[0]);

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="table-shell">
        <thead className="table-head">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-4 py-2 font-medium">
                {column.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr key={index} className="table-row">
              {columns.map((column) => (
                <td key={column} className="px-4 py-2">
                  {column.includes('amount') || column.includes('total')
                    ? row[column] != null
                      ? formatCurrency(renderCell(row[column]))
                      : ''
                    : column.includes('date') && row[column]
                      ? formatDate(renderCell(row[column]))
                      : renderCell(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function mapResultToTransactions(result: AIQueryResponse): UnifiedTransaction[] | null {
  if (result.query_used.query_type !== 'list') return null;
  if (!looksLikeTransactionList(result.data)) return null;
  const domain = result.query_used.domain ?? 'deposits';
  const fallbackKind =
    domain === 'expenses' ? 'expense' : domain === 'deposits' ? 'deposit' : undefined;
  return result.data.map((row) => recordToUnified(row, fallbackKind));
}

function canOpenInTransactions(result: AIQueryResponse): boolean {
  if (result.query_used.query_type === 'gap_analysis') return false;
  return true;
}

function buildFiltersPayload(input: {
  ownerIds: string[];
  propertyIds: string[];
  clientPropIds: string[];
  dateFrom?: string;
  dateTo?: string;
  minAmount: string;
  maxAmount: string;
}): AIQueryFilters | undefined {
  const filters: AIQueryFilters = {};
  if (input.ownerIds.length) filters.owner_ids = input.ownerIds;
  if (input.propertyIds.length) filters.property_ids = input.propertyIds;
  if (input.clientPropIds.length) filters.client_prop_ids = input.clientPropIds;
  if (input.dateFrom) filters.date_from = input.dateFrom;
  if (input.dateTo) filters.date_to = input.dateTo;
  const min = input.minAmount.trim();
  const max = input.maxAmount.trim();
  if (min) filters.min_amount = min;
  if (max) filters.max_amount = max;
  return Object.keys(filters).length ? filters : undefined;
}

export function AIQueryPage() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AIQueryResponse | null>(null);
  const [ownerIds, setOwnerIds] = useState<string[]>([]);
  const [propertyIds, setPropertyIds] = useState<string[]>([]);
  const [clientPropIds, setClientPropIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState<string | undefined>();
  const [dateTo, setDateTo] = useState<string | undefined>();
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');

  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const mutation = useMutation({
    mutationFn: api.postAIQuery,
    onSuccess: (data) => setResult(data),
  });

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

  const filtersPayload = useMemo(
    () =>
      buildFiltersPayload({
        ownerIds,
        propertyIds,
        clientPropIds,
        dateFrom,
        dateTo,
        minAmount,
        maxAmount,
      }),
    [ownerIds, propertyIds, clientPropIds, dateFrom, dateTo, minAmount, maxAmount],
  );

  const hasFilters = Boolean(filtersPayload);
  const canAsk = Boolean(question.trim() || hasFilters);

  const transactionRows = useMemo(
    () => (result ? mapResultToTransactions(result) : null),
    [result],
  );

  function syncPropIdsFromProperties(nextPropertyIds: string[]) {
    setPropertyIds(nextPropertyIds);
    const props = propertiesQuery.data ?? [];
    setClientPropIds(
      nextPropertyIds
        .map((id) => props.find((property) => property.id === id)?.client_prop_id)
        .filter((value): value is string => Boolean(value)),
    );
  }

  function syncPropertiesFromPropIds(nextPropIds: string[]) {
    setClientPropIds(nextPropIds);
    const props = propertiesQuery.data ?? [];
    setPropertyIds(
      nextPropIds
        .map((propId) => props.find((property) => property.client_prop_id === propId)?.id)
        .filter((value): value is string => Boolean(value)),
    );
  }

  function clearFilters() {
    setOwnerIds([]);
    setPropertyIds([]);
    setClientPropIds([]);
    setDateFrom(undefined);
    setDateTo(undefined);
    setMinAmount('');
    setMaxAmount('');
  }

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed && !filtersPayload) return;
    setQuestion(trimmed);
    mutation.mutate({
      question: trimmed,
      filters: filtersPayload,
    });
  };

  const openInTransactions = () => {
    if (!result) return;
    navigate('/transactions', {
      state: aiIntentToTransactionsState(result.query_used),
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">
          <Tooltip content="Ask natural-language questions over deposits and expenses.">
            AI Query
          </Tooltip>
        </h2>
        <p className="page-desc">
          Combine a question with structured filters — owners, properties, dates, and
          amounts. Filters override the question when both are set. You can also Ask with
          filters alone.
        </p>
      </div>

      <section className="panel-padded space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Filters</p>
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={!hasFilters}
            onClick={clearFilters}
          >
            Clear
          </button>
        </div>

        <div className="filter-panel md:grid-cols-2 xl:grid-cols-4">
          <SearchableMultiSelect
            label="Owner"
            tip="Limit results to one or more owners. Combines with other filters."
            options={ownerOptions}
            selected={ownerIds}
            onChange={setOwnerIds}
            placeholder="All owners"
            searchPlaceholder="Search owner…"
          />
          <SearchableMultiSelect
            label="Property"
            tip="Select one or more properties. Syncs with Prop ID."
            options={propertyOptions}
            selected={propertyIds}
            onChange={syncPropIdsFromProperties}
            placeholder="All properties"
            searchPlaceholder="Search property…"
          />
          <SearchableMultiSelect
            label="Prop ID"
            tip="Excel Prop ID — select one or more. Syncs with Property."
            options={propIdOptions}
            selected={clientPropIds}
            onChange={syncPropertiesFromPropIds}
            placeholder="All Prop IDs"
            searchPlaceholder="Search Prop ID…"
          />
          <DateInputDMY label="From date" value={dateFrom} onChange={setDateFrom} />
          <DateInputDMY label="To date" value={dateTo} onChange={setDateTo} />
          <label className="block space-y-1 text-sm">
            <span className="label-text">Min amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={minAmount}
              onChange={(event) => setMinAmount(event.target.value)}
              placeholder="Any"
              className="field w-full text-sm"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="label-text">Max amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={maxAmount}
              onChange={(event) => setMaxAmount(event.target.value)}
              placeholder="Any"
              className="field w-full text-sm"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                setQuestion(prompt);
                handleSubmit(prompt);
              }}
              className="btn-chip"
            >
              {prompt}
            </button>
          ))}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit(question);
          }}
        >
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about deposits, expenses, or transactions (optional if filters are set)…"
            className="field flex-1 text-sm"
          />
          <button
            type="submit"
            disabled={mutation.isPending || !canAsk}
            className="btn-primary"
          >
            {mutation.isPending ? 'Thinking...' : 'Ask'}
          </button>
        </form>
      </section>

      {mutation.isPending ? <LoadingState label="Running query..." /> : null}

      {mutation.isError ? (
        <ErrorState
          message={getUserErrorMessage(
            mutation.error,
            'We could not complete that question. Please try again.',
          )}
          error={mutation.error}
        />
      ) : null}

      {result ? (
        <section className="panel-padded space-y-4">
          <div>
            <h3 className="section-title">Answer</h3>
            <p className="mt-2 body-text">{result.answer}</p>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <Tooltip content="Data area used for the answer: deposits, expenses, or mixed transactions.">
                Domain
              </Tooltip>
              : {result.query_used.domain ?? 'deposits'}
              <span aria-hidden>·</span>
              <Tooltip content="Parsed report shape used to fetch the answer.">
                Query type
              </Tooltip>
              : {result.query_used.query_type}
              <span aria-hidden>·</span>
              <Tooltip content="Rule-based parser, or OpenAI if LLM_API_KEY is set.">
                Parser
              </Tooltip>
              : {result.parser}
            </p>
          </div>
          <div>
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="section-title">Data</h3>
              <div className="flex flex-wrap gap-2">
                {canOpenInTransactions(result) ? (
                  <button
                    type="button"
                    onClick={openInTransactions}
                    className="btn-primary"
                  >
                    Open in Transactions
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => downloadAIQueryExcel(result, question)}
                  className="btn-secondary"
                >
                  Export to Excel
                </button>
              </div>
            </div>
            {transactionRows ? (
              <TransactionTable
                rows={transactionRows}
                emptyMessage="No rows returned."
                onRowClick={(row) =>
                  navigate('/transactions', {
                    state: {
                      ...aiIntentToTransactionsState(result.query_used),
                      highlightId: row.id,
                      highlightKind: row.kind,
                    },
                  })
                }
              />
            ) : (
              <AggregateResultTable data={result.data} />
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
