/** Shared display helpers for enum-like snake_case values. */

export function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}
