import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
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
  const openingSet = settings?.opening_balance != null;
  const bankBalance = openingSet ? formatCurrency(settings!.opening_balance!) : 'Not set';
  const checkedThrough = settings?.last_verification_date
    ? formatDate(settings.last_verification_date)
    : '—';
  const stillToCheck =
    (settings?.unverified_count ?? 0) + (workspace?.cc_pool.pending_count ?? 0);

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
          subtitle={openingSet ? 'Opening balance' : 'Ask an admin to set it'}
          tooltip="Opening balance the verification starts from."
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

      <VerificationWorkspace />
    </div>
  );
}
