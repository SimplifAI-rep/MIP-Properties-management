import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { OwnerSummary, Property } from '../types';

export type FilterOption = { value: string; label: string };

export function buildOwnerOptions(owners: OwnerSummary[]): FilterOption[] {
  return owners.map((owner) => ({
    value: owner.id,
    label: owner.name,
  }));
}

export function buildPropertyOptions(properties: Property[]): FilterOption[] {
  return properties.map((property) => ({
    value: property.id,
    label: `${property.client_prop_id} — ${property.name}`,
  }));
}

export function buildPropIdOptions(properties: Property[]): FilterOption[] {
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
