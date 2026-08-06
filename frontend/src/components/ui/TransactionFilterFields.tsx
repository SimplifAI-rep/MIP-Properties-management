import type { ReactNode } from 'react';
import { DateInputDMY } from './DateInputDMY';
import { SearchableMultiSelect } from './SearchableMultiSelect';
import type { FilterOption } from '../../hooks/useOwnerPropertyFilterOptions';

export type TransactionEntityFilters = {
  ownerIds: string[];
  propertyIds: string[];
  clientPropIds: string[];
  dateFrom?: string;
  dateTo?: string;
  minAmount?: string;
  maxAmount?: string;
};

type TransactionFilterFieldsProps = {
  value: TransactionEntityFilters;
  onChange: (next: TransactionEntityFilters) => void;
  ownerOptions: FilterOption[];
  propertyOptions: FilterOption[];
  propIdOptions: FilterOption[];
  showAmounts?: boolean;
  /** Rendered before entity fields (e.g. Type / Alerts). */
  prepend?: ReactNode;
  /** Rendered after entity fields (e.g. Section / Source). */
  append?: ReactNode;
  onSyncFromProperties?: (propertyIds: string[]) => {
    propertyIds: string[];
    clientPropIds: string[];
  };
  onSyncFromPropIds?: (clientPropIds: string[]) => {
    propertyIds: string[];
    clientPropIds: string[];
  };
};

/** Entity filter fields only — wrap in `.filter-panel` in the parent. */
export function TransactionFilterFields({
  value,
  onChange,
  ownerOptions,
  propertyOptions,
  propIdOptions,
  showAmounts = true,
  prepend,
  append,
  onSyncFromProperties,
  onSyncFromPropIds,
}: TransactionFilterFieldsProps) {
  const patch = (partial: Partial<TransactionEntityFilters>) =>
    onChange({ ...value, ...partial });

  return (
    <>
      {prepend}
      <SearchableMultiSelect
        label="Prop ID"
        tip="Excel Prop ID — select one or more. Syncs with Property."
        options={propIdOptions}
        selected={value.clientPropIds}
        onChange={(clientPropIds) => {
          if (onSyncFromPropIds) {
            patch(onSyncFromPropIds(clientPropIds));
            return;
          }
          patch({ clientPropIds });
        }}
        placeholder="All Prop IDs"
        searchPlaceholder="Search Prop ID…"
      />
      <SearchableMultiSelect
        label="Property"
        tip="Select one or more properties. Syncs with Prop ID."
        options={propertyOptions}
        selected={value.propertyIds}
        onChange={(propertyIds) => {
          if (onSyncFromProperties) {
            patch(onSyncFromProperties(propertyIds));
            return;
          }
          patch({ propertyIds });
        }}
        placeholder="All properties"
        searchPlaceholder="Search property…"
      />
      <SearchableMultiSelect
        label="Owner"
        tip="Limit results to one or more owners. Combines with other filters."
        options={ownerOptions}
        selected={value.ownerIds}
        onChange={(ownerIds) => patch({ ownerIds })}
        placeholder="All owners"
        searchPlaceholder="Search owner…"
      />
      <DateInputDMY
        label="From date"
        value={value.dateFrom}
        onChange={(dateFrom) => patch({ dateFrom })}
      />
      <DateInputDMY
        label="To date"
        value={value.dateTo}
        onChange={(dateTo) => patch({ dateTo })}
      />
      {showAmounts ? (
        <>
          <label className="block space-y-1 text-sm">
            <span className="label-text">Min amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={value.minAmount ?? ''}
              onChange={(event) => patch({ minAmount: event.target.value })}
              placeholder="Any"
              className="field w-full text-sm"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="label-text">Max amount</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={value.maxAmount ?? ''}
              onChange={(event) => patch({ maxAmount: event.target.value })}
              placeholder="Any"
              className="field w-full text-sm"
            />
          </label>
        </>
      ) : null}
      {append}
    </>
  );
}
