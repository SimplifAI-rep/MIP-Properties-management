import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { PeriodBalanceCheck } from '../components/PeriodBalanceCheck';
import { VerificationWorkspace } from '../components/VerificationWorkspace';
import { Card, formatCurrency, formatDate } from '../components/ui/States';

export function VerificationPage() {
  const settingsQuery = useQuery({
    queryKey: ['bank-settings'],
    queryFn: () => api.getBankSettings(),
  });

  const workspaceQuery = useQuery({
    queryKey: ['verification-workspace'],
    queryFn: () => api.getVerificationWorkspace(),
  });

  const settings = settingsQuery.data;
  const workspace = workspaceQuery.data;
  const lastFinished = workspace?.bank_groups.find((group) => group.status === 'verified');
  const lastClosing = lastFinished?.bank_balance ?? null;
  const openingSet = settings?.opening_balance != null;
  const bankBalance = lastClosing
    ? formatCurrency(lastClosing)
    : openingSet
      ? formatCurrency(settings!.opening_balance!)
      : 'Not set';
  const closingDate = lastFinished?.date || lastFinished?.statement_end_date;
  const bankBalanceSubtitle = lastClosing
    ? closingDate
      ? `Closing · ${formatDate(closingDate)}`
      : 'Closing of last finished period'
    : openingSet
      ? 'Opening — no period finished yet'
      : 'Ask an admin to set it';
  const bankBalanceTooltip = lastClosing
    ? 'Last statement closing balance, after the most recent finished period.'
    : 'Opening balance the verification starts from.';
  const checkedThrough = settings?.last_verification_date
    ? formatDate(settings.last_verification_date)
    : '—';
  const stillToCheck =
    (settings?.unverified_count ?? 0) + (workspace?.cc_pool.pending_count ?? 0);

  let lastPeriodLabel = '—';
  if (lastFinished) {
    const start = lastFinished.statement_start_date;
    const end = lastFinished.date || lastFinished.statement_end_date;
    if (start && end) lastPeriodLabel = `${formatDate(start)} → ${formatDate(end)}`;
    else if (end) lastPeriodLabel = formatDate(end);
    else if (start) lastPeriodLabel = formatDate(start);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="page-heading">Verification</h2>
        <p className="page-desc mt-1">
          Upload a statement, check the lists, then finish the period.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card
          title="Bank balance"
          value={bankBalance}
          subtitle={bankBalanceSubtitle}
          tooltip={bankBalanceTooltip}
        />
        <Card
          title="Checked through"
          value={checkedThrough}
          subtitle="End of the last finished period"
          tooltip="Statements are checked forward from this date."
        />
        <Card
          title="Still to check"
          value={stillToCheck}
          subtitle={stillToCheck === 0 ? 'All caught up' : 'Transactions waiting'}
          tooltip="App transactions not yet confirmed against a statement."
        />
      </div>

      {lastFinished ? (
        <PeriodBalanceCheck
          title="Last finished period"
          subtitle={lastPeriodLabel}
          check={{
            openingBalance: lastFinished.opening_balance,
            bankBalance: lastFinished.bank_balance,
            verifiedNet: lastFinished.verified_net,
            gapVerified: lastFinished.gap_verified,
            withinTolerance: lastFinished.within_tolerance,
            bankIn: lastFinished.bank_in,
            bankOut: lastFinished.bank_out,
            appIn: lastFinished.money_in,
            appOut: lastFinished.money_out,
          }}
        />
      ) : null}

      <VerificationWorkspace />
    </div>
  );
}
