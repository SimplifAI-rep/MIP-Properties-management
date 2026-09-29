import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  formatCurrency,
} from '../components/ui/States';
import { OwnerPropertyFields, UNASSIGNED_CLIENT_PROP_ID } from '../components/ui/OwnerPropertyFields';
import { PaidWithSelect } from '../components/ui/PaidWithSelect';
import { TransactionAttachmentsField } from '../components/ui/TransactionAttachmentsField';
import { SECTION_SUGGESTIONS } from '../constants/expenseOptions';
import { getUserErrorMessage } from '../utils/errors';
import { invalidateAlertData } from '../utils/invalidateQueries';
import { recordToUnified, type UnifiedTransaction } from '../utils/unifiedTransaction';

const UNASSIGNED_FILTER = {
  client_prop_id: UNASSIGNED_CLIENT_PROP_ID,
  include_running_balance: false as const,
};

function sortUnassigned(rows: UnifiedTransaction[]): UnifiedTransaction[] {
  return [...rows].sort((left, right) => {
    if (!left.transaction_date && !right.transaction_date) return 0;
    if (!left.transaction_date) return -1;
    if (!right.transaction_date) return 1;
    return right.transaction_date.localeCompare(left.transaction_date);
  });
}

export function UnassignedPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<UnifiedTransaction | null>(null);
  const [editOwnerId, setEditOwnerId] = useState('');
  const [editPropertyId, setEditPropertyId] = useState('');
  const [editSection, setEditSection] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editPaymentMethod, setEditPaymentMethod] = useState('company_account');
  const [editCardLast4, setEditCardLast4] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expensesQuery = useQuery({
    queryKey: ['unassigned', 'expenses'],
    queryFn: () => api.getAllExpenses(UNASSIGNED_FILTER),
  });
  const depositsQuery = useQuery({
    queryKey: ['unassigned', 'deposits'],
    queryFn: () => api.getAllDeposits(UNASSIGNED_FILTER),
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const cardsQuery = useQuery({
    queryKey: ['credit-cards'],
    queryFn: api.getCreditCards,
  });

  const canAssign = Boolean(editOwnerId && editPropertyId);

  function expensePayload(assign: boolean) {
    if (editPaymentMethod === 'credit_card' && !editCardLast4) {
      throw new Error('Please select a credit card.');
    }
    const section = editSection.trim() || 'other';
    const notes = editNotes.trim();
    return {
      ...(assign ? { property_id: editPropertyId } : {}),
      category: section,
      notes: notes || null,
      description: notes ? `${section} | ${notes}` : section,
      payment_method: editPaymentMethod || 'company_account',
      card_last4: editPaymentMethod === 'credit_card' ? editCardLast4 : null,
      source:
        editPaymentMethod === 'credit_card' ? 'credit_card' : 'bank_statement',
    };
  }

  const saveMutation = useMutation({
    mutationFn: async (assign: boolean) => {
      if (!editing) {
        throw new Error('Choose a transaction to edit.');
      }
      if (assign && !editPropertyId) {
        throw new Error('Choose an owner and a property.');
      }
      if (editing.kind === 'deposit') {
        return api.updateDeposit(editing.id, {
          ...(assign ? { property_id: editPropertyId } : {}),
          description: editNotes.trim() || null,
        });
      }
      return api.updateExpense(editing.id, expensePayload(assign));
    },
    onSuccess: (_saved, assign) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['unassigned'] });
      void queryClient.invalidateQueries({ queryKey: ['unassigned-count'] });
      void queryClient.invalidateQueries({ queryKey: ['deposits'] });
      void queryClient.invalidateQueries({ queryKey: ['expenses'] });
      invalidateAlertData(queryClient);
      if (assign) {
        setEditing(null);
        setMessage('Assigned.');
        return;
      }
      setMessage('Saved. This row stays on Unassigned until you pick an owner and property.');
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const loading = expensesQuery.isLoading || depositsQuery.isLoading;
  const loadError = expensesQuery.error ?? depositsQuery.error;

  if (loading) return <LoadingState />;
  if (loadError) {
    return (
      <ErrorState
        message="We couldn't load unassigned transactions."
        error={loadError}
      />
    );
  }

  const rows = sortUnassigned([
    ...(expensesQuery.data?.items ?? []).map((row) =>
      recordToUnified(row as unknown as Record<string, unknown>, 'expense'),
    ),
    ...(depositsQuery.data?.items ?? []).map((row) =>
      recordToUnified(row as unknown as Record<string, unknown>, 'deposit'),
    ),
  ]);

  function openAssign(row: UnifiedTransaction) {
    setEditing(row);
    setEditOwnerId('');
    setEditPropertyId('');
    setEditSection(row.kind === 'expense' ? row.section || '' : '');
    setEditNotes(row.notes ?? '');
    setEditPaymentMethod(row.payment_method || 'company_account');
    setEditCardLast4(row.card_last4 ?? null);
    setMessage(null);
    setError(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="page-heading">Unassigned</h2>
        <p className="page-desc mt-1">
          Bank-created rows still sitting on Needs assignment / UNASSIGNED.
          You can save notes and files as you go. The row stays here until you
          assign a real owner and property.
        </p>
      </div>

      {message ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {editing ? (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm font-medium">
            Edit {editing.kind === 'deposit' ? 'deposit' : 'expense'}{' '}
            {formatCurrency(editing.amount)}
          </p>
          <p className="mt-1 text-xs muted-text">
            Save notes, paid-with, and files whenever you want. Files are stored as
            soon as you add them. Assign a real owner and property only when you
            know them — until then the row stays on this page.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <OwnerPropertyFields
              owners={ownersQuery.data ?? []}
              properties={propertiesQuery.data ?? []}
              ownerId={editOwnerId}
              propertyId={editPropertyId}
              excludeUnassigned
              required={false}
              onChange={(next) => {
                setEditOwnerId(next.ownerId);
                setEditPropertyId(next.propertyId);
              }}
            />
            {editing.kind === 'expense' ? (
              <>
                <label className="text-sm">
                  <span className="label-text">Section</span>
                  <input
                    className="field"
                    list="unassigned-section-suggestions"
                    value={editSection}
                    onChange={(event) => setEditSection(event.target.value)}
                  />
                  <datalist id="unassigned-section-suggestions">
                    {SECTION_SUGGESTIONS.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </label>
                <label className="text-sm">
                  <span className="label-text">Paid with</span>
                  <PaidWithSelect
                    cards={cardsQuery.data ?? []}
                    paymentMethod={editPaymentMethod}
                    cardLast4={editCardLast4}
                    onChange={(next) => {
                      setEditPaymentMethod(next.payment_method);
                      setEditCardLast4(next.card_last4);
                    }}
                  />
                </label>
              </>
            ) : null}
            <label className="text-sm sm:col-span-2">
              <span className="label-text">Notes</span>
              <input
                type="text"
                className="field"
                value={editNotes}
                onChange={(event) => setEditNotes(event.target.value)}
              />
            </label>
            <div className="sm:col-span-2">
              <TransactionAttachmentsField
                kind={editing.kind}
                transactionId={editing.id}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(false)}
            >
              {saveMutation.isPending && saveMutation.variables === false
                ? 'Saving…'
                : 'Save'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={saveMutation.isPending || !canAssign}
              onClick={() => saveMutation.mutate(true)}
            >
              {saveMutation.isPending && saveMutation.variables === true
                ? 'Assigning…'
                : 'Assign owner & property'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={saveMutation.isPending}
              onClick={() => setEditing(null)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      <section className="panel overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState message="Nothing is sitting on Needs assignment." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <p className="text-sm">
                <span className="font-medium tabular-nums">{rows.length}</span>
                <span className="muted-text"> to assign</span>
              </p>
              <Link to="/verification" className="btn-secondary text-xs">
                Open Verification
              </Link>
            </div>
            <TransactionTable
              rows={rows}
              emptyMessage="Nothing is sitting on Needs assignment."
              showBalance={false}
              className="overflow-x-auto"
              actionsColWidth="w-[12%]"
              renderActions={(row) => (
                <button
                  type="button"
                  className="btn-primary text-xs"
                  onClick={() => openAssign(row)}
                >
                  Edit
                </button>
              )}
            />
          </>
        )}
      </section>
    </div>
  );
}
