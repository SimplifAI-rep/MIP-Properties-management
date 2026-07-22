import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Property, TransactionDraft, UploadAnalyzeResponse } from '../types';
import {
  EXPENSE_CATEGORIES as CATEGORIES,
  EXPENSE_SOURCES as SOURCES,
  PAYMENT_METHODS,
} from '../constants/expenseOptions';
import { DateInputDMY } from './ui/DateInputDMY';
import { Tooltip } from './ui/Tooltip';

type TransactionTypeOption = 'auto' | 'deposit' | 'expense';
type Step = 'upload' | 'confirm';

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function statusClass(status: TransactionDraft['status']) {
  if (status === 'ready') return 'badge-deposit';
  if (status === 'error') return 'badge-expense';
  return 'badge-neutral';
}

function confidenceClass(confidence: TransactionDraft['match_confidence']) {
  if (confidence === 'high') return 'badge-deposit';
  if (confidence === 'medium') return 'badge-warning';
  return 'badge-expense';
}

function isSpreadsheet(file: File | null) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  return name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv');
}

function isImageMime(mime: string | null | undefined) {
  return Boolean(mime?.startsWith('image/'));
}

function isPdf(filename: string, mime?: string | null) {
  return mime === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
}

function withExpenseDefaults(draft: TransactionDraft): TransactionDraft {
  if (draft.transaction_type !== 'expense') return draft;
  return {
    ...draft,
    category: draft.category == null ? 'other' : draft.category,
    source:
      draft.source == null || draft.source === '' ? 'manual_company' : draft.source,
    payment_method:
      draft.payment_method == null || draft.payment_method === ''
        ? 'company_account'
        : draft.payment_method,
  };
}

function prepareDraftForConfirm(draft: TransactionDraft): TransactionDraft {
  const next = withExpenseDefaults(draft);
  if (next.transaction_type !== 'expense') return next;
  return {
    ...next,
    category: (next.category ?? '').trim() || 'other',
    source: (next.source ?? '').trim() || 'manual_company',
    payment_method: (next.payment_method ?? '').trim() || 'company_account',
  };
}

interface TransactionUploadPanelProps {
  properties: Property[];
  onClose: () => void;
}

export function TransactionUploadPanel({ properties, onClose }: TransactionUploadPanelProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('upload');
  const [propertyId, setPropertyId] = useState('');
  const [transactionType, setTransactionType] = useState<TransactionTypeOption>('auto');
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<UploadAnalyzeResponse | null>(null);
  const [drafts, setDrafts] = useState<TransactionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const spreadsheet = isSpreadsheet(file);
  const primaryDraft = drafts[0] ?? null;
  const draftPropertyId = primaryDraft?.property_id ?? analyzeResult?.property_id ?? propertyId;

  const propertyDetailQuery = useQuery({
    queryKey: ['property', draftPropertyId],
    queryFn: () => api.getProperty(draftPropertyId!),
    enabled: Boolean(draftPropertyId) && (primaryDraft?.transaction_type === 'deposit' || transactionType === 'deposit'),
  });

  const analyzeMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('Select a file first.');
      if (spreadsheet) {
        if (!propertyId) throw new Error('Select a property for Excel/CSV uploads.');
        if (transactionType === 'auto') {
          throw new Error('Choose Expense or Deposit for Excel/CSV uploads.');
        }
      }
      return api.analyzeUpload(file, {
        propertyId: propertyId || undefined,
        transactionType: spreadsheet ? transactionType : transactionType,
      });
    },
    onSuccess: (result) => {
      setUploadId(result.upload_id);
      setAnalyzeResult(result);
      setDrafts(result.drafts.map(withExpenseDefaults));
      setConfirmMessage(null);
      setError(null);
      setStep('confirm');
    },
    onError: (err: Error) => setError(err.message),
  });

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!uploadId) throw new Error('Analyze a file before confirming.');
      const prepared = drafts.map(prepareDraftForConfirm);
      const missingProperty = prepared.some((draft) => !draft.property_id);
      if (missingProperty) {
        throw new Error('Select a client/property for every row before confirming.');
      }
      return api.confirmUpload(uploadId, prepared);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
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
        setAnalyzeResult(null);
        setFile(null);
        setStep('upload');
        onClose();
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
      current.map((draft, draftIndex) => {
        if (draftIndex !== index) return draft;
        const next = withExpenseDefaults({
          ...draft,
          ...patch,
          status: 'needs_review' as const,
        });
        if (patch.property_id) {
          const property = properties.find((item) => item.id === patch.property_id);
          if (property) {
            next.property_name = property.name;
            next.client_prop_id = property.client_prop_id;
            next.owner_id = property.owner_id;
            next.owner_name = property.owner_name;
            next.match_confidence = 'high';
          }
        }
        return next;
      }),
    );
  };

  const previewUrl = uploadId ? api.getUploadFileUrl(uploadId) : null;
  const showPreview =
    Boolean(previewUrl) &&
    (isImageMime(analyzeResult?.mime_type) ||
      isPdf(analyzeResult?.filename ?? '', analyzeResult?.mime_type));

  return (
    <section className="panel p-4 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="subheading">
            {step === 'upload' ? 'Import from file' : 'Confirm extracted transaction'}
          </h3>
          <p className="page-desc">
            {step === 'upload'
              ? 'Upload a receipt, invoice PDF/image, or Excel. Images and PDFs auto-match the client.'
              : 'Verify the matched client and fields, then confirm to save.'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
      </div>

      {step === 'upload' ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Leave blank to auto-match from the document when possible.">
                  Property
                </Tooltip>
                {spreadsheet ? ' (required)' : ' (optional — auto-match)'}
              </span>
              <select
                className="field"
                value={propertyId}
                onChange={(event) => setPropertyId(event.target.value)}
              >
                <option value="">{spreadsheet ? 'Select property' : 'Auto-match from document'}</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name} · {property.owner_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-text">
                <Tooltip content="Choose deposit or expense for extracted rows.">
                  Transaction type
                </Tooltip>
              </span>
              <select
                className="field"
                value={transactionType}
                onChange={(event) =>
                  setTransactionType(event.target.value as TransactionTypeOption)
                }
              >
                {!spreadsheet ? <option value="auto">Auto-detect</option> : null}
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
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next && isSpreadsheet(next) && transactionType === 'auto') {
                    setTransactionType('expense');
                  }
                }}
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={!file || analyzeMutation.isPending || (spreadsheet && !propertyId)}
              onClick={() => analyzeMutation.mutate()}
            >
              {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze & review'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'confirm' && analyzeResult ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Tooltip content="How the file was read (rules or AI).">
              <span className="badge-neutral">Parser: {analyzeResult.parser}</span>
            </Tooltip>
            <Tooltip content="Confidence that the property match is correct.">
              <span className={confidenceClass(analyzeResult.match_confidence)}>
                Match: {analyzeResult.match_confidence ?? 'none'}
              </span>
            </Tooltip>
            <span className="badge-neutral">{analyzeResult.transaction_type}</span>
            <Tooltip content="Rows ready to save without edits.">
              <span className="badge-deposit">{reviewStats.ready} ready</span>
            </Tooltip>
            <Tooltip content="Rows that need a quick check before saving.">
              <span className="badge-neutral">{reviewStats.review} need review</span>
            </Tooltip>
            <Tooltip content="Rows that cannot be saved until fixed.">
              <span className="badge-expense">{reviewStats.error} errors</span>
            </Tooltip>
          </div>

          {analyzeResult.message ? (
            <p className="text-sm text-muted">{analyzeResult.message}</p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border p-3">
              <h4 className="text-sm font-medium">Document preview</h4>
              {showPreview && previewUrl ? (
                isImageMime(analyzeResult.mime_type) ? (
                  <img
                    src={previewUrl}
                    alt={analyzeResult.filename}
                    className="max-h-80 w-full rounded-md object-contain bg-black/5"
                  />
                ) : (
                  <iframe
                    title={analyzeResult.filename}
                    src={previewUrl}
                    className="h-80 w-full rounded-md border border-border"
                  />
                )
              ) : (
                <p className="text-sm text-muted">
                  Preview not available for this file type ({analyzeResult.filename}).
                </p>
              )}
              {previewUrl ? (
                <a
                  href={api.getUploadFileUrl(uploadId!, { download: true })}
                  download={analyzeResult.filename}
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
              ) : null}
            </div>

            <div className="space-y-3 rounded-lg border border-border p-3">
              <h4 className="text-sm font-medium">Matched client</h4>
              {primaryDraft ? (
                <div className="space-y-2 text-sm">
                  <label className="block">
                    <span className="label-text">Property / client</span>
                    <select
                      className="field"
                      value={primaryDraft.property_id ?? ''}
                      onChange={(event) =>
                        updateDraft(0, {
                          property_id: event.target.value || null,
                          bank_account_id: null,
                          account_number: null,
                        })
                      }
                    >
                      <option value="">Select property</option>
                      {properties.map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.name} · {property.owner_name} ({property.client_prop_id})
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    <span className="text-muted">Owner:</span>{' '}
                    {primaryDraft.owner_name || '—'}
                  </p>
                  <p>
                    <span className="text-muted">Prop ID:</span>{' '}
                    {primaryDraft.client_prop_id || '—'}
                  </p>
                  <label className="block">
                    <span className="label-text">
                <Tooltip content="Choose deposit or expense for extracted rows.">
                  Transaction type
                </Tooltip>
              </span>
                    <select
                      className="field"
                      value={primaryDraft.transaction_type}
                      onChange={(event) =>
                        updateDraft(0, {
                          transaction_type: event.target.value as 'deposit' | 'expense',
                        })
                      }
                    >
                      <option value="expense">Expense</option>
                      <option value="deposit">Deposit</option>
                    </select>
                  </label>
                </div>
              ) : (
                <p className="text-sm text-muted">No extracted rows.</p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            {drafts.map((draft, index) => (
              <div
                key={draft.row_number ?? index}
                className="rounded-lg border border-border p-3 space-y-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">#{draft.row_number ?? index + 1}</span>
                  <span className={statusClass(draft.status)}>{draft.status}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <DateInputDMY
                    label="Date"
                    className="text-sm min-w-0"
                    inputClassName="field field-compact"
                    value={draft.transaction_date ?? undefined}
                    onChange={(iso) =>
                      updateDraft(index, { transaction_date: iso ?? null })
                    }
                  />
                  <label className="text-sm min-w-0">
                    <span className="label-text">Amount</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="field field-compact"
                      value={draft.amount ?? ''}
                      onChange={(event) => updateDraft(index, { amount: event.target.value })}
                    />
                  </label>
                  {draft.transaction_type === 'deposit' ? (
                    <label className="text-sm min-w-0">
                      <span className="label-text">Account</span>
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
                    </label>
                  ) : null}
                  {draft.transaction_type === 'expense' ? (
                    <>
                      <label className="text-sm min-w-0">
                        <span className="label-text">Category</span>
                        <input
                          list="upload-category-suggestions"
                          type="text"
                          className="field field-compact"
                          value={draft.category ?? ''}
                          placeholder="e.g. Cleaning"
                          onChange={(event) =>
                            updateDraft(index, { category: event.target.value })
                          }
                        />
                      </label>
                      <label className="text-sm min-w-0">
                        <span className="label-text">Source</span>
                        <select
                          className="field field-compact"
                          value={draft.source ?? 'manual_company'}
                          onChange={(event) =>
                            updateDraft(index, { source: event.target.value })
                          }
                        >
                          {draft.source &&
                          !(SOURCES as readonly string[]).includes(draft.source) ? (
                            <option value={draft.source}>{label(draft.source)}</option>
                          ) : null}
                          {SOURCES.map((item) => (
                            <option key={item} value={item}>
                              {label(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm min-w-0">
                        <span className="label-text">Payment</span>
                        <select
                          className="field field-compact"
                          value={draft.payment_method ?? 'company_account'}
                          onChange={(event) =>
                            updateDraft(index, { payment_method: event.target.value })
                          }
                        >
                          {draft.payment_method &&
                          !(PAYMENT_METHODS as readonly string[]).includes(
                            draft.payment_method,
                          ) ? (
                            <option value={draft.payment_method}>
                              {label(draft.payment_method)}
                            </option>
                          ) : null}
                          {PAYMENT_METHODS.map((item) => (
                            <option key={item} value={item}>
                              {label(item)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-sm min-w-0">
                        <span className="label-text">Vendor</span>
                        <input
                          type="text"
                          className="field field-compact"
                          value={draft.vendor_name ?? ''}
                          onChange={(event) =>
                            updateDraft(index, { vendor_name: event.target.value })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  <label className="text-sm min-w-0 sm:col-span-2 lg:col-span-3">
                    <span className="label-text">Description</span>
                    <input
                      type="text"
                      className="field field-compact"
                      value={draft.description ?? ''}
                      onChange={(event) =>
                        updateDraft(index, { description: event.target.value })
                      }
                    />
                  </label>
                </div>
                <div>
                  <p className="label-text">Alerts</p>
                  {draft.warnings.length === 0 ? (
                    <span className="text-muted text-xs">None</span>
                  ) : (
                    <ul className="mt-1 space-y-1 text-xs">
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
                </div>
              </div>
            ))}
            <datalist id="upload-category-suggestions">
              {CATEGORIES.map((item) => (
                <option key={item} value={label(item)} />
              ))}
            </datalist>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setStep('upload');
                setError(null);
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={confirmMutation.isPending || drafts.length === 0}
              onClick={() => confirmMutation.mutate()}
            >
              {confirmMutation.isPending
                ? 'Saving...'
                : `Confirm & save ${drafts.length} row(s)`}
            </button>
          </div>
        </div>
      ) : null}

      {confirmMessage ? <p className="text-positive text-sm">{confirmMessage}</p> : null}
      {error ? <p className="text-negative text-sm">{error}</p> : null}
    </section>
  );
}
