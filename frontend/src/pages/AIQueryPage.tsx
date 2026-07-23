import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AIQueryResponse } from '../types';
import { ErrorState, formatCurrency, formatDate, LoadingState } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { downloadAIQueryExcel } from '../utils/exportExcel';
import { getUserErrorMessage } from '../utils/errors';
import { aiIntentToTransactionsState } from '../utils/transactionsNav';

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

function QueryResultTable({ data }: { data: Record<string, unknown>[] }) {
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

function canOpenInTransactions(result: AIQueryResponse): boolean {
  if (result.query_used.query_type === 'gap_analysis') return false;
  return true;
}

export function AIQueryPage() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AIQueryResponse | null>(null);

  const mutation = useMutation({
    mutationFn: api.postAIQuery,
    onSuccess: (data) => setResult(data),
  });

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setQuestion(trimmed);
    mutation.mutate(trimmed);
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
          Ask about deposits, expenses, or mixed transactions using the same filters as
          Transactions — dates, Prop ID, source file, incomplete imports, rental income,
          He/She paid, and more. Open matching rows in Transactions after an answer.
        </p>
      </div>

      <section className="panel-padded">
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
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit(question);
          }}
        >
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about deposits, expenses, or transactions…"
            className="field flex-1 text-sm"
          />
          <button type="submit" disabled={mutation.isPending} className="btn-primary">
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
            <QueryResultTable data={result.data} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
