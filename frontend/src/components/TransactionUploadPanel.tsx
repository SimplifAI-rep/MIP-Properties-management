import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Property, TransactionDraft } from '../types';

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

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function statusClass(status: TransactionDraft['status']) {
  if (status === 'ready') return 'badge-deposit';
  if (status === 'error') return 'badge-expense';
  return 'badge-neutral';
}

interface TransactionUploadPanelProps {
  properties: Property[];
  onClose: () => void;
}

export function TransactionUploadPanel({ properties, onClose }: TransactionUploadPanelProps) {
  const queryClient = useQueryClient();
  const [propertyId, setPropertyId] = useState('');
  const [transactionType, setTransactionType] = useState<'deposit' | 'expense'>('expense');
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<TransactionDraft[]>([]);
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null);
  const [parser, setParser] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const propertyDetailQuery = useQuery({
    queryKey: ['property', propertyId],
    queryFn: () => api.getProperty(propertyId),
    enabled: Boolean(propertyId) && transactionType === 'deposit',
  });

  const analyzeMutation = useMutation({
    mutationFn: () => {
      if (!file || !propertyId) {
        throw new Error('Select a property and file first.');
      }
      return api.analyzeUpload(file, propertyId, transactionType);
    },
    onSuccess: (result) => {
      setUploadId(result.upload_id);
      setDrafts(result.drafts);
      setAnalyzeMessage(result.message ?? null);
      setParser(result.parser);
      setConfirmMessage(null);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!uploadId) throw new Error('Analyze a file before confirming.');
      return api.confirmUpload(uploadId, drafts);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      const parts = [
        result.imported_deposit_count
          ? `${result.imported_deposit_count} deposit(s)`
          : null,
        result.imported_expense_count
          ? `${result.imported_expense_count} expense(s)`
          : null,
        result.skipped_count ? `${result.skipped_count} skipped as duplicate(s)` : null,
      ].filter(Boolean);
      setConfirmMessage(parts.join(', ') || 'Nothing imported.');
      if (result.errors.length) {
        setError(result.errors.join('; '));
      } else {
        setError(null);
        setDrafts([]);
        setUploadId(null);
        setFile(null);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  const reviewStats = useMemo(() => {
    return {
      ready: drafts.filter((draft) => draft.status === 'ready').length,
      review: drafts.filter((draft) => draft.status === 'needs_review').length,
      error: drafts.filter((draft) => draft.status === 'error').length,
    };
  }, [drafts]);

  const updateDraft = (index: number, patch: Partial<TransactionDraft>) => {
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, ...patch, status: 'needs_review' } : draft,
      ),
    );
  };

  return (
    <section className="panel p-4 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="subheading">Import from file</h3>
          <p className="page-desc">
            Upload Excel, CSV, PDF, or image. Review extracted fields before saving.
          </p>
        </div>
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm">
          <span className="label-text">Property</span>
          <select
            className="field"
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
          >
            <option value="">Select property</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="label-text">Transaction type</span>
          <select
            className="field"
            value={transactionType}
            onChange={(event) =>
              setTransactionType(event.target.value as 'deposit' | 'expense')
            }
          >
            <option value="expense">Expense</option>
            <option value="deposit">Deposit</option>
          </select>
        </label>
        <label className="text-sm md:col-span-2">
          <span className="label-text">File</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp"
            className="field"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!file || !propertyId || analyzeMutation.isPending}
          onClick={() => analyzeMutation.mutate()}
        >
          {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze file'}
        </button>
        {drafts.length > 0 ? (
          <button
            type="button"
            className="btn-primary"
            disabled={confirmMutation.isPending}
            onClick={() => confirmMutation.mutate()}
          >
            {confirmMutation.isPending ? 'Saving...' : `Confirm ${drafts.length} row(s)`}
          </button>
        ) : null}
      </div>

      {parser ? (
        <p className="text-sm text-muted">
          Parser: {parser}
          {analyzeMessage ? ` — ${analyzeMessage}` : ''}
        </p>
      ) : null}
      {confirmMessage ? <p className="text-positive text-sm">{confirmMessage}</p> : null}
      {error ? <p className="text-negative text-sm">{error}</p> : null}

      {drafts.length > 0 ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="badge-deposit">{reviewStats.ready} ready</span>
            <span className="badge-neutral">{reviewStats.review} need review</span>
            <span className="badge-expense">{reviewStats.error} errors</span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="data-table min-w-full">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Amount</th>
                  {transactionType === 'deposit' ? <th>Account</th> : null}
                  {transactionType === 'expense' ? (
                    <>
                      <th>Category</th>
                      <th>Source</th>
                      <th>Payment</th>
                      <th>Vendor</th>
                    </>
                  ) : null}
                  <th>Description</th>
                  <th>Alerts</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft, index) => (
                  <tr key={draft.row_number ?? index}>
                    <td>{draft.row_number ?? index + 1}</td>
                    <td>
                      <span className={statusClass(draft.status)}>{draft.status}</span>
                    </td>
                    <td>
                      <input
                        type="date"
                        className="field field-compact"
                        value={draft.transaction_date ?? ''}
                        onChange={(event) =>
                          updateDraft(index, { transaction_date: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        className="field field-compact"
                        value={draft.amount ?? ''}
                        onChange={(event) => updateDraft(index, { amount: event.target.value })}
                      />
                    </td>
                    {transactionType === 'deposit' ? (
                      <td>
                        <select
                          className="field field-compact"
                          value={draft.bank_account_id ?? ''}
                          onChange={(event) => {
                            const account = propertyDetailQuery.data?.bank_accounts.find(
                              (item) => item.id === event.target.value,
                            );
                            updateDraft(index, {
                              bank_account_id: event.target.value || null,
                              account_number: account?.account_number ?? draft.account_number,
                            });
                          }}
                        >
                          <option value="">Select account</option>
                          {(propertyDetailQuery.data?.bank_accounts ?? []).map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.account_number}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                    {transactionType === 'expense' ? (
                      <>
                        <td>
                          <select
                            className="field field-compact"
                            value={draft.category ?? 'other'}
                            onChange={(event) =>
                              updateDraft(index, { category: event.target.value })
                            }
                          >
                            {CATEGORIES.map((item) => (
                              <option key={item} value={item}>
                                {label(item)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="field field-compact"
                            value={draft.source ?? 'manual_company'}
                            onChange={(event) =>
                              updateDraft(index, { source: event.target.value })
                            }
                          >
                            {SOURCES.map((item) => (
                              <option key={item} value={item}>
                                {label(item)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="field field-compact"
                            value={draft.payment_method ?? 'company_account'}
                            onChange={(event) =>
                              updateDraft(index, { payment_method: event.target.value })
                            }
                          >
                            {PAYMENT_METHODS.map((item) => (
                              <option key={item} value={item}>
                                {label(item)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            className="field field-compact"
                            value={draft.vendor_name ?? ''}
                            onChange={(event) =>
                              updateDraft(index, { vendor_name: event.target.value })
                            }
                          />
                        </td>
                      </>
                    ) : null}
                    <td>
                      <input
                        type="text"
                        className="field field-compact"
                        value={draft.description ?? ''}
                        onChange={(event) =>
                          updateDraft(index, { description: event.target.value })
                        }
                      />
                    </td>
                    <td className="min-w-48">
                      {draft.warnings.length === 0 ? (
                        <span className="text-muted text-xs">None</span>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {draft.warnings.map((warning) => (
                            <li
                              key={`${warning.field}-${warning.message}`}
                              className={
                                warning.severity === 'error' ? 'text-negative' : 'text-caution'
                              }
                            >
                              <strong>{warning.field}:</strong> {warning.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
