import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AIQueryResponse, DepositQueryIntent } from '../types';
import { TransactionTable } from '../components/TransactionTable';
import { DataResultTable } from '../components/ui/DataResultTable';
import { ErrorState, LoadingState } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { downloadAIQueryExcel } from '../utils/exportExcel';
import { getUserErrorMessage } from '../utils/errors';
import { formatLabel } from '../utils/formatLabel';
import { aiIntentToTransactionsState } from '../utils/transactionsNav';
import {
  isUnifiedTransactionRow,
  looksLikeTransactionList,
  recordToUnified,
  unifiedFromRecord,
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

function mapResultToTransactions(result: AIQueryResponse): UnifiedTransaction[] | null {
  if (result.query_used.query_type !== 'list') return null;
  if (!looksLikeTransactionList(result.data)) return null;
  const domain = result.query_used.domain ?? 'deposits';
  const fallbackKind =
    domain === 'expenses' ? 'expense' : domain === 'deposits' ? 'deposit' : undefined;
  return result.data.map((row) =>
    isUnifiedTransactionRow(row) ? unifiedFromRecord(row) : recordToUnified(row, fallbackKind),
  );
}

function canOpenInTransactions(result: AIQueryResponse): boolean {
  if (result.query_used.query_type === 'gap_analysis') return false;
  return true;
}

/** Summarize what the chatbot parsed from the question (not UI filters). */
function describeParsedIntent(intent: DepositQueryIntent): string[] {
  const parts: string[] = [];
  if (intent.owner_name) parts.push(`Owner: ${intent.owner_name}`);
  if (intent.property_name) parts.push(`Property: ${intent.property_name}`);
  if (intent.client_prop_id) parts.push(`Prop ID: ${intent.client_prop_id}`);
  if (intent.date_from || intent.date_to) {
    parts.push(`Dates: ${intent.date_from ?? '…'} → ${intent.date_to ?? '…'}`);
  }
  if (intent.min_amount != null || intent.max_amount != null) {
    parts.push(`Amount: ${intent.min_amount ?? '…'} – ${intent.max_amount ?? '…'}`);
  }
  if (intent.source_file) parts.push(`Source file: ${intent.source_file}`);
  if (intent.category) parts.push(`Category: ${intent.category}`);
  if (intent.search_text) parts.push(`Search: ${intent.search_text}`);
  return parts;
}

export function AIQueryPage() {
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AIQueryResponse | null>(null);

  const mutation = useMutation({
    mutationFn: (q: string) => api.postAIQuery({ question: q }),
    onSuccess: (data) => setResult(data),
  });

  const transactionRows = useMemo(
    () => (result ? mapResultToTransactions(result) : null),
    [result],
  );

  const parsedIntentParts = useMemo(
    () => (result ? describeParsedIntent(result.query_used) : []),
    [result],
  );

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
          Ask in plain language — the assistant interprets your question and returns matching
          data from the database.
        </p>
      </div>

      <section className="panel-padded space-y-4">
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
            placeholder="Ask about deposits, expenses, or transactions…"
            className="field flex-1 text-sm"
          />
          <button
            type="submit"
            disabled={mutation.isPending || !question.trim()}
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
              : {formatLabel(result.query_used.query_type)}
              <span aria-hidden>·</span>
              <Tooltip content="Rule-based parser, or OpenAI if LLM_API_KEY is set.">
                Parser
              </Tooltip>
              : {result.parser}
            </p>
            {parsedIntentParts.length ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Understood: {parsedIntentParts.join(' · ')}
              </p>
            ) : null}
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
              <DataResultTable data={result.data} />
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
