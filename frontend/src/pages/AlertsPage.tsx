import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AlertItem, DepositCreate, TransactionDraft } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui/States';

const CATEGORIES = [
  'maintenance',
  'tax',
  'insurance',
  'utilities',
  'management_fee',
  'other',
] as const;

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function severityBadge(severity: AlertItem['severity']) {
  if (severity === 'error') return 'badge-expense';
  if (severity === 'warning') return 'badge-warning';
  return 'badge-neutral';
}

function typeLabel(alertType: AlertItem['alert_type']) {
  if (alertType === 'missing_deposit') return 'Missing deposit';
  if (alertType === 'duplicate_deposit') return 'Possible duplicate';
  return 'Upload review';
}

function buildDepositForm(alert: AlertItem): DepositCreate {
  const gap = alert.gap;
  const today = new Date();
  const dueDay = gap?.due_day ?? 1;
  const year = gap?.period_start
    ? new Date(gap.period_start).getFullYear()
    : today.getFullYear();
  const month = gap?.period_start
    ? new Date(gap.period_start).getMonth()
    : today.getMonth();
  const day = Math.min(dueDay, new Date(year, month + 1, 0).getDate());
  const transactionDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    property_id: alert.property_id ?? '',
    bank_account_id: '',
    transaction_date: transactionDate,
    amount: gap?.expected_amount ?? '',
    currency: 'ILS',
    description: gap
      ? `Manual entry for expected ${label(gap.period_start.slice(0, 7))} deposit`
      : '',
  };
}

export function AlertsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depositForm, setDepositForm] = useState<DepositCreate | null>(null);
  const [drafts, setDrafts] = useState<TransactionDraft[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: api.getAlerts,
  });

  const selectedAlert = useMemo(
    () => alertsQuery.data?.items.find((alert) => alert.id === selectedId) ?? null,
    [alertsQuery.data, selectedId],
  );

  const propertyQuery = useQuery({
    queryKey: ['property', selectedAlert?.property_id],
    queryFn: () => api.getProperty(selectedAlert!.property_id!),
    enabled: Boolean(
      selectedAlert?.property_id &&
        (selectedAlert.alert_type === 'missing_deposit' ||
          selectedAlert.transaction_type === 'deposit'),
    ),
  });

  const dismissMutation = useMutation({
    mutationFn: (alertId: string) => api.dismissAlert(alertId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
      setSelectedId(null);
      setActionError(null);
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const resolveMutation = useMutation({
    mutationFn: (payload: { alertId: string; body: Parameters<typeof api.resolveAlert>[1] }) =>
      api.resolveAlert(payload.alertId, payload.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.invalidateQueries({ queryKey: ['alert-summary'] });
      queryClient.invalidateQueries({ queryKey: ['deposits'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
      queryClient.invalidateQueries({ queryKey: ['deposit-summary'] });
      queryClient.invalidateQueries({ queryKey: ['expense-summary'] });
      setSelectedId(null);
      setDepositForm(null);
      setDrafts([]);
      setActionError(null);
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const selectAlert = (alert: AlertItem) => {
    setSelectedId(alert.id);
    setActionError(null);
    if (alert.alert_type === 'missing_deposit') {
      setDepositForm(buildDepositForm(alert));
      setDrafts([]);
    } else {
      setDepositForm(null);
      setDrafts(alert.drafts);
    }
  };

  const updateDraft = (index: number, patch: Partial<TransactionDraft>) => {
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, ...patch, status: 'needs_review' } : draft,
      ),
    );
  };

  const removeDraft = (index: number) => {
    setDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index));
  };

  if (alertsQuery.isLoading) return <LoadingState />;
  if (alertsQuery.isError) {
    return <ErrorState message="Could not load alerts from the API." />;
  }

  const alerts = alertsQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Alerts</h2>
        <p className="page-desc">
          Review missing deposits and uploaded files that need attention. Click an alert to fix it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Open alerts" value={alertsQuery.data?.total ?? 0} />
        <Card title="Errors" value={alertsQuery.data?.error_count ?? 0} />
        <Card title="Warnings" value={alertsQuery.data?.warning_count ?? 0} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <section className="panel">
          {alerts.length === 0 ? (
            <div className="p-5">
              <EmptyState message="No open alerts. Everything looks good." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-shell">
                <thead className="table-head">
                  <tr>
                    <th className="px-5 py-3 font-medium">Severity</th>
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Alert</th>
                    <th className="px-5 py-3 font-medium">Property</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => (
                    <tr
                      key={alert.id}
                      onClick={() => selectAlert(alert)}
                      className={`table-row-interactive ${
                        selectedId === alert.id ? 'table-row-selected' : ''
                      }`}
                    >
                      <td className="px-5 py-3">
                        <span className={severityBadge(alert.severity)}>{alert.severity}</span>
                      </td>
                      <td className="px-5 py-3">{typeLabel(alert.alert_type)}</td>
                      <td className="px-5 py-3">
                        <p className="font-medium">{alert.title}</p>
                        <p className="text-xs text-muted">{alert.message}</p>
                      </td>
                      <td className="px-5 py-3">
                        <p>{alert.property_name}</p>
                        <p className="text-xs text-muted">{alert.owner_name}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel p-4">
          {!selectedAlert ? (
            <p className="muted-text">Select an alert to review and resolve it.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="subheading">{selectedAlert.title}</h3>
                <p className="mt-1 text-sm text-muted">{selectedAlert.message}</p>
              </div>

              {selectedAlert.alert_type === 'missing_deposit' && depositForm ? (
                <form
                  className="grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!depositForm.bank_account_id) {
                      setActionError('Select a bank account.');
                      return;
                    }
                    resolveMutation.mutate({
                      alertId: selectedAlert.id,
                      body: {
                        action: 'add_deposit',
                        deposit: depositForm,
                      },
                    });
                  }}
                >
                  <label className="text-sm">
                    <span className="label-text">Bank account</span>
                    <select
                      required
                      className="field"
                      value={depositForm.bank_account_id}
                      onChange={(event) =>
                        setDepositForm((current) =>
                          current
                            ? { ...current, bank_account_id: event.target.value }
                            : current,
                        )
                      }
                    >
                      <option value="">Select account</option>
                      {(propertyQuery.data?.bank_accounts ?? []).map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.account_number}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="label-text">Date</span>
                    <input
                      required
                      type="date"
                      className="field"
                      value={depositForm.transaction_date}
                      onChange={(event) =>
                        setDepositForm((current) =>
                          current
                            ? { ...current, transaction_date: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label className="text-sm">
                    <span className="label-text">Amount</span>
                    <input
                      required
                      type="number"
                      min="0.01"
                      step="0.01"
                      className="field"
                      value={depositForm.amount}
                      onChange={(event) =>
                        setDepositForm((current) =>
                          current ? { ...current, amount: event.target.value } : current,
                        )
                      }
                    />
                  </label>
                  <label className="text-sm">
                    <span className="label-text">Description</span>
                    <input
                      type="text"
                      className="field"
                      value={depositForm.description ?? ''}
                      onChange={(event) =>
                        setDepositForm((current) =>
                          current
                            ? { ...current, description: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={resolveMutation.isPending}
                    className="btn-primary"
                  >
                    {resolveMutation.isPending ? 'Saving...' : 'Add deposit & resolve'}
                  </button>
                </form>
              ) : null}

              {selectedAlert.alert_type !== 'missing_deposit' ? (
                <div className="space-y-3">
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="data-table min-w-full">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Date</th>
                          <th>Amount</th>
                          {selectedAlert.transaction_type === 'deposit' ? <th>Account</th> : null}
                          {selectedAlert.transaction_type === 'expense' ? (
                            <>
                              <th>Category</th>
                              <th>Vendor</th>
                            </>
                          ) : null}
                          <th>Alerts</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {drafts.map((draft, index) => (
                          <tr key={draft.row_number ?? index}>
                            <td>{draft.row_number ?? index + 1}</td>
                            <td>
                              <input
                                type="date"
                                className="field field-compact"
                                value={draft.transaction_date ?? ''}
                                onChange={(event) =>
                                  updateDraft(index, { transaction_date: event.target.value })
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                min="0.01"
                                step="0.01"
                                className="field field-compact"
                                value={draft.amount ?? ''}
                                onChange={(event) =>
                                  updateDraft(index, { amount: event.target.value })
                                }
                              />
                            </td>
                            {selectedAlert.transaction_type === 'deposit' ? (
                              <td>
                                <select
                                  className="field field-compact"
                                  value={draft.bank_account_id ?? ''}
                                  onChange={(event) => {
                                    const account = propertyQuery.data?.bank_accounts.find(
                                      (item) => item.id === event.target.value,
                                    );
                                    updateDraft(index, {
                                      bank_account_id: event.target.value || null,
                                      account_number: account?.account_number ?? draft.account_number,
                                    });
                                  }}
                                >
                                  <option value="">Select account</option>
                                  {(propertyQuery.data?.bank_accounts ?? []).map((account) => (
                                    <option key={account.id} value={account.id}>
                                      {account.account_number}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            ) : null}
                            {selectedAlert.transaction_type === 'expense' ? (
                              <>
                                <td>
                                  <select
                                    className="field field-compact"
                                    value={draft.category ?? 'other'}
                                    onChange={(event) =>
                                      updateDraft(index, { category: event.target.value })
                                    }
                                  >
                                    {CATEGORIES.map((item) => (
                                      <option key={item} value={item}>
                                        {label(item)}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    className="field field-compact"
                                    value={draft.vendor_name ?? ''}
                                    onChange={(event) =>
                                      updateDraft(index, { vendor_name: event.target.value })
                                    }
                                  />
                                </td>
                              </>
                            ) : null}
                            <td className="min-w-36">
                              {draft.warnings.length === 0 ? (
                                <span className="text-muted text-xs">None</span>
                              ) : (
                                <ul className="space-y-1 text-xs">
                                  {draft.warnings.map((warning) => (
                                    <li
                                      key={`${warning.field}-${warning.message}`}
                                      className={
                                        warning.severity === 'error'
                                          ? 'text-negative'
                                          : 'text-caution'
                                      }
                                    >
                                      {warning.message}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                            <td>
                              {draft.warnings.some((warning) =>
                                warning.message.toLowerCase().includes('duplicate'),
                              ) ? (
                                <button
                                  type="button"
                                  className="btn-secondary text-xs"
                                  onClick={() => removeDraft(index)}
                                >
                                  Skip duplicate
                                </button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={resolveMutation.isPending || drafts.length === 0}
                      onClick={() =>
                        resolveMutation.mutate({
                          alertId: selectedAlert.id,
                          body: {
                            action: 'confirm_upload',
                            drafts,
                          },
                        })
                      }
                    >
                      {resolveMutation.isPending ? 'Saving...' : 'Confirm & resolve'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={dismissMutation.isPending}
                      onClick={() => dismissMutation.mutate(selectedAlert.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={dismissMutation.isPending}
                  onClick={() => dismissMutation.mutate(selectedAlert.id)}
                >
                  Dismiss alert
                </button>
              )}

              {actionError ? <p className="text-negative text-sm">{actionError}</p> : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
