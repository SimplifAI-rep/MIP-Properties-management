import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ClientDataImportResponse } from '../types';
import { ErrorState, InlineError, LoadingState } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { useAuth } from '../context/AuthContext';
import { validationError, AppError } from '../utils/errors';

type FileRole =
  | 'client_list'
  | 'management'
  | 'bank'
  | 'credit_card_1'
  | 'credit_card_2';

const FILE_FIELDS: {
  role: FileRole;
  label: string;
  required: boolean;
  hint: string;
  tip: string;
}[] = [
  {
    role: 'client_list',
    label: 'Client list',
    required: true,
    hint: 'client list to print.xlsx — owners and properties',
    tip: 'Owners, properties, and bank accounts.',
  },
  {
    role: 'management',
    label: 'Management ledger',
    required: true,
    hint: 'Management expenses sheet.xlsx — expenses and inflows',
    tip: 'Main ledger for expenses and inflows.',
  },
  {
    role: 'bank',
    label: 'Bank statement',
    required: false,
    hint: 'Bank Account example.xlsx — company bank rows',
    tip: 'Optional company bank rows for matching.',
  },
  {
    role: 'credit_card_1',
    label: 'Credit card 1',
    required: false,
    hint: 'credit card 1 example.xlsx',
    tip: 'Optional credit-card expense file.',
  },
  {
    role: 'credit_card_2',
    label: 'Credit card 2',
    required: false,
    hint: 'credit card 2 example.xlsx',
    tip: 'Optional second credit-card expense file.',
  },
];

const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const SKIP_REASON_LABELS: Record<string, string> = {
  duplicate_expense: 'Duplicate expense (already in database)',
  duplicate_deposit: 'Duplicate deposit (already in database)',
  starting_balance: 'Starting-balance / opening row',
  unresolved_property: 'Unresolved Prop ID',
  empty_prop_id: 'Empty Prop ID',
  imported_needs_review: 'Incomplete row (imported for review)',
};

const INCOMPLETE_REASON_LABELS: Record<string, string> = {
  missing_date: 'Missing date',
  no_money_columns: 'Missing amount (no money columns)',
  missing_amount: 'Missing amount',
};

function reasonLabel(map: Record<string, string>, key: string): string {
  return map[key] ?? key.replace(/_/g, ' ');
}

export function DataImportPage() {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const [files, setFiles] = useState<Partial<Record<FileRole, File | null>>>({});
  const [reset, setReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [result, setResult] = useState<ClientDataImportResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) {
      setReset(false);
      setConfirmReset(false);
    }
  }, [isAdmin]);

  const statusQuery = useQuery({
    queryKey: ['client-data-status'],
    queryFn: api.getClientDataStatus,
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!files.client_list || !files.management) {
        throw validationError('Please choose both the client list and management ledger files.');
      }
      if (reset && !isAdmin) {
        throw validationError('Admin login is required to reset the database.');
      }
      if (reset && !confirmReset) {
        throw validationError('Please confirm the database reset before importing.');
      }
      setProgressMessage('Uploading files…');
      const accepted = await api.importClientData({
        clientList: files.client_list,
        management: files.management,
        bank: files.bank ?? undefined,
        creditCard1: files.credit_card_1 ?? undefined,
        creditCard2: files.credit_card_2 ?? undefined,
        reset: isAdmin ? reset : false,
        confirmReset: isAdmin ? confirmReset : false,
      });
      setProgressMessage(accepted.message || 'Import queued…');

      const started = Date.now();
      while (Date.now() - started < POLL_TIMEOUT_MS) {
        const job = await api.getClientDataImportJob(accepted.job_id);
        setProgressMessage(job.message || job.status);
        if (job.status === 'succeeded') {
          if (!job.result) {
            throw validationError('Import finished but no result came back. Please try again.');
          }
          return job.result;
        }
        if (job.status === 'failed') {
          throw new AppError({
            userMessage:
              'The import could not be completed. Please check your files and try again.',
            technicalDetail: job.error || job.message || 'Import failed.',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      throw validationError(
        'The import is taking longer than expected. Please wait a bit and refresh, or try again later.',
      );
    },
    onSuccess: (response) => {
      setResult(response);
      setError(null);
      setProgressMessage(null);
      queryClient.invalidateQueries();
      statusQuery.refetch();
    },
    onError: (err: Error) => {
      setError(err);
      setResult(null);
      setProgressMessage(null);
    },
  });

  const effectiveReset = isAdmin && reset;
  const ready = Boolean(
    files.client_list && files.management && (!effectiveReset || confirmReset),
  );

  const counts = statusQuery.data?.database_counts;
  const countSummary = useMemo(() => {
    if (!counts) return null;
    const active = counts.properties_active;
    const inactive = counts.properties_inactive;
    const propertyPart =
      active != null && inactive != null
        ? `${counts.properties} properties (${active} active · ${inactive} inactive)`
        : `${counts.properties} properties`;
    return [
      `${counts.owners} owners`,
      propertyPart,
      `${counts.bank_accounts} bank accounts`,
      `${counts.expenses} expenses`,
      `${counts.deposits} deposits`,
    ].join(' · ');
  }, [counts]);

  if (statusQuery.isLoading) return <LoadingState />;
  if (statusQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load database status. Please try again in a moment."
        error={statusQuery.error}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Data import</h2>
        <p className="page-desc">
          Upload the ClientData Excel files to load owners, properties, expenses, and deposits —
          the same pipeline as the offline seed import. Large imports run in the background so the
          request does not time out.
        </p>
      </div>

      <section className="panel p-5">
        <h3 className="subheading">Current database</h3>
        <p className="mt-2 text-sm text-muted">{countSummary}</p>
      </section>

      <section className="panel p-5">
        <div className="space-y-4">
          <h3 className="subheading">Upload files</h3>
          <p className="text-sm text-muted">
            Required files rebuild the core ledger. Optional bank and credit-card files match the
            full seed set.
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            {FILE_FIELDS.map((field) => (
              <label key={field.role} className="text-sm">
                <span className="label-text">
                  <Tooltip content={field.tip}>{field.label}</Tooltip>
                  {field.required ? ' (required)' : ' (optional)'}
                </span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="field"
                  onChange={(event) => {
                    const next = event.target.files?.[0] ?? null;
                    setFiles((current) => ({ ...current, [field.role]: next }));
                    setResult(null);
                  }}
                />
                <span className="mt-1 block text-xs text-muted">{field.hint}</span>
                {files[field.role] ? (
                  <span className="mt-1 block text-xs text-positive">
                    Selected: {files[field.role]!.name}
                  </span>
                ) : null}
              </label>
            ))}
          </div>

          {isAdmin ? (
            <div className="rounded-lg border border-border p-3 space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={reset}
                  onChange={(event) => {
                    setReset(event.target.checked);
                    if (!event.target.checked) setConfirmReset(false);
                  }}
                />
                <span>
                  <strong>
                    <Tooltip content="Deletes current data, then reloads from the files above.">
                      Reset database before import
                    </Tooltip>
                  </strong>
                  <span className="block text-muted">
                    Wipes all owners, properties, expenses, deposits, and uploads, then imports from
                    the files above. Use this for a clean reload matching seed data.
                  </span>
                </span>
              </label>
              {reset ? (
                <label className="flex items-start gap-2 text-sm pl-6">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmReset}
                    onChange={(event) => setConfirmReset(event.target.checked)}
                  />
                  <span className="text-negative">
                    I understand this permanently deletes the current database contents.
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={!ready || importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending
                ? 'Importing…'
                : effectiveReset
                  ? 'Reset & import'
                  : 'Import into current database'}
            </button>
          </div>

          {importMutation.isPending && progressMessage ? (
            <p className="text-sm text-muted">{progressMessage}</p>
          ) : null}

          {error ? <InlineError error={error} /> : null}
        </div>
      </section>

      {result ? (
        <section className="panel p-5">
          <h3 className="subheading">Import result</h3>
          <p className="mt-2 text-sm text-muted">
            {result.reset ? 'Database was reset, then imported.' : 'Imported into existing database.'}
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="text-sm font-medium">Created</h4>
              <ul className="mt-2 space-y-1 text-sm">
                <li>Owners: {result.owners_created}</li>
                <li>Properties: {result.properties_created}</li>
                <li>Bank accounts: {result.bank_accounts_created}</li>
                <li>
                  <Tooltip content="Expense transactions inserted (one Excel row can create several).">
                    Expenses
                  </Tooltip>
                  : {result.expenses_created}
                </li>
                <li>
                  <Tooltip content="Deposit / inflow transactions inserted.">
                    Deposits
                  </Tooltip>
                  : {result.deposits_created}
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-medium">Ledger scan</h4>
              <ul className="mt-2 space-y-1 text-sm">
                <li>
                  <Tooltip content="Non-empty management-ledger rows after the header (not bank/credit-card rows).">
                    Management ledger rows seen
                  </Tooltip>
                  : {result.rows_seen}
                </li>
                <li>
                  <Tooltip content="Already in the database — not imported again.">
                    Expenses skipped (duplicates)
                  </Tooltip>
                  : {result.expenses_skipped}
                </li>
                <li>
                  <Tooltip content="Already in the database — not imported again.">
                    Deposits skipped (duplicates)
                  </Tooltip>
                  : {result.deposits_skipped}
                </li>
                <li>
                  <Tooltip content="Management rows whose Prop ID could not be matched to a property.">
                    Unresolved Prop ID rows
                  </Tooltip>
                  : {result.rows_skipped_empty}
                </li>
                <li>
                  <Tooltip content="Total rows logged in the skip report (duplicates, starting balance, unresolved Prop ID, incomplete imports, etc.). Not the same as duplicates alone.">
                    Rows in skip report
                  </Tooltip>
                  : {result.skipped_row_count}
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border p-3">
            <h4 className="text-sm font-medium">Property status</h4>
            <p className="mt-1 text-sm text-muted">
              From the current client list: only those properties are active. Others (past clients,
              ledger-only, or removed) are inactive.
            </p>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              <li>
                <Tooltip content="Properties on the current clients sheet (plus BUFFER).">
                  Active now
                </Tooltip>
                : {result.properties_active ?? result.database_counts.properties_active ?? 0}
              </li>
              <li>
                <Tooltip content="Properties not on the current clients sheet.">
                  Inactive now
                </Tooltip>
                : {result.properties_inactive ?? result.database_counts.properties_inactive ?? 0}
              </li>
              <li>
                <Tooltip content="Status changed to active during this import.">
                  Marked active this import
                </Tooltip>
                : {result.properties_marked_active ?? 0}
              </li>
              <li>
                <Tooltip content="Status changed to inactive during this import.">
                  Marked inactive this import
                </Tooltip>
                : {result.properties_marked_inactive ?? 0}
              </li>
            </ul>
            {(result.properties_inactive_ids?.length ?? 0) > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted">
                  Inactive Prop IDs ({result.properties_inactive_ids!.length})
                </summary>
                <p className="mt-1 font-mono text-xs break-all">
                  {result.properties_inactive_ids!.join(', ')}
                </p>
              </details>
            ) : null}
            {(result.properties_active_ids?.length ?? 0) > 0 ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-muted">
                  Active Prop IDs ({result.properties_active_ids!.length})
                </summary>
                <p className="mt-1 font-mono text-xs break-all">
                  {result.properties_active_ids!.join(', ')}
                </p>
              </details>
            ) : null}
          </div>

          {(result.needs_review_created ?? 0) > 0 ||
          Object.keys(result.incomplete_reason_counts ?? {}).length > 0 ? (
            <div className="mt-4 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
              <h4 className="text-sm font-medium">
                Incomplete imports → Alerts
              </h4>
              <p className="mt-1 text-sm text-muted">
                {result.needs_review_created ?? 0} incomplete transaction
                {(result.needs_review_created ?? 0) === 1 ? '' : 's'} imported and added to{' '}
                <Link to="/alerts" className="underline">
                  Alerts
                </Link>{' '}
                for review.
              </p>
              {Object.keys(result.incomplete_reason_counts ?? {}).length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {Object.entries(result.incomplete_reason_counts ?? {})
                    .sort((a, b) => b[1] - a[1])
                    .map(([reason, count]) => (
                      <li key={reason}>
                        {reasonLabel(INCOMPLETE_REASON_LABELS, reason)}: {count}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {Object.keys(result.skip_reason_counts ?? {}).length > 0 ? (
            <div className="mt-4">
              <h4 className="text-sm font-medium">Skip report by reason</h4>
              <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {Object.entries(result.skip_reason_counts ?? {})
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <li key={reason}>
                      {reasonLabel(SKIP_REASON_LABELS, reason)}: {count}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-3 text-sm">
            <span className="text-muted">Files used:</span> {result.files_used.join(', ')}
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted">Database now:</span>{' '}
            {result.database_counts.owners} owners · {result.database_counts.properties} properties
            {result.database_counts.properties_active != null
              ? ` (${result.database_counts.properties_active} active · ${result.database_counts.properties_inactive ?? 0} inactive)`
              : ''}{' '}
            · {result.database_counts.expenses} expenses · {result.database_counts.deposits} deposits
          </p>
          {result.skip_report_id ? (
            <div className="mt-4">
              <a
                className="btn-primary inline-block"
                href={api.getClientDataSkipReportUrl(result.skip_report_id)}
                download
              >
                Download skip-report Excel ({result.skipped_row_count} rows)
              </a>
              <p className="mt-2 text-xs text-muted">
                Includes Summary, Property status, row detail, and a reason legend.
              </p>
            </div>
          ) : null}
          {result.warnings.length > 0 ? (
            <div className="mt-3">
              <p className="text-sm text-caution">
                Warnings ({result.warnings.length}
                {result.warnings.length >= 100 ? '+' : ''})
              </p>
              <ul className="mt-1 max-h-40 overflow-auto text-xs text-muted space-y-1">
                {result.warnings.slice(0, 20).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.errors.length > 0 ? (
            <div className="mt-3">
              <p className="text-sm text-negative">Errors ({result.errors.length})</p>
              <ul className="mt-1 max-h-40 overflow-auto text-xs text-negative space-y-1">
                {result.errors.slice(0, 20).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
