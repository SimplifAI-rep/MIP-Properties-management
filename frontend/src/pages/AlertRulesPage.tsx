import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AlertRule } from '../types';
import {
  EmptyState,
  ErrorState,
  formatCurrency,
  InlineError,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { getUserErrorMessage, validationError } from '../utils/errors';

type SeverityOption = AlertRule['severity'];

const SEVERITY_OPTIONS: SeverityOption[] = ['warning', 'error', 'info'];

export function AlertRulesPage() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<unknown>(null);
  const [globalThreshold, setGlobalThreshold] = useState('');
  const [globalSeverity, setGlobalSeverity] = useState<SeverityOption>('warning');
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [overridePropertyId, setOverridePropertyId] = useState('');
  const [overrideThreshold, setOverrideThreshold] = useState('');
  const [overrideSeverity, setOverrideSeverity] = useState<SeverityOption>('warning');

  const rulesQuery = useQuery({
    queryKey: ['alert-rules'],
    queryFn: api.getAlertRules,
  });

  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });

  const globalRule = useMemo(
    () => (rulesQuery.data ?? []).find((rule) => rule.scope_type === 'global') ?? null,
    [rulesQuery.data],
  );

  const propertyRules = useMemo(
    () => (rulesQuery.data ?? []).filter((rule) => rule.scope_type === 'property'),
    [rulesQuery.data],
  );

  const propertyOptions = useMemo(() => {
    const used = new Set(
      propertyRules.map((rule) => rule.property_id).filter(Boolean) as string[],
    );
    return (propertiesQuery.data ?? [])
      .filter((property) => !used.has(property.id))
      .map((property) => ({
        id: property.id,
        label: `${property.client_prop_id} — ${property.name}`,
      }));
  }, [propertiesQuery.data, propertyRules]);

  // Sync local global form when rule loads / changes
  useEffect(() => {
    if (!globalRule) return;
    setGlobalThreshold(String(globalRule.threshold_amount));
    setGlobalSeverity(globalRule.severity);
    setGlobalEnabled(globalRule.enabled);
  }, [globalRule]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
    queryClient.invalidateQueries({ queryKey: ['alerts'] });
    queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
  };

  const saveGlobalMutation = useMutation({
    mutationFn: async () => {
      const amount = globalThreshold.trim();
      if (!amount || Number.isNaN(Number(amount))) {
        throw validationError('Enter a valid global threshold amount.');
      }
      if (globalRule) {
        return api.updateAlertRule(globalRule.id, {
          threshold_amount: amount,
          severity: globalSeverity,
          enabled: globalEnabled,
          name: 'Global low balance',
        });
      }
      return api.createAlertRule({
        name: 'Global low balance',
        scope_type: 'global',
        threshold_amount: amount,
        severity: globalSeverity,
        enabled: globalEnabled,
      });
    },
    onSuccess: () => {
      setFormError(null);
      invalidate();
    },
    onError: (error) => setFormError(error),
  });

  const createOverrideMutation = useMutation({
    mutationFn: async () => {
      if (!overridePropertyId) {
        throw validationError('Choose a property for the override.');
      }
      const amount = overrideThreshold.trim();
      if (!amount || Number.isNaN(Number(amount))) {
        throw validationError('Enter a valid override threshold amount.');
      }
      const property = (propertiesQuery.data ?? []).find((item) => item.id === overridePropertyId);
      return api.createAlertRule({
        name: `Low balance — ${property?.client_prop_id ?? 'property'}`,
        scope_type: 'property',
        property_id: overridePropertyId,
        threshold_amount: amount,
        severity: overrideSeverity,
        enabled: true,
      });
    },
    onSuccess: () => {
      setFormError(null);
      setOverridePropertyId('');
      setOverrideThreshold('');
      setOverrideSeverity('warning');
      invalidate();
    },
    onError: (error) => setFormError(error),
  });

  const updateOverrideMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { threshold_amount?: string; enabled?: boolean; severity?: SeverityOption };
    }) => api.updateAlertRule(id, payload),
    onSuccess: () => {
      setFormError(null);
      invalidate();
    },
    onError: (error) => setFormError(error),
  });

  const deleteOverrideMutation = useMutation({
    mutationFn: (id: string) => api.deleteAlertRule(id),
    onSuccess: () => {
      setFormError(null);
      invalidate();
    },
    onError: (error) => setFormError(error),
  });

  if (rulesQuery.isLoading || propertiesQuery.isLoading) return <LoadingState />;
  if (rulesQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load alert rules. Please try again."
        error={rulesQuery.error}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Alert rules</h2>
        <p className="page-desc">
          Configure when low-balance alerts appear. Balance uses company float (Inflow − Expenses),
          same as the Transactions page. A per-property override beats the global threshold.
        </p>
      </div>

      {formError ? (
        <InlineError
          message={getUserErrorMessage(formError, 'Could not save alert rule.')}
          error={formError}
        />
      ) : null}

      <section className="panel p-5 space-y-4">
        <h3 className="subheading">
          <Tooltip content="Applies to every property that does not have its own override.">
            Global low-balance threshold
          </Tooltip>
        </h3>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm md:col-span-2">
            <span className="label-text">Threshold amount (ILS)</span>
            <input
              type="number"
              step="0.01"
              className="field"
              value={globalThreshold}
              onChange={(event) => setGlobalThreshold(event.target.value)}
              placeholder="e.g. 0 or 5000"
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Severity</span>
            <select
              className="field"
              value={globalSeverity}
              onChange={(event) => setGlobalSeverity(event.target.value as SeverityOption)}
            >
              {SEVERITY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 text-sm pb-2">
            <input
              type="checkbox"
              checked={globalEnabled}
              onChange={(event) => setGlobalEnabled(event.target.checked)}
            />
            <span>Enabled</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            disabled={saveGlobalMutation.isPending}
            onClick={() => saveGlobalMutation.mutate()}
          >
            {saveGlobalMutation.isPending
              ? 'Saving…'
              : globalRule
                ? 'Save global rule'
                : 'Create global rule'}
          </button>
          {globalRule ? (
            <span className="text-sm text-muted">
              Current: {formatCurrency(globalRule.threshold_amount)} ·{' '}
              {globalRule.enabled ? 'on' : 'off'}
            </span>
          ) : (
            <span className="text-sm text-muted">No global rule yet — create one to start.</span>
          )}
        </div>
      </section>

      <section className="panel p-5 space-y-4">
        <h3 className="subheading">Per-property overrides</h3>
        <p className="text-sm text-muted">
          Optional. When set, this property uses its own threshold instead of the global one.
        </p>

        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm md:col-span-2">
            <span className="label-text">Property</span>
            <select
              className="field"
              value={overridePropertyId}
              onChange={(event) => setOverridePropertyId(event.target.value)}
            >
              <option value="">Select property</option>
              {propertyOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="label-text">Threshold</span>
            <input
              type="number"
              step="0.01"
              className="field"
              value={overrideThreshold}
              onChange={(event) => setOverrideThreshold(event.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="label-text">Severity</span>
            <select
              className="field"
              value={overrideSeverity}
              onChange={(event) => setOverrideSeverity(event.target.value as SeverityOption)}
            >
              {SEVERITY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={createOverrideMutation.isPending || propertyOptions.length === 0}
          onClick={() => createOverrideMutation.mutate()}
        >
          {createOverrideMutation.isPending ? 'Adding…' : 'Add override'}
        </button>

        {propertyRules.length === 0 ? (
          <EmptyState message="No property overrides yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3 font-medium">Property</th>
                  <th className="px-4 py-3 font-medium">Threshold</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Enabled</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {propertyRules.map((rule) => (
                  <tr key={rule.id} className="table-row">
                    <td className="px-4 py-3">
                      <p className="font-medium">
                        {rule.client_prop_id ?? '—'} — {rule.property_name ?? 'Property'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        step="0.01"
                        className="field field-compact max-w-[9rem]"
                        defaultValue={rule.threshold_amount}
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (!next || next === String(rule.threshold_amount)) return;
                          updateOverrideMutation.mutate({
                            id: rule.id,
                            payload: { threshold_amount: next },
                          });
                        }}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className="field field-compact"
                        value={rule.severity}
                        onChange={(event) =>
                          updateOverrideMutation.mutate({
                            id: rule.id,
                            payload: { severity: event.target.value as SeverityOption },
                          })
                        }
                      >
                        {SEVERITY_OPTIONS.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(event) =>
                          updateOverrideMutation.mutate({
                            id: rule.id,
                            payload: { enabled: event.target.checked },
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="btn-danger text-xs"
                        disabled={deleteOverrideMutation.isPending}
                        onClick={() => {
                          if (!window.confirm('Delete this property override?')) return;
                          deleteOverrideMutation.mutate(rule.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
