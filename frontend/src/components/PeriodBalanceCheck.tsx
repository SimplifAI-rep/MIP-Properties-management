import { MoneyValue } from './ui/MoneyValue';
import { formatCurrency } from './ui/States';

/**
 * closing − opening should equal the app’s verified net for the period.
 * The backend already computes gap_verified = closing − (opening + app_net).
 */

export type BalanceCheck = {
  openingBalance: string | null | undefined;
  bankBalance: string | null | undefined;
  verifiedNet: string | null | undefined;
  gapVerified: string | null | undefined;
  withinTolerance: boolean | null | undefined;
  bankIn?: string | number | null;
  bankOut?: string | number | null;
  appIn?: string | number | null;
  appOut?: string | number | null;
};

export type BalanceState = 'match' | 'mismatch' | 'incomplete';

export function balanceMismatchCopy(
  gap: string | number | null | undefined,
): string {
  const n = Number(gap ?? 0);
  if (!Number.isFinite(n) || n === 0) {
    return 'the app and the bank do not add up';
  }
  const amount = formatCurrency(Math.abs(n));
  return n > 0
    ? `${amount} more in the bank than in the app`
    : `${amount} more in the app than in the bank`;
}

/** Finish is blocked until identity is ₪0. */
export function finishGapCopy(
  gap: string | number | null | undefined,
): string {
  const n = Number(gap ?? 0);
  const amount = formatCurrency(Number.isFinite(n) ? Math.abs(n) : 0);
  return `Period is off by ${amount} — create a transaction for that amount`;
}

export function gapExceedsFinishTolerance(
  gap: string | number | null | undefined,
): boolean {
  if (gap == null || gap === '') return false;
  const n = Number(gap);
  return Number.isFinite(n) && Math.abs(n) > 0.01;
}

function asOutflow(amount: string | number | null | undefined): number | null {
  if (amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return 0;
  return -Math.abs(n);
}

function netOf(
  incoming: string | number | null | undefined,
  outgoing: string | number | null | undefined,
): number | null {
  if (incoming == null && outgoing == null) return null;
  return Number(incoming ?? 0) - Number(outgoing ?? 0);
}

function periodBalanceState(check: BalanceCheck): BalanceState {
  const bankNet = netOf(check.bankIn, check.bankOut);
  const appNet =
    netOf(check.appIn, check.appOut) ??
    (check.verifiedNet != null ? Number(check.verifiedNet) : null);
  const netsKnown = bankNet != null && appNet != null;
  const netsMatch =
    bankNet != null && appNet != null && Math.abs(bankNet - appNet) <= 0.01;

  if (check.withinTolerance === true || netsMatch) return 'match';
  if (check.withinTolerance === false || (netsKnown && !netsMatch)) return 'mismatch';
  if (check.openingBalance == null || check.bankBalance == null) return 'incomplete';
  return 'incomplete';
}

export { periodBalanceState };

function Stat({
  label,
  amount,
  signed = true,
  missing,
}: {
  label: string;
  amount: string | number | null | undefined;
  signed?: boolean;
  missing?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs muted-text">{label}</p>
      {amount == null ? (
        <p className="text-sm muted-text">{missing ?? '—'}</p>
      ) : (
        <p className="truncate text-sm font-medium tabular-nums">
          <MoneyValue amount={amount} signed={signed} />
        </p>
      )}
    </div>
  );
}

export function PeriodBalanceBadge({ check }: { check: BalanceCheck }) {
  const state = periodBalanceState(check);
  if (state === 'match') {
    return <span className="badge-deposit">Totals match</span>;
  }
  if (state === 'mismatch') {
    return (
      <span className="badge-warning">
        Totals off
        {check.gapVerified != null ? ` · ${formatCurrency(check.gapVerified)}` : ''}
      </span>
    );
  }
  return <span className="badge-neutral">Balance not set</span>;
}

export function PeriodBalanceCheck({
  check,
  title,
  subtitle,
}: {
  check: BalanceCheck;
  title?: string;
  subtitle?: string;
}) {
  const state = periodBalanceState(check);
  const opening = check.openingBalance ?? null;
  const closing = check.bankBalance ?? null;
  const bankIn = check.bankIn ?? null;
  const bankOut = check.bankOut ?? null;
  const bankNet = netOf(bankIn, bankOut);
  const appIn = check.appIn ?? null;
  const appOut = check.appOut ?? null;
  const appNet =
    netOf(appIn, appOut) ??
    (check.verifiedNet != null ? Number(check.verifiedNet) : null);

  const frame =
    state === 'match'
      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700/60 dark:bg-emerald-950/30'
      : state === 'mismatch'
        ? 'border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/30'
        : 'border-slate-200 dark:border-slate-700';

  const status =
    state === 'match'
      ? 'Totals match'
      : state === 'mismatch'
        ? `Off — ${balanceMismatchCopy(check.gapVerified)}`
        : opening == null
          ? 'Opening not set'
          : 'Closing not set';

  const statusTone =
    state === 'match'
      ? 'text-emerald-800 dark:text-emerald-200'
      : state === 'mismatch'
        ? 'text-amber-800 dark:text-amber-200'
        : 'muted-text';

  return (
    <div className={`space-y-2 rounded-lg border p-3 ${frame}`}>
      {title ? (
        <div>
          <p className="text-sm font-medium">{title}</p>
          {subtitle ? <p className="text-xs muted-text">{subtitle}</p> : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
        <Stat label="Opening" amount={opening} signed={false} missing="Not set" />
        <Stat label="Closing" amount={closing} signed={false} missing="Not set" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Bank in" amount={bankIn} signed={false} />
        <Stat label="Bank out" amount={asOutflow(bankOut)} />
        <Stat label="Bank net" amount={bankNet} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="App in" amount={appIn} signed={false} />
        <Stat label="App out" amount={asOutflow(appOut)} />
        <Stat label="App net" amount={appNet} />
      </div>
      <p className={`text-sm ${statusTone}`}>
        Opening + In the app = Closing
        <span className="mx-1.5 muted-text">·</span>
        {status}
      </p>
    </div>
  );
}
