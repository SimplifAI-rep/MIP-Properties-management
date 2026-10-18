import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  InlineError,
  LoadingState,
} from '../components/ui/States';
import { SearchableMultiSelect } from '../components/ui/SearchableMultiSelect';
import {
  TransactionFilterFields,
  type TransactionEntityFilters,
} from '../components/ui/TransactionFilterFields';
import { Tooltip } from '../components/ui/Tooltip';
import { ConfirmButton } from '../components/ui/ConfirmButton';
import {
  syncClientPropIdsFromProperties,
  syncPropertyIdsFromPropIds,
  useOwnerPropertyFilterOptions,
} from '../hooks/useOwnerPropertyFilterOptions';
import {
  EXPENSE_SOURCES as SOURCES,
  SECTION_SUGGESTIONS,
} from '../constants/expenseOptions';
import { formatLabel } from '../utils/formatLabel';
import { validationError } from '../utils/errors';
import { downloadCsv, ownerCsvFilename } from '../utils/downloadCsv';
import { transactionCsvRows } from '../utils/transactionCsv';
import { mergeAndSortTransactions } from '../utils/transactionView';
import {
  buildTxnListFilters,
  buildTxnSharedFilters,
} from '../utils/prefetchTransactions';
import {
  ALERT_FILTER_OPTIONS,
  PROPERTY_STATUS_OPTIONS,
  TYPE_FILTER_OPTIONS,
  applyClientTxnFilters,
  depositTypeApiFilter,
  expenseOwnerApiFilter,
  expenseResidentApiFilter,
  includeDepositsFromFilters,
  includeExpensesFromFilters,
  type AlertFilterKind,
  type PropertyStatusFilter,
  type TypeFilterKind,
} from '../utils/transactionTypeFilters';
import {
  emptyReportFilters,
  snapshotFromApi,
  snapshotIsDefault,
  snapshotToApi,
  snapshotsEqual,
  type ReportFilterSnapshot,
} from '../utils/reportFilters';

function label(value: string) {
  return formatLabel(value);
}

export function ReportsPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<ReportFilterSnapshot>(emptyReportFilters);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);

  const {
    owners,
    properties,
    ownerOptions,
    propertyOptions,
    propIdOptions,
    isLoading: optionsLoading,
    isError: optionsError,
    error: optionsErrorValue,
  } = useOwnerPropertyFilterOptions();

  const presetsQuery = useQuery({
    queryKey: ['report-presets'],
    queryFn: api.getReportPresets,
  });

  const patchFilters = (partial: Partial<ReportFilterSnapshot>) => {
    setFilters((current) => ({ ...current, ...partial }));
  };

  const selectedPreset = (presetsQuery.data ?? []).find(
    (preset) => preset.id === selectedPresetId,
  );
  const selectedSnapshot = selectedPreset
    ? snapshotFromApi(selectedPreset.filters)
    : null;
  const presetDirty =
    Boolean(selectedSnapshot) && !snapshotsEqual(filters, selectedSnapshot!);

  const {
    ownerIds,
    propertyIds,
    clientPropIds,
    dateFrom,
    dateTo,
    kinds,
    propertyStatuses,
    sections,
    sources,
    sourceFiles,
    alertFilters,
  } = filters;

  const statusFilteredPropertyOptions = useMemo(() => {
    if (propertyStatuses.length !== 1) return propertyOptions;
    const status = propertyStatuses[0];
    const allowed = new Set(
      properties.filter((property) => property.status === status).map((property) => property.id),
    );
    return propertyOptions.filter((option) => allowed.has(option.value));
  }, [properties, propertyOptions, propertyStatuses]);

  const statusFilteredPropIdOptions = useMemo(() => {
    if (propertyStatuses.length !== 1) return propIdOptions;
    const status = propertyStatuses[0];
    const allowed = new Set(
      properties
        .filter((property) => property.status === status)
        .map((property) => property.client_prop_id),
    );
    return propIdOptions.filter((option) => allowed.has(option.value));
  }, [properties, propIdOptions, propertyStatuses]);

  const apiPropertyId = propertyIds.length === 1 ? propertyIds[0] : undefined;
  const apiPropertyIds = propertyIds.length > 1 ? propertyIds : undefined;
  const apiClientPropId = clientPropIds.length === 1 ? clientPropIds[0] : undefined;
  const apiClientPropIds = clientPropIds.length > 1 ? clientPropIds : undefined;
  const apiOwnerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
  const apiOwnerIds = ownerIds.length > 1 ? ownerIds : undefined;
  const apiPropertyStatus =
    propertyStatuses.length === 1 ? propertyStatuses[0] : undefined;
  const apiSection = sections.length === 1 ? sections[0] : undefined;
  const apiSource = sources.length === 1 ? sources[0] : undefined;
  const singleSourceFile = sourceFiles.length === 1 ? sourceFiles[0] : undefined;
  const needsReviewOnly = alertFilters.includes('incomplete_import') ? true : undefined;
  const reviewReasonFilter =
    kinds.length === 1 && kinds[0] === 'created_from_verification'
      ? 'created_from_verification'
      : undefined;

  const includeDeposits = includeDepositsFromFilters(kinds, alertFilters);
  const includeExpenses = includeExpensesFromFilters(kinds, alertFilters);

  const sharedFilters = buildTxnSharedFilters({
    property_id: apiPropertyId,
    property_ids: apiPropertyIds,
    client_prop_id: apiClientPropId,
    client_prop_ids: apiClientPropIds,
    owner_id: apiOwnerId,
    owner_ids: apiOwnerIds,
    property_status: apiPropertyStatus,
    date_from: dateFrom,
    date_to: dateTo,
  });
  const listFilters = buildTxnListFilters({
    ...sharedFilters,
    source_file: singleSourceFile,
    needs_review: needsReviewOnly,
    review_reason: reviewReasonFilter,
  });

  const depositTypeFilter = depositTypeApiFilter(kinds);
  const expenseResidentFilter = expenseResidentApiFilter(kinds);
  const expenseOwnerFilter = expenseOwnerApiFilter(kinds);

  const depositsQuery = useQuery({
    queryKey: ['deposits', listFilters, depositTypeFilter, 'report-all'],
    queryFn: () =>
      api.getAllDeposits({
        ...listFilters,
        is_rental_income: depositTypeFilter,
        include_running_balance: false,
      }),
    enabled: includeDeposits,
    placeholderData: keepPreviousData,
  });
  const expensesQuery = useQuery({
    queryKey: [
      'expenses',
      listFilters,
      apiSection,
      apiSource,
      expenseResidentFilter,
      expenseOwnerFilter,
      'report-all',
    ],
    queryFn: () =>
      api.getAllExpenses({
        ...listFilters,
        category: apiSection,
        source: apiSource,
        paid_by_resident: expenseResidentFilter,
        paid_by_owner: expenseOwnerFilter,
        include_running_balance: false,
      }),
    enabled: includeExpenses,
    placeholderData: keepPreviousData,
  });

  const items = useMemo(
    () =>
      applyClientTxnFilters(
        mergeAndSortTransactions(
          includeDeposits ? (depositsQuery.data?.items ?? []) : [],
          includeExpenses ? (expensesQuery.data?.items ?? []) : [],
        ),
        { kinds, alertFilters, sections, sources, sourceFiles },
      ),
    [
      alertFilters,
      depositsQuery.data,
      expensesQuery.data,
      includeDeposits,
      includeExpenses,
      kinds,
      sections,
      sourceFiles,
      sources,
    ],
  );

  const sectionOptions = useMemo(() => {
    const fromRows = items.map((row) => row.section).filter(Boolean);
    const merged = [...new Set([...SECTION_SUGGESTIONS, ...fromRows])].sort((a, b) =>
      a.localeCompare(b),
    );
    return merged.map((value) => ({ value, label: value }));
  }, [items]);

  const sourceOptions = useMemo(
    () => SOURCES.map((value) => ({ value, label: label(value) })),
    [],
  );

  const sourceFileOptions = useMemo(() => {
    const names = new Set<string>();
    for (const row of depositsQuery.data?.items ?? []) {
      if (row.source_file) names.add(row.source_file);
    }
    for (const row of expensesQuery.data?.items ?? []) {
      if (row.source_file) names.add(row.source_file);
    }
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: value }));
  }, [depositsQuery.data, expensesQuery.data]);

  const ownerNamesForExport = useMemo(() => {
    if (ownerIds.length > 0) {
      return ownerIds
        .map((id) => owners.find((owner) => owner.id === id)?.name)
        .filter((name): name is string => Boolean(name));
    }
    return [...new Set(items.map((row) => row.owner_name).filter(Boolean))];
  }, [items, ownerIds, owners]);

  const suggestedSaveName =
    ownerNamesForExport.length === 1 ? ownerNamesForExport[0] : '';

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      api.createReportPreset({
        name,
        filters: snapshotToApi(filters),
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['report-presets'] });
      setSelectedPresetId(created.id);
      setSaveName('');
      setActionError(null);
    },
    onError: (error) => setActionError(error),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!selectedPresetId) {
        throw new Error('No report selected.');
      }
      return api.updateReportPreset(selectedPresetId, {
        filters: snapshotToApi(filters),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['report-presets'] });
      setActionError(null);
    },
    onError: (error) => setActionError(error),
  });

  const deleteMutation = useMutation({
    mutationFn: (presetId: string) => api.deleteReportPreset(presetId),
    onSuccess: (_, presetId) => {
      void queryClient.invalidateQueries({ queryKey: ['report-presets'] });
      if (selectedPresetId === presetId) setSelectedPresetId(null);
      setActionError(null);
    },
    onError: (error) => setActionError(error),
  });

  function applyPreset(presetId: string) {
    const preset = (presetsQuery.data ?? []).find((item) => item.id === presetId);
    if (!preset) return;
    setSelectedPresetId(preset.id);
    setFilters(snapshotFromApi(preset.filters));
    setSaveName(preset.name);
    setActionError(null);
  }

  function saveCurrent() {
    const name = (saveName.trim() || suggestedSaveName).trim();
    if (!name) {
      setActionError(validationError('Give this report a name, or pick an owner first.'));
      return;
    }
    if (
      selectedPreset &&
      name.toLowerCase() === selectedPreset.name.toLowerCase()
    ) {
      updateMutation.mutate();
      return;
    }
    createMutation.mutate(name);
  }

  function exportCsv() {
    downloadCsv(transactionCsvRows(items), ownerCsvFilename(ownerNamesForExport));
  }

  function syncEntityFilters(next: TransactionEntityFilters) {
    patchFilters({
      ownerIds: next.ownerIds,
      propertyIds: next.propertyIds,
      clientPropIds: next.clientPropIds,
      dateFrom: next.dateFrom,
      dateTo: next.dateTo,
    });
  }

  const isLoading = optionsLoading || presetsQuery.isLoading;
  const isError = optionsError || presetsQuery.isError;
  const rowsLoading =
    (includeDeposits && depositsQuery.isLoading) ||
    (includeExpenses && expensesQuery.isLoading);
  const rowsError =
    (includeDeposits && depositsQuery.isError) ||
    (includeExpenses && expensesQuery.isError);

  if (isLoading) return <LoadingState />;
  if (isError) {
    return (
      <ErrorState
        message="We couldn't load report data. Please try again."
        error={optionsErrorValue ?? presetsQuery.error}
      />
    );
  }

  const presets = presetsQuery.data ?? [];
  const hasActiveFilters = !snapshotIsDefault(filters);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">
          <Tooltip content="Save a filter set for an owner, then export every matching transaction as CSV.">
            Reports
          </Tooltip>
        </h2>
        <p className="page-desc">
          Filter the live database the same way as Transactions. Save that filter as a
          report, then export a CSV named after the owner.
        </p>
      </div>

      <section className="panel space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="section-title text-sm">Saved reports</h3>
          {selectedPreset ? (
            <ConfirmButton
              label={`Delete ${selectedPreset.name}`}
              confirmLabel="Delete"
              className="btn-secondary text-xs"
              pending={deleteMutation.isPending}
              onConfirm={() => deleteMutation.mutate(selectedPreset.id)}
            />
          ) : null}
        </div>
        {presets.length === 0 ? (
          <p className="text-sm muted-text">
            No saved reports yet. Set filters below, then save.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={
                  selectedPresetId === preset.id ? 'btn-primary text-xs' : 'btn-secondary text-xs'
                }
                onClick={() => applyPreset(preset.id)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="label-text">Save as</span>
            <input
              className="field"
              value={saveName}
              onChange={(event) => setSaveName(event.target.value)}
              placeholder={suggestedSaveName || 'e.g. David Cohen'}
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={createMutation.isPending}
            onClick={saveCurrent}
          >
            {createMutation.isPending ? 'Saving…' : 'Save report'}
          </button>
          {selectedPreset && presetDirty ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate()}
            >
              {updateMutation.isPending ? 'Updating…' : 'Update filters'}
            </button>
          ) : null}
        </div>
        {actionError ? <InlineError error={actionError} /> : null}
      </section>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Filters</p>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!hasActiveFilters}
          onClick={() => {
            setFilters(emptyReportFilters());
            setSelectedPresetId(null);
            setSaveName('');
          }}
        >
          Clear
        </button>
      </div>

      <section className="filter-panel md:grid-cols-2 xl:grid-cols-4">
        <TransactionFilterFields
          value={{
            ownerIds,
            propertyIds,
            clientPropIds,
            dateFrom,
            dateTo,
          }}
          onChange={syncEntityFilters}
          ownerOptions={ownerOptions}
          propertyOptions={statusFilteredPropertyOptions}
          propIdOptions={statusFilteredPropIdOptions}
          showAmounts={false}
          onSyncFromProperties={(nextPropertyIds) => ({
            propertyIds: nextPropertyIds,
            clientPropIds: syncClientPropIdsFromProperties(nextPropertyIds, properties),
          })}
          onSyncFromPropIds={(nextPropIds) => ({
            clientPropIds: nextPropIds,
            propertyIds: syncPropertyIdsFromPropIds(nextPropIds, properties),
          })}
          prepend={
            <>
              <SearchableMultiSelect
                label="Property status"
                tip="Show transactions for active and/or inactive properties. Default is active only."
                options={PROPERTY_STATUS_OPTIONS}
                selected={propertyStatuses}
                onChange={(next) =>
                  patchFilters({
                    propertyStatuses: next as PropertyStatusFilter[],
                    propertyIds: [],
                    clientPropIds: [],
                  })
                }
                placeholder="All statuses"
                searchPlaceholder="Search status…"
              />
              <SearchableMultiSelect
                label="Type"
                tip="Deposit/Expense match Excel Inflow/Amount. Rental, He/She, Owner paid, Bank statement, Nearly CC, and Created from verification are separate lanes you can filter."
                options={TYPE_FILTER_OPTIONS}
                selected={kinds}
                onChange={(next) => patchFilters({ kinds: next as TypeFilterKind[] })}
                placeholder="All types"
                searchPlaceholder="Search type…"
              />
              <SearchableMultiSelect
                label="Alerts"
                tip="Filter to incomplete import rows (missing date and/or amount)."
                options={ALERT_FILTER_OPTIONS}
                selected={alertFilters}
                onChange={(next) =>
                  patchFilters({ alertFilters: next as AlertFilterKind[] })
                }
                placeholder="All rows"
                searchPlaceholder="Search alerts…"
              />
            </>
          }
          append={
            <>
              <SearchableMultiSelect
                label="Section"
                tip="Excel Section — select one or more."
                options={sectionOptions}
                selected={sections}
                onChange={(next) => patchFilters({ sections: next })}
                placeholder="All sections"
                searchPlaceholder="Search section…"
              />
              <SearchableMultiSelect
                label="Source"
                tip="How the expense was recorded."
                options={sourceOptions}
                selected={sources}
                onChange={(next) => patchFilters({ sources: next })}
                placeholder="All sources"
                searchPlaceholder="Search source…"
              />
              <SearchableMultiSelect
                label="Source file"
                tip="Original import/upload filename for the row."
                options={sourceFileOptions}
                selected={sourceFiles}
                onChange={(next) => patchFilters({ sourceFiles: next })}
                placeholder="All source files"
                searchPlaceholder="Search file…"
              />
            </>
          }
        />
      </section>

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <p className="text-sm">
            <span className="font-medium tabular-nums">{items.length}</span>
            <span className="muted-text">
              {ownerNamesForExport.length === 1
                ? ` transaction${items.length === 1 ? '' : 's'} for ${ownerNamesForExport[0]}`
                : ' matching transaction(s)'}
            </span>
          </p>
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={items.length === 0 || rowsLoading}
            onClick={exportCsv}
          >
            Export CSV
          </button>
        </div>
        {rowsLoading ? (
          <LoadingState />
        ) : rowsError ? (
          <ErrorState
            message="We couldn't load matching transactions. Please try again."
            error={depositsQuery.error ?? expensesQuery.error}
          />
        ) : items.length === 0 ? (
          <EmptyState message="No transactions match these filters." />
        ) : (
          <TransactionTable
            rows={items}
            emptyMessage="No transactions match these filters."
            showActions={false}
            showBalance={false}
            className="overflow-x-auto"
          />
        )}
      </section>
    </div>
  );
}
