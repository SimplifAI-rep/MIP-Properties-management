import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Property, TransactionDraft, UploadAnalyzeResponse } from '../types';
import {
  EXPENSE_CATEGORIES as CATEGORIES,
  EXPENSE_SOURCES as SOURCES,
  PAYMENT_METHODS,
} from '../constants/expenseOptions';
import { DateInputDMY } from './ui/DateInputDMY';
import { formatCurrency, formatDate, InlineError } from './ui/States';
import { Tooltip } from './ui/Tooltip';
import { validationError } from '../utils/errors';

type TransactionTypeOption = 'auto' | 'deposit' | 'expense';
type UploadKindOption = 'receipt' | 'bank_statement' | 'credit_card';
type Step = 'upload' | 'confirm';

function label(value: string) {
  return value.replace(/_/g, ' ');
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

function isStatementParser(parser: string | null | undefined) {
  return parser === 'bank_statement_excel' || parser === 'credit_card_excel';
}

function draftSection(draft: TransactionDraft) {
  if (draft.transaction_type === 'expense') {
    return draft.category || '—';
  }
  return draft.account_number || draft.reference || '—';
}

function draftRowClass(draft: TransactionDraft, isEditing: boolean) {
  const base =
    draft.transaction_type === 'deposit' ? 'row-deposit' : 'row-expense';
  const ignored = draft.user_action === 'ignore' ? ' opacity-50' : '';
  const selected = isEditing ? ' table-row-selected' : '';
  return `${base}${ignored}${selected}`;
}

function draftAmountClass(draft: TransactionDraft) {
  return draft.transaction_type === 'deposit' ? 'amount-deposit' : 'amount-expense';
}

function withExpenseDefaults(draft: TransactionDraft): TransactionDraft {
  const withAction: TransactionDraft = {
    ...draft,
    user_action: draft.user_action ?? (draft.is_duplicate ? 'ignore' : 'add'),
  };
  if (withAction.transaction_type !== 'expense') return withAction;
  return {
    ...withAction,
    category: withAction.category == null ? 'other' : withAction.category,
    source:
      withAction.source == null || withAction.source === ''
        ? 'manual_company'
        : withAction.source,
    payment_method:
      withAction.payment_method == null || withAction.payment_method === ''
        ? 'company_account'
        : withAction.payment_method,
  };
}

function prepareDraftForConfirm(draft: TransactionDraft): TransactionDraft {
  const next = withExpenseDefaults(draft);
  if (next.user_action === 'ignore') return next;
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
  const [uploadKind, setUploadKind] = useState<UploadKindOption>('receipt');
  const [propertyId, setPropertyId] = useState('');
  const [transactionType, setTransactionType] = useState<TransactionTypeOption>('auto');
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<UploadAnalyzeResponse | null>(null);
  const [drafts, setDrafts] = useState<TransactionDraft[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const spreadsheet = isSpreadsheet(file);
  const statementMode = uploadKind === 'bank_statement' || uploadKind === 'credit_card';
  const statementReview = isStatementParser(analyzeResult?.parser);
  const primaryDraft = drafts[0] ?? null;
  const draftPropertyId = primaryDraft?.property_id ?? analyzeResult?.property_id ?? propertyId;

  const propertyDetailQuery = useQuery({
    queryKey: ['property', draftPropertyId],
    queryFn: () => api.getProperty(draftPropertyId!),
    enabled:
      Boolean(draftPropertyId) &&
      !statementReview &&
      (primaryDraft?.transaction_type === 'deposit' ||
        transactionType === 'deposit' ||
        (editingIndex != null && drafts[editingIndex]?.transaction_type === 'deposit')),
  });

  const analyzeMutation = useMutation({
    mutationFn: () => {
      if (!file) throw validationError('Please choose a file first.');
      if (statementMode) {
        if (!spreadsheet) {
          throw validationError('Bank and credit-card uploads need an Excel file.');
        }
        return api.analyzeUpload(file, {
          uploadKind,
          transactionType: 'auto',
        });
      }
      if (spreadsheet) {
        if (!propertyId) {
          throw validationError('Please choose a property for Excel/CSV uploads.');
        }
        if (transactionType === 'auto') {
          throw validationError('Please choose Expense or Deposit for Excel/CSV uploads.');
        }
      }
      return api.analyzeUpload(file, {
        propertyId: propertyId || undefined,
        transactionType,
        uploadKind: 'receipt',
      });
    },
    onSuccess: (result) => {
      setUploadId(result.upload_id);
      setAnalyzeResult(result);
      setDrafts(result.drafts.map(withExpenseDefaults));
      setConfirmMessage(null);
      setError(null);
      setEditingIndex(null);
      setStep('confirm');
      queryClient.invalidateQueries({ queryKey: ['properties'] });
    },
    onError: (err: Error) => setError(err),
  });

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (!uploadId) throw validationError('Please analyze a file before confirming.');
      const prepared = drafts.map(prepareDraftForConfirm);
      const toSave = prepared.filter((draft) => draft.user_action !== 'ignore');
      const missingProperty = toSave.some((draft) => !draft.property_id);
      if (missingProperty) {
        throw validationError('Please choose a client/property for every row you are adding.');
      }
      return api.confirmUpload(uploadId, prepared);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary-rental'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary-heshe'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary-owner'] });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
      const parts = [
        result.imported_deposit_count
          ? `${result.imported_deposit_count} deposit(s)`
          : null,
        result.imported_expense_count
          ? `${result.imported_expense_count} expense(s)`
          : null,
        result.skipped_count ? `${result.skipped_count} ignored/skipped` : null,
      ].filter(Boolean);
      setConfirmMessage(parts.join(', ') || 'Nothing imported.');
      if (result.errors.length) {
        setError(
          validationError(
            result.errors.join('; ') ||
              'Some rows could not be imported. Check the messages and try again.',
          ),
        );
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
    onError: (err: Error) => setError(err),
  });

  const reviewStats = useMemo(() => {
    return {
      ready: drafts.filter((draft) => draft.status === 'ready').length,
      review: drafts.filter((draft) => draft.status === 'needs_review').length,
      error: drafts.filter((draft) => draft.status === 'error').length,
      duplicates: drafts.filter((draft) => draft.is_duplicate).length,
      adding: drafts.filter((draft) => draft.user_action !== 'ignore').length,
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
              ? 'Upload a receipt, bank statement Excel, or credit-card Excel. Statement rows are reviewed before saving.'
              : statementReview
                ? 'Confirm each row: add as a new transaction or ignore. Duplicates are flagged — you choose.'
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
                <Tooltip content="Receipt/invoice, company bank Excel, or credit-card Excel.">
                  File type
                </Tooltip>
              </span>
              <select
                className="field"
                value={uploadKind}
                onChange={(event) => {
                  const next = event.target.value as UploadKindOption;
                  setUploadKind(next);
                  setError(null);
                  if (next !== 'receipt') {
                    setPropertyId('');
                    setTransactionType('auto');
                  }
                }}
              >
                <option value="receipt">Receipt / invoice / generic Excel</option>
                <option value="bank_statement">Bank account Excel</option>
                <option value="credit_card">Credit card Excel</option>
              </select>
            </label>
            {!statementMode ? (
              <>
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
                    <option value="">
                      {spreadsheet ? 'Select property' : 'Auto-match from document'}
                    </option>
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
              </>
            ) : (
              <p className="text-sm text-muted md:col-span-2 self-end pb-2">
                Unclear properties default to the company buffer. Confirm every row before
                save.
              </p>
            )}
            <label
              className={`text-sm ${statementMode ? 'md:col-span-2' : 'md:col-span-2 xl:col-span-1'}`}
            >
              <span className="label-text">File</span>
              <input
                type="file"
                accept={
                  statementMode
                    ? '.xlsx,.xls'
                    : '.xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp'
                }
                className="field"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (
                    next &&
                    !statementMode &&
                    isSpreadsheet(next) &&
                    transactionType === 'auto'
                  ) {
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
              disabled={
                !file ||
                analyzeMutation.isPending ||
                (!statementMode && spreadsheet && !propertyId)
              }
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
            {statementReview ? (
              <>
                <span className="badge-warning">{reviewStats.duplicates} duplicate(s)</span>
                <span className="badge-deposit">{reviewStats.adding} will add</span>
              </>
            ) : null}
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
              <h4 className="text-sm font-medium">
                {statementReview ? 'Review tips' : 'Matched client'}
              </h4>
              {statementReview ? (
                <ul className="space-y-2 text-sm text-muted">
                  <li>Duplicate rows default to Ignore — switch to Add to create anyway.</li>
                  <li>Buffer property rows need you to confirm or change the property.</li>
                  <li>Each row can be deposit or expense independently.</li>
                </ul>
              ) : primaryDraft ? (
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

          <div className="panel overflow-hidden">
            <div className="w-full min-w-0">
              <table className="table-shell">
                <colgroup>
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                  <col className="w-[10%]" />
                  <col className="w-[14%]" />
                  <col className="w-[9%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead className="table-head">
                  <tr>
                    <th className="px-2 py-3 font-medium">Type</th>
                    <th className="px-2 py-3 font-medium">Prop ID</th>
                    <th className="px-2 py-3 font-medium">Date</th>
                    <th className="px-2 py-3 font-medium">Section</th>
                    <th className="px-2 py-3 font-medium">Notes</th>
                    <th className="px-2 py-3 font-medium">Amount</th>
                    <th className="px-2 py-3 font-medium">Company</th>
                    <th className="px-2 py-3 font-medium">Property</th>
                    <th className="px-2 py-3 font-medium">Owner</th>
                    <th className="px-2 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft, index) => {
                    const isEditing = editingIndex === index;
                    const ignored = draft.user_action === 'ignore';
                    return (
                      <Fragment key={draft.row_number ?? index}>
                        <tr className={draftRowClass(draft, isEditing)}>
                          <td className="px-2 py-3">
                            <div className="flex flex-wrap items-center gap-1">
                              {draft.client_prop_id === 'BUFFER' ? (
                                <Tooltip content="Assigned to company buffer — confirm or change the property.">
                                  <span className="text-caution font-bold" aria-label="Buffer property">
                                    !
                                  </span>
                                </Tooltip>
                              ) : null}
                              <span
                                className={
                                  draft.transaction_type === 'deposit'
                                    ? 'badge-deposit'
                                    : 'badge-expense'
                                }
                              >
                                {draft.transaction_type === 'deposit' ? 'Deposit' : 'Expense'}
                              </span>
                              {draft.source === 'bank_statement' ? (
                                <span className="badge-bank-statement">Bank statement</span>
                              ) : null}
                              {draft.source === 'credit_card' ? (
                                <span className="badge-nearly-cc">Credit card</span>
                              ) : null}
                              {draft.is_duplicate ? (
                                <span className="badge-warning">Duplicate</span>
                              ) : null}
                              {ignored ? <span className="badge-neutral">Ignored</span> : null}
                            </div>
                          </td>
                          <td
                            className="px-2 py-3 font-mono text-xs font-medium truncate"
                            title={draft.client_prop_id ?? undefined}
                          >
                            {draft.client_prop_id || '—'}
                          </td>
                          <td className="px-2 py-3 truncate">
                            {draft.transaction_date
                              ? formatDate(draft.transaction_date)
                              : '—'}
                          </td>
                          <td
                            className="px-2 py-3 truncate"
                            title={draftSection(draft)}
                          >
                            {draftSection(draft)}
                          </td>
                          <td
                            className="px-2 py-3 muted-text truncate"
                            title={draft.description ?? undefined}
                          >
                            {draft.description || '—'}
                          </td>
                          <td
                            className={`px-2 py-3 tabular-nums truncate ${draftAmountClass(draft)}`}
                          >
                            {draft.amount != null && draft.amount !== '' ? (
                              <>
                                {draft.transaction_type === 'deposit' ? '+' : '−'}
                                {formatCurrency(draft.amount, draft.currency ?? 'ILS')}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td
                            className="px-2 py-3 muted-text truncate"
                            title={draft.vendor_name ?? undefined}
                          >
                            {draft.vendor_name || '—'}
                          </td>
                          <td
                            className="px-2 py-3 font-medium truncate"
                            title={draft.property_name ?? undefined}
                          >
                            {draft.property_name || '—'}
                          </td>
                          <td
                            className="px-2 py-3 truncate"
                            title={draft.owner_name ?? undefined}
                          >
                            {draft.owner_name || '—'}
                          </td>
                          <td className="px-2 py-3">
                            <div className="flex flex-wrap items-center gap-1">
                              <Tooltip content={isEditing ? 'Close edit' : 'Edit row'}>
                                <button
                                  type="button"
                                  className="btn-icon"
                                  aria-label={isEditing ? 'Close edit' : 'Edit row'}
                                  onClick={() =>
                                    setEditingIndex(isEditing ? null : index)
                                  }
                                >
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  >
                                    <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                                    <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                                  </svg>
                                </button>
                              </Tooltip>
                              {statementReview ? (
                                <>
                                  <button
                                    type="button"
                                    className={
                                      !ignored
                                        ? 'btn-primary px-2 py-1 text-xs'
                                        : 'btn-secondary px-2 py-1 text-xs'
                                    }
                                    onClick={() =>
                                      updateDraft(index, { user_action: 'add' })
                                    }
                                  >
                                    Add
                                  </button>
                                  <button
                                    type="button"
                                    className={
                                      ignored
                                        ? 'btn-primary px-2 py-1 text-xs'
                                        : 'btn-secondary px-2 py-1 text-xs'
                                    }
                                    onClick={() =>
                                      updateDraft(index, { user_action: 'ignore' })
                                    }
                                  >
                                    Ignore
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                        {draft.is_duplicate && draft.duplicate_summary ? (
                          <tr className={ignored ? 'opacity-50' : undefined}>
                            <td colSpan={10} className="px-2 pb-2 pt-0 text-xs text-caution">
                              Possible duplicate of existing {draft.duplicate_match_kind}:{' '}
                              {draft.duplicate_summary}
                            </td>
                          </tr>
                        ) : null}
                        {isEditing ? (
                          <tr className="bg-slate-50/80 dark:bg-slate-900/40">
                            <td colSpan={10} className="p-0">
                              <div className="box-border max-w-full px-4 py-4">
                                <div className="grid max-w-full gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Prop ID / Property</span>
                                    <select
                                      className="field"
                                      value={draft.property_id ?? ''}
                                      disabled={ignored}
                                      onChange={(event) =>
                                        updateDraft(index, {
                                          property_id: event.target.value || null,
                                          bank_account_id:
                                            statementReview
                                              ? draft.bank_account_id
                                              : null,
                                          account_number:
                                            statementReview
                                              ? draft.account_number
                                              : null,
                                        })
                                      }
                                    >
                                      <option value="">Select property</option>
                                      {properties.map((property) => (
                                        <option key={property.id} value={property.id}>
                                          {property.client_prop_id} — {property.name}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Type</span>
                                    <select
                                      className="field"
                                      value={draft.transaction_type}
                                      disabled={ignored}
                                      onChange={(event) =>
                                        updateDraft(index, {
                                          transaction_type: event.target
                                            .value as 'deposit' | 'expense',
                                        })
                                      }
                                    >
                                      <option value="expense">Expense</option>
                                      <option value="deposit">Deposit</option>
                                    </select>
                                  </label>
                                  <DateInputDMY
                                    label="Date"
                                    value={draft.transaction_date ?? undefined}
                                    onChange={(iso) =>
                                      updateDraft(index, {
                                        transaction_date: iso ?? null,
                                      })
                                    }
                                    className="text-sm min-w-0"
                                  />
                                  <label className="text-sm min-w-0">
                                    <span className="label-text">Amount</span>
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      className="field"
                                      value={draft.amount ?? ''}
                                      disabled={ignored}
                                      onChange={(event) =>
                                        updateDraft(index, {
                                          amount: event.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  {draft.transaction_type === 'expense' ? (
                                    <>
                                      <label className="text-sm min-w-0">
                                        <span className="label-text">Section</span>
                                        <input
                                          list="upload-category-suggestions"
                                          type="text"
                                          className="field"
                                          value={draft.category ?? ''}
                                          disabled={ignored}
                                          onChange={(event) =>
                                            updateDraft(index, {
                                              category: event.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <label className="text-sm min-w-0">
                                        <span className="label-text">Method</span>
                                        <select
                                          className="field"
                                          value={draft.payment_method ?? 'company_account'}
                                          disabled={ignored}
                                          onChange={(event) =>
                                            updateDraft(index, {
                                              payment_method: event.target.value,
                                            })
                                          }
                                        >
                                          {PAYMENT_METHODS.map((item) => (
                                            <option key={item} value={item}>
                                              {label(item)}
                                            </option>
                                          ))}
                                          {draft.payment_method &&
                                          !(PAYMENT_METHODS as readonly string[]).includes(
                                            draft.payment_method,
                                          ) ? (
                                            <option value={draft.payment_method}>
                                              {label(draft.payment_method)}
                                            </option>
                                          ) : null}
                                        </select>
                                      </label>
                                      <label className="text-sm min-w-0">
                                        <span className="label-text">Company</span>
                                        <input
                                          type="text"
                                          className="field"
                                          value={draft.vendor_name ?? ''}
                                          disabled={ignored}
                                          onChange={(event) =>
                                            updateDraft(index, {
                                              vendor_name: event.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <label className="text-sm min-w-0">
                                        <span className="label-text">Source</span>
                                        <select
                                          className="field"
                                          value={draft.source ?? 'manual_company'}
                                          disabled={ignored}
                                          onChange={(event) =>
                                            updateDraft(index, {
                                              source: event.target.value,
                                            })
                                          }
                                        >
                                          {SOURCES.map((item) => (
                                            <option key={item} value={item}>
                                              {label(item)}
                                            </option>
                                          ))}
                                          {draft.source &&
                                          !(SOURCES as readonly string[]).includes(
                                            draft.source,
                                          ) ? (
                                            <option value={draft.source}>
                                              {label(draft.source)}
                                            </option>
                                          ) : null}
                                        </select>
                                      </label>
                                    </>
                                  ) : (
                                    <label className="text-sm min-w-0">
                                      <span className="label-text">Account</span>
                                      {statementReview ? (
                                        <input
                                          type="text"
                                          className="field"
                                          value={draft.account_number ?? ''}
                                          disabled
                                          readOnly
                                        />
                                      ) : (
                                        <select
                                          className="field"
                                          value={draft.bank_account_id ?? ''}
                                          disabled={ignored}
                                          onChange={(event) => {
                                            const account =
                                              propertyDetailQuery.data?.bank_accounts.find(
                                                (item) => item.id === event.target.value,
                                              );
                                            updateDraft(index, {
                                              bank_account_id: event.target.value || null,
                                              account_number:
                                                account?.account_number ??
                                                draft.account_number,
                                            });
                                          }}
                                        >
                                          <option value="">Select account</option>
                                          {(propertyDetailQuery.data?.bank_accounts ?? []).map(
                                            (account) => (
                                              <option key={account.id} value={account.id}>
                                                {account.account_number}
                                              </option>
                                            ),
                                          )}
                                        </select>
                                      )}
                                    </label>
                                  )}
                                  <label className="text-sm min-w-0 sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                    <span className="label-text">Notes</span>
                                    <input
                                      type="text"
                                      className="field"
                                      value={draft.description ?? ''}
                                      disabled={ignored}
                                      onChange={(event) =>
                                        updateDraft(index, {
                                          description: event.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  {draft.warnings.length > 0 ? (
                                    <ul className="space-y-1 text-xs sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                      {draft.warnings.map((warning) => (
                                        <li
                                          key={`${warning.field}-${warning.message}`}
                                          className={
                                            warning.severity === 'error'
                                              ? 'text-negative'
                                              : 'text-caution'
                                          }
                                        >
                                          <strong>{warning.field}:</strong> {warning.message}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                  <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-4">
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      onClick={() => setEditingIndex(null)}
                                    >
                                      Done
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
              <datalist id="upload-category-suggestions">
                {CATEGORIES.map((item) => (
                  <option key={item} value={label(item)} />
                ))}
              </datalist>
            </div>
            {drafts.length === 0 ? (
              <div className="p-5 text-sm text-muted">No extracted rows.</div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setStep('upload');
                setEditingIndex(null);
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
                : `Confirm & save ${reviewStats.adding} row(s)`}
            </button>
          </div>
        </div>
      ) : null}

      {confirmMessage ? <p className="text-positive text-sm">{confirmMessage}</p> : null}
      {error ? <InlineError error={error} /> : null}
    </section>
  );
}
