import type { CreditCard } from '../../types';
import { PAYMENT_METHODS } from '../../constants/expenseOptions';
import { formatLabel } from '../../utils/formatLabel';

export function PaidWithSelect({
  cards,
  paymentMethod,
  cardLast4,
  onChange,
  showCardOption = true,
}: {
  cards: CreditCard[];
  paymentMethod: string;
  cardLast4?: string | null;
  onChange: (next: { payment_method: string; card_last4: string | null }) => void;
  showCardOption?: boolean;
}) {
  const activeCards = cards.filter((card) => card.is_active);
  const methodValue =
    paymentMethod === 'credit_card' && showCardOption
      ? 'credit_card'
      : paymentMethod || 'company_account';
  const extraMethods = PAYMENT_METHODS.filter(
    (method) => method !== 'cash' && method !== 'credit_card' && method !== 'company_account',
  );
  const knownCard =
    Boolean(cardLast4) &&
    (activeCards.some((card) => card.card_last4 === cardLast4) ||
      Boolean(cardLast4 && !activeCards.some((card) => card.card_last4 === cardLast4)));

  return (
    <div className="space-y-2">
      <select
        className="field"
        value={methodValue}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'credit_card') {
            const keep = knownCard ? cardLast4 ?? null : null;
            onChange({
              payment_method: 'credit_card',
              card_last4:
                keep ?? (activeCards.length === 1 ? activeCards[0].card_last4 : null),
            });
            return;
          }
          onChange({ payment_method: next, card_last4: null });
        }}
      >
        <option value="company_account">{formatLabel('company_account')}</option>
        <option value="cash">Cash</option>
        {showCardOption ? <option value="credit_card">Credit card</option> : null}
        {extraMethods.map((method) => (
          <option key={method} value={method}>
            {formatLabel(method)}
          </option>
        ))}
      </select>
      {showCardOption && paymentMethod === 'credit_card' ? (
        <select
          className="field"
          required
          aria-label="Select a card"
          value={cardLast4 ?? ''}
          onChange={(event) =>
            onChange({
              payment_method: 'credit_card',
              card_last4: event.target.value || null,
            })
          }
        >
          <option value="">Select a card</option>
          {activeCards.map((card) => (
            <option key={card.id} value={card.card_last4}>
              {card.label}
            </option>
          ))}
          {cardLast4 && !activeCards.some((card) => card.card_last4 === cardLast4) ? (
            <option value={cardLast4}>Card ••{cardLast4}</option>
          ) : null}
        </select>
      ) : null}
    </div>
  );
}
