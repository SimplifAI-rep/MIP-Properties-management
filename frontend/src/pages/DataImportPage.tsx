import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ClientDataImportResponse } from '../types';
import { ErrorState, LoadingState } from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';

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

export function DataImportPage() {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<Partial<Record<FileRole, File | null>>>({});
  const [reset, setReset] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [result, setResult] = useState<ClientDataImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['client-data-status'],
    queryFn: api.getClientDataStatus,
  });

  const importMutation = useMutation({
    mutationFn: () => {
      if (!files.client_list || !files.management) {
        throw new Error('Client list and management ledger are required.');
      }
      if (reset && !confirmReset) {
        throw new Error('Confirm the database reset before importing.');
      }
      return api.importClientData({
        clientList: files.client_list,
        management: files.management,
        bank: files.bank ?? undefined,
        creditCard1: files.credit_card_1 ?? undefined,
        creditCard2: files.credit_card_2 ?? undefined,
        reset,
        confirmReset,
      });
    },
    onSuccess: (response) => {
      setResult(response);
      setError(null);
      queryClient.invalidateQueries();
      statusQuery.refetch();
    },
    onError: (err: Error) => {
      setError(err.message);
      setResult(null);
    },
  });

  const ready = Boolean(files.client_list && files.management && (!reset || confirmReset));

  const counts = statusQuery.data?.database_counts;
  const countSummary = useMemo(() => {
    if (!counts) return null;
    return [
      `${counts.owners} owners`,
      `${counts.properties} properties`,
      `${counts.bank_accounts} bank accounts`,
      `${counts.expenses} expenses`,
      `${counts.deposits} deposits`,
    ].join(' · ');
  }, [counts]);

  if (statusQuery.isLoading) return <LoadingState />;
  if (statusQuery.isError) {
    return <ErrorState message="Could not load database status from the API." />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Data import</h2>
        <p className="page-desc">
          Upload the ClientData Excel files to load owners, properties, expenses, and deposits —
          the same pipeline as the offline seed import.
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

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={!ready || importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending
                ? 'Importing… (this can take a minute)'
                : reset
                  ? 'Reset & import'
                  : 'Import into current database'}
            </button>
          </div>

          {error ? <p className="text-negative text-sm whitespace-pre-wrap">{error}</p> : null}
        </div>
      </section>

      {result ? (
        <section className="panel p-5">
          <h3 className="subheading">Import result</h3>
          <p className="mt-2 text-sm text-muted">
            {result.reset ? 'Database was reset, then imported.' : 'Imported into existing database.'}
          </p>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <li>Owners created: {result.owners_created}</li>
            <li>Properties created: {result.properties_created}</li>
            <li>Bank accounts created: {result.bank_accounts_created}</li>
            <li>Expenses created: {result.expenses_created}</li>
            <li>Expenses skipped (duplicates): {result.expenses_skipped}</li>
            <li>Deposits created: {result.deposits_created}</li>
            <li>Deposits skipped (duplicates): {result.deposits_skipped}</li>
            <li>Rows seen: {result.rows_seen}</li>
            <li>
              <Tooltip content="Blank or invalid rows ignored during import.">
                Rows skipped (empty/unusable)
              </Tooltip>
              : {result.rows_skipped_empty}
            </li>
            <li>
              <Tooltip content="Rows excluded with a reportable reason.">
                Detailed skipped rows
              </Tooltip>
              : {result.skipped_row_count}
            </li>
          </ul>
          <p className="mt-3 text-sm">
            <span className="text-muted">Files used:</span> {result.files_used.join(', ')}
          </p>
          <p className="mt-2 text-sm">
            <span className="text-muted">Database now:</span>{' '}
            {result.database_counts.owners} owners · {result.database_counts.properties} properties ·{' '}
            {result.database_counts.expenses} expenses · {result.database_counts.deposits} deposits
          </p>
          {result.skip_report_id ? (
            <div className="mt-4">
              <a
                className="btn-primary inline-block"
                href={api.getClientDataSkipReportUrl(result.skip_report_id)}
                download
              >
                Download skipped-rows Excel ({result.skipped_row_count} rows)
              </a>
              <p className="mt-2 text-xs text-muted">
                Includes Summary, Skipped rows detail, and a reason legend for testing.
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
