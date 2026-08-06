import { formatCurrency } from './States';

type MoneyValueProps = {
  amount: string | number | null | undefined;
  currency?: string;
  className?: string;
  /** When true, color by sign (positive deposit / negative expense). Default true. */
  signed?: boolean;
};

export function MoneyValue({
  amount,
  currency = 'ILS',
  className = '',
  signed = true,
}: MoneyValueProps) {
  const numeric = Number(amount ?? 0);
  const tone = !signed
    ? ''
    : numeric >= 0
      ? 'amount-deposit'
      : 'amount-expense';
  return (
    <span className={`${tone} ${className}`.trim()}>
      {formatCurrency(amount ?? 0, currency)}
    </span>
  );
}
