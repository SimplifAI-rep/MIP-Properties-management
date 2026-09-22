import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { TransactionTable } from '../components/TransactionTable';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import { getUserErrorMessage } from '../utils/errors';
import { recordToUnified } from '../utils/unifiedTransaction';
import type { CreditCard } from '../types';

function statusBadgeClass(active: boolean) {
  return active ? 'badge-deposit' : 'badge-neutral';
}

export function CreditCardsPage() {
  const queryClient = useQueryClient();
  const [last4, setLast4] = useState('');
  const [label, setLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [expandedLast4, setExpandedLast4] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cardsQuery = useQuery({
    queryKey: ['credit-cards'],
    queryFn: api.getCreditCards,
  });

  const createMutation = useMutation({
    mutationFn: api.createCreditCard,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['credit-cards'] });
      void queryClient.invalidateQueries({ queryKey: ['verification-workspace'] });
      setLast4('');
      setLabel('');
      setMessage(`Added card ••${created.card_last4}.`);
      setError(null);
    },
    onError: (err) => {
      setError(getUserErrorMessage(err));
      setMessage(null);
    },
  });

  const cardTxQuery = useQuery({
    queryKey: ['credit-card-transactions', expandedLast4],
    queryFn: () =>
      api.getAllExpenses({
        card_last4: expandedLast4!,
        include_running_balance: false,
      }),
    enabled: Boolean(expandedLast4),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { is_active?: boolean; label?: string };
    }) => api.updateCreditCard(id, payload),
    onSuccess: (updated, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['credit-cards'] });
      void queryClient.invalidateQueries({ queryKey: ['verification-workspace'] });
      if (variables.payload.label != null) {
        setEditingId(null);
        setMessage(`Renamed card ••${updated.card_last4}.`);
      }
      setError(null);
    },
    onError: (err) => setError(getUserErrorMessage(err)),
  });

  function addCard() {
    const digits = last4.replace(/\D/g, '');
    if (digits.length < 4) {
      setError('Enter the last 4 digits of the card.');
      setMessage(null);
      return;
    }
    createMutation.mutate({
      card_last4: digits,
      label: label.trim() || undefined,
    });
  }

  function setActive(card: CreditCard, isActive: boolean) {
    if (card.is_active === isActive) return;
    updateMutation.mutate({ id: card.id, payload: { is_active: isActive } });
  }

  function startRename(card: CreditCard) {
    setEditingId(card.id);
    setDraftName(card.label);
    setError(null);
  }

  function cancelRename() {
    setEditingId(null);
    setDraftName('');
  }

  function saveRename(card: CreditCard) {
    const next = draftName.trim();
    if (!next || next === card.label) {
      cancelRename();
      return;
    }
    updateMutation.mutate({ id: card.id, payload: { label: next } });
  }

  if (cardsQuery.isLoading) return <LoadingState />;
  if (cardsQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load credit cards. Please try again in a moment."
        error={cardsQuery.error}
      />
    );
  }

  const cards = cardsQuery.data ?? [];
  const busy = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Credit cards</h2>
        <p className="page-desc">
          Add cards by hand, or they appear when you upload a new card statement on
          Verification. Turn a card inactive when you no longer use it.
        </p>
      </div>

      <section className="panel p-4 sm:p-5 space-y-3">
        <h3 className="section-title text-sm">Add a card</h3>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr_auto]">
          <label className="text-sm">
            <span className="label-text">Last 4 digits</span>
            <input
              className="field tabular-nums"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={last4}
              onChange={(event) => setLast4(event.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="1234"
            />
          </label>
          <label className="text-sm">
            <span className="label-text">
              <Tooltip content="Optional. Shown on Verification instead of Credit card ••1234.">
                Name
              </Tooltip>
            </span>
            <input
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Office Visa"
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={addCard}
            >
              {createMutation.isPending ? 'Adding…' : 'Add card'}
            </button>
          </div>
        </div>
        {message ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </section>

      <section className="panel overflow-hidden">
        {cards.length === 0 ? (
          <EmptyState message="No credit cards yet. Add a card here, or upload a card statement on Verification." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">Card</th>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr
                    key={card.id}
                    className={
                      card.is_active
                        ? 'border-t border-slate-100 dark:border-slate-800'
                        : 'border-t border-slate-100 opacity-70 dark:border-slate-800'
                    }
                  >
                    <td className="px-5 py-3 font-medium tabular-nums">
                      ••{card.card_last4}
                      {card.open_session_id ? (
                        <span className="ml-2 text-xs muted-text">In progress</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      {editingId === card.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className="field py-1 text-sm"
                            value={draftName}
                            autoFocus
                            aria-label={`Name for card ${card.card_last4}`}
                            onChange={(event) => setDraftName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') saveRename(card);
                              if (event.key === 'Escape') cancelRename();
                            }}
                          />
                          <button
                            type="button"
                            className="btn-primary text-xs"
                            disabled={busy}
                            onClick={() => saveRename(card)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            disabled={busy}
                            onClick={cancelRename}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{card.label}</span>
                          <button
                            type="button"
                            className="btn-secondary text-xs"
                            disabled={busy}
                            onClick={() => startRename(card)}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <label className="inline-flex items-center gap-2">
                        <span className={statusBadgeClass(card.is_active)}>
                          {card.is_active ? 'Active' : 'Inactive'}
                        </span>
                        <select
                          className="field w-auto py-1 text-xs"
                          value={card.is_active ? 'active' : 'inactive'}
                          disabled={busy}
                          aria-label={`Status for card ${card.card_last4}`}
                          onChange={(event) =>
                            setActive(card, event.target.value === 'active')
                          }
                        >
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </label>
                    </td>
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        aria-expanded={expandedLast4 === card.card_last4}
                        onClick={() =>
                          setExpandedLast4((current) =>
                            current === card.card_last4 ? null : card.card_last4,
                          )
                        }
                      >
                        {expandedLast4 === card.card_last4
                          ? 'Hide transactions'
                          : 'View transactions'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {expandedLast4 ? (
        <section className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <h3 className="section-title text-sm">
              Transactions on ••{expandedLast4}
            </h3>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setExpandedLast4(null)}
            >
              Close
            </button>
          </div>
          {cardTxQuery.isLoading ? (
            <LoadingState />
          ) : cardTxQuery.isError ? (
            <ErrorState
              message="We couldn't load this card's transactions."
              error={cardTxQuery.error}
            />
          ) : (
            <TransactionTable
              rows={(cardTxQuery.data?.items ?? []).map((row) =>
                recordToUnified(row as unknown as Record<string, unknown>, 'expense'),
              )}
              emptyMessage="No transactions linked to this card."
              showBalance={false}
              className="overflow-x-auto"
            />
          )}
        </section>
      ) : null}
    </div>
  );
}
