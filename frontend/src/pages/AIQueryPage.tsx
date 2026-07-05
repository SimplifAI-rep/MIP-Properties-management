import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AIQueryResponse } from '../types';
import { ErrorState, formatCurrency, formatDate, LoadingState } from '../components/ui/States';

const EXAMPLE_PROMPTS = [
  'Show all deposits for Rothschild 12 in Q1 2026',
  'Which properties had no deposit in March 2026?',
  'Total deposits per owner this year',
  'Compare deposits January vs February for Rothschild 12',
  'How many deposits were made in 2026?',
];

function renderCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function QueryResultTable({ data }: { data: Record<string, unknown>[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-slate-500">No rows returned.</p>;
  }

  const columns = Object.keys(data[0]);

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-500">
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
            <tr key={index} className="border-t border-slate-100">
              {columns.map((column) => (
                <td key={column} className="px-4 py-2">
                  {column.includes('amount') && row[column] != null
                    ? formatCurrency(renderCell(row[column]))
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

export function AIQueryPage() {
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">AI Query</h2>
        <p className="mt-1 text-sm text-slate-500">
          Ask natural-language questions about deposits. Uses rule-based parsing by default; set
          LLM_API_KEY for OpenAI-powered parsing.
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                setQuestion(prompt);
                handleSubmit(prompt);
              }}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
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
            placeholder="Ask about deposits, e.g. Show deposits for Dizengoff 45 in April 2026"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {mutation.isPending ? 'Thinking...' : 'Ask'}
          </button>
        </form>
      </section>

      {mutation.isPending ? <LoadingState label="Running query..." /> : null}

      {mutation.isError ? (
        <ErrorState
          message={
            mutation.error instanceof Error
              ? mutation.error.message
              : 'The query could not be completed.'
          }
        />
      ) : null}

      {result ? (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h3 className="font-semibold text-slate-900">Answer</h3>
            <p className="mt-2 text-sm text-slate-700">{result.answer}</p>
            <p className="mt-2 text-xs text-slate-500">
              Query type: {result.query_used.query_type} · Parser: {result.parser}
            </p>
          </div>
          <div>
            <h3 className="mb-2 font-semibold text-slate-900">Data</h3>
            <QueryResultTable data={result.data} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
