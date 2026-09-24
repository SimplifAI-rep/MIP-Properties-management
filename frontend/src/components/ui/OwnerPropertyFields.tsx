import type { OwnerSummary, Property } from '../../types';

const UNASSIGNED_PROP_ID = 'UNASSIGNED';

export function OwnerPropertyFields({
  owners,
  properties,
  ownerId,
  propertyId,
  onChange,
  excludeUnassigned = true,
  required = true,
}: {
  owners: OwnerSummary[];
  properties: Property[];
  ownerId: string;
  propertyId: string;
  onChange: (next: { ownerId: string; propertyId: string }) => void;
  excludeUnassigned?: boolean;
  required?: boolean;
}) {
  const visibleProperties = properties.filter((property) => {
    if (excludeUnassigned && property.client_prop_id === UNASSIGNED_PROP_ID) {
      return property.id === propertyId;
    }
    return true;
  });
  const ownerProperties = ownerId
    ? visibleProperties.filter((property) => property.owner_id === ownerId)
    : visibleProperties;
  const visibleOwners = owners.filter((owner) =>
    visibleProperties.some((property) => property.owner_id === owner.id),
  );

  return (
    <>
      <label className="text-sm">
        <span className="label-text">Owner</span>
        <select
          required={required}
          className="field"
          value={ownerId}
          onChange={(event) => {
            const nextOwner = event.target.value;
            const stillValid = visibleProperties.some(
              (property) =>
                property.id === propertyId && property.owner_id === nextOwner,
            );
            onChange({
              ownerId: nextOwner,
              propertyId: stillValid ? propertyId : '',
            });
          }}
        >
          <option value="">Select owner</option>
          {visibleOwners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="label-text">Prop ID / Property</span>
        <select
          required={required}
          className="field"
          value={propertyId}
          disabled={required && !ownerId}
          onChange={(event) => {
            const nextProperty = event.target.value;
            const match = visibleProperties.find((property) => property.id === nextProperty);
            onChange({
              ownerId: match?.owner_id || ownerId,
              propertyId: nextProperty,
            });
          }}
        >
          <option value="">Select property</option>
          {(ownerId ? ownerProperties : visibleProperties).map((property) => (
            <option key={property.id} value={property.id}>
              {property.client_prop_id} — {property.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
