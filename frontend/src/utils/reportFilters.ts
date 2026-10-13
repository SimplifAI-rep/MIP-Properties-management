import type {
  AlertFilterKind,
  PropertyStatusFilter,
  TypeFilterKind,
} from './transactionTypeFilters';
import { DEFAULT_TYPE_KINDS } from './transactionTypeFilters';

export type ReportFilterSnapshot = {
  kinds: TypeFilterKind[];
  propertyStatuses: PropertyStatusFilter[];
  propertyIds: string[];
  clientPropIds: string[];
  ownerIds: string[];
  dateFrom?: string;
  dateTo?: string;
  sections: string[];
  sources: string[];
  sourceFiles: string[];
  alertFilters: AlertFilterKind[];
};

export type ReportFilterApi = {
  kinds: string[];
  property_statuses: string[];
  property_ids: string[];
  client_prop_ids: string[];
  owner_ids: string[];
  date_from: string | null;
  date_to: string | null;
  sections: string[];
  sources: string[];
  source_files: string[];
  alert_filters: string[];
};

export function emptyReportFilters(): ReportFilterSnapshot {
  return {
    kinds: [...DEFAULT_TYPE_KINDS],
    propertyStatuses: ['active'],
    propertyIds: [],
    clientPropIds: [],
    ownerIds: [],
    dateFrom: undefined,
    dateTo: undefined,
    sections: [],
    sources: [],
    sourceFiles: [],
    alertFilters: [],
  };
}

export const DEFAULT_REPORT_FILTERS: ReportFilterSnapshot = emptyReportFilters();

export function snapshotIsDefault(filters: ReportFilterSnapshot): boolean {
  return (
    filters.kinds.length === DEFAULT_TYPE_KINDS.length &&
    DEFAULT_TYPE_KINDS.every((kind) => filters.kinds.includes(kind)) &&
    filters.propertyStatuses.length === 1 &&
    filters.propertyStatuses[0] === 'active' &&
    filters.alertFilters.length === 0 &&
    filters.propertyIds.length === 0 &&
    filters.clientPropIds.length === 0 &&
    filters.ownerIds.length === 0 &&
    !filters.dateFrom &&
    !filters.dateTo &&
    filters.sections.length === 0 &&
    filters.sources.length === 0 &&
    filters.sourceFiles.length === 0
  );
}

function sortedCopy<T extends string>(values: T[]): T[] {
  return [...values].sort();
}

export function snapshotsEqual(
  a: ReportFilterSnapshot,
  b: ReportFilterSnapshot,
): boolean {
  return (
    JSON.stringify({
      kinds: sortedCopy(a.kinds),
      propertyStatuses: sortedCopy(a.propertyStatuses),
      propertyIds: sortedCopy(a.propertyIds),
      clientPropIds: sortedCopy(a.clientPropIds),
      ownerIds: sortedCopy(a.ownerIds),
      dateFrom: a.dateFrom ?? '',
      dateTo: a.dateTo ?? '',
      sections: sortedCopy(a.sections),
      sources: sortedCopy(a.sources),
      sourceFiles: sortedCopy(a.sourceFiles),
      alertFilters: sortedCopy(a.alertFilters),
    }) ===
    JSON.stringify({
      kinds: sortedCopy(b.kinds),
      propertyStatuses: sortedCopy(b.propertyStatuses),
      propertyIds: sortedCopy(b.propertyIds),
      clientPropIds: sortedCopy(b.clientPropIds),
      ownerIds: sortedCopy(b.ownerIds),
      dateFrom: b.dateFrom ?? '',
      dateTo: b.dateTo ?? '',
      sections: sortedCopy(b.sections),
      sources: sortedCopy(b.sources),
      sourceFiles: sortedCopy(b.sourceFiles),
      alertFilters: sortedCopy(b.alertFilters),
    })
  );
}

export function snapshotToApi(filters: ReportFilterSnapshot): ReportFilterApi {
  return {
    kinds: filters.kinds,
    property_statuses: filters.propertyStatuses,
    property_ids: filters.propertyIds,
    client_prop_ids: filters.clientPropIds,
    owner_ids: filters.ownerIds,
    date_from: filters.dateFrom ?? null,
    date_to: filters.dateTo ?? null,
    sections: filters.sections,
    sources: filters.sources,
    source_files: filters.sourceFiles,
    alert_filters: filters.alertFilters,
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

export function snapshotFromApi(filters: ReportFilterApi | Record<string, unknown>): ReportFilterSnapshot {
  const kinds = Array.isArray(filters.kinds)
    ? (asStringList(filters.kinds) as TypeFilterKind[])
    : [...DEFAULT_TYPE_KINDS];
  const statuses = Array.isArray(
    'property_statuses' in filters ? filters.property_statuses : undefined,
  )
    ? (asStringList(filters.property_statuses) as PropertyStatusFilter[])
    : (['active'] as PropertyStatusFilter[]);
  return {
    kinds,
    propertyStatuses: statuses,
    propertyIds: asStringList(
      'property_ids' in filters ? filters.property_ids : [],
    ),
    clientPropIds: asStringList(
      'client_prop_ids' in filters ? filters.client_prop_ids : [],
    ),
    ownerIds: asStringList('owner_ids' in filters ? filters.owner_ids : []),
    dateFrom: (filters.date_from as string | null | undefined) || undefined,
    dateTo: (filters.date_to as string | null | undefined) || undefined,
    sections: asStringList(filters.sections),
    sources: asStringList(filters.sources),
    sourceFiles: asStringList(
      'source_files' in filters ? filters.source_files : [],
    ),
    alertFilters: asStringList(
      'alert_filters' in filters ? filters.alert_filters : [],
    ) as AlertFilterKind[],
  };
}
