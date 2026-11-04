import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { OwnerSummary, Property } from '../types';

export type FilterOption = { value: string; label: string };

function buildOwnerOptions(owners: OwnerSummary[]): FilterOption[] {
  return owners.map((owner) => ({
    value: owner.id,
    label: owner.name,
  }));
}

function buildPropertyOptions(properties: Property[]): FilterOption[] {
  return properties.map((property) => ({
    value: property.id,
    label: `${property.client_prop_id} — ${property.name}`,
  }));
}

function buildPropIdOptions(properties: Property[]): FilterOption[] {
  return properties.map((property) => ({
    value: property.client_prop_id,
    label:
      property.status !== 'active'
        ? `${property.client_prop_id} (inactive)`
        : property.client_prop_id,
  }));
}

export function syncClientPropIdsFromProperties(
  propertyIds: string[],
  properties: Property[],
): string[] {
  return propertyIds
    .map((id) => properties.find((property) => property.id === id)?.client_prop_id)
    .filter((value): value is string => Boolean(value));
}

export function syncPropertyIdsFromPropIds(
  clientPropIds: string[],
  properties: Property[],
): string[] {
  return clientPropIds
    .map((propId) => properties.find((property) => property.client_prop_id === propId)?.id)
    .filter((value): value is string => Boolean(value));
}

function propertyById(properties: Property[], id: string): Property | undefined {
  return properties.find((property) => property.id === id);
}

function matchesPropertyStatus(property: Property, propertyStatuses: string[]): boolean {
  if (propertyStatuses.length !== 1) return true;
  return property.status === propertyStatuses[0];
}

/** Drop property selections that no longer belong to the selected owners. */
export function pruneEntityFiltersByOwner(
  properties: Property[],
  ownerIds: string[],
  propertyIds: string[],
): { propertyIds: string[]; clientPropIds: string[] } {
  const kept = ownerIds.length
    ? propertyIds.filter((id) => {
        const property = propertyById(properties, id);
        return Boolean(property && ownerIds.includes(property.owner_id));
      })
    : propertyIds;
  return {
    propertyIds: kept,
    clientPropIds: syncClientPropIdsFromProperties(kept, properties),
  };
}

/** Drop property selections that no longer match the selected property status. */
export function pruneEntityFiltersByStatus(
  properties: Property[],
  propertyStatuses: string[],
  propertyIds: string[],
): { propertyIds: string[]; clientPropIds: string[] } {
  const kept =
    propertyStatuses.length === 1
      ? propertyIds.filter((id) => {
          const property = propertyById(properties, id);
          return Boolean(property && matchesPropertyStatus(property, propertyStatuses));
        })
      : propertyIds;
  return {
    propertyIds: kept,
    clientPropIds: syncClientPropIdsFromProperties(kept, properties),
  };
}

/** Drop owner selections that do not own any of the selected properties. */
export function pruneOwnerIdsToProperties(
  properties: Property[],
  ownerIds: string[],
  propertyIds: string[],
  clientPropIds: string[],
): string[] {
  if (!propertyIds.length && !clientPropIds.length) return ownerIds;
  const selected = properties.filter(
    (property) =>
      propertyIds.includes(property.id) ||
      clientPropIds.includes(property.client_prop_id),
  );
  if (!selected.length) return ownerIds;
  const allowed = new Set(selected.map((property) => property.owner_id));
  return ownerIds.filter((id) => allowed.has(id));
}

export function cascadeEntityFilterValues(
  properties: Property[],
  next: { ownerIds: string[]; propertyIds: string[]; clientPropIds: string[] },
): { ownerIds: string[]; propertyIds: string[]; clientPropIds: string[] } {
  const byOwner = pruneEntityFiltersByOwner(
    properties,
    next.ownerIds,
    next.propertyIds,
  );
  return {
    ownerIds: pruneOwnerIdsToProperties(
      properties,
      next.ownerIds,
      byOwner.propertyIds,
      byOwner.clientPropIds,
    ),
    propertyIds: byOwner.propertyIds,
    clientPropIds: byOwner.clientPropIds,
  };
}

/** Narrow owner / property / Prop ID dropdowns from the other selected filters. */
export function cascadeOwnerPropertyFilterOptions({
  properties,
  ownerOptions,
  propertyOptions,
  propIdOptions,
  ownerIds,
  propertyIds,
  clientPropIds,
  propertyStatuses,
}: {
  properties: Property[];
  ownerOptions: FilterOption[];
  propertyOptions: FilterOption[];
  propIdOptions: FilterOption[];
  ownerIds: string[];
  propertyIds: string[];
  clientPropIds: string[];
  propertyStatuses: string[];
}): {
  ownerOptions: FilterOption[];
  propertyOptions: FilterOption[];
  propIdOptions: FilterOption[];
} {
  const statusMatched = properties.filter((property) =>
    matchesPropertyStatus(property, propertyStatuses),
  );

  let propertyPool = statusMatched;
  if (ownerIds.length) {
    const ownerSet = new Set(ownerIds);
    propertyPool = propertyPool.filter((property) => ownerSet.has(property.owner_id));
  }

  const selectedProperties = statusMatched.filter(
    (property) =>
      propertyIds.includes(property.id) ||
      clientPropIds.includes(property.client_prop_id),
  );
  const allowedOwnerIds = selectedProperties.length
    ? new Set(selectedProperties.map((property) => property.owner_id))
    : null;
  const allowedPropertyIds = new Set(propertyPool.map((property) => property.id));
  const allowedClientPropIds = new Set(
    propertyPool.map((property) => property.client_prop_id),
  );

  return {
    ownerOptions: allowedOwnerIds
      ? ownerOptions.filter((option) => allowedOwnerIds.has(option.value))
      : ownerOptions,
    propertyOptions: propertyOptions.filter((option) =>
      allowedPropertyIds.has(option.value),
    ),
    propIdOptions: propIdOptions.filter((option) =>
      allowedClientPropIds.has(option.value),
    ),
  };
}

/** Shared owner / property / Prop ID option lists for filter panels. */
export function useOwnerPropertyFilterOptions() {
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const owners = ownersQuery.data ?? [];
  const properties = propertiesQuery.data ?? [];

  const ownerOptions = useMemo(() => buildOwnerOptions(owners), [owners]);
  const propertyOptions = useMemo(() => buildPropertyOptions(properties), [properties]);
  const propIdOptions = useMemo(() => buildPropIdOptions(properties), [properties]);

  return {
    owners,
    properties,
    ownerOptions,
    propertyOptions,
    propIdOptions,
    ownersQuery,
    propertiesQuery,
    isLoading: ownersQuery.isLoading || propertiesQuery.isLoading,
    isError: ownersQuery.isError || propertiesQuery.isError,
    error: ownersQuery.error ?? propertiesQuery.error,
  };
}
