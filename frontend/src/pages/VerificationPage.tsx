import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { VerificationWorkspace } from '../components/VerificationWorkspace';
import { formatCurrency, formatDate } from '../components/ui/States';

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
  const bankBalance =
    settings?.opening_balance != null ? formatCurrency(settings.opening_balance) : 'Not set';
  const checkedThrough = settings?.last_verification_date
    ? formatDate(settings.last_verification_date)
    : '—';
  const stillToCheck =
    (settings?.unverified_count ?? 0) + (workspace?.cc_pool.pending_count ?? 0);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="page-heading">Verification</h2>
        <p className="page-desc mt-1">
          Upload a statement, check the lists, then finish the period.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-700">
        <div>
          <p className="label-text">Bank balance</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{bankBalance}</p>
        </div>
        <div>
          <p className="label-text">Checked through</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{checkedThrough}</p>
        </div>
        <div>
          <p className="label-text">Still to check</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{stillToCheck}</p>
        </div>
      </div>

      <VerificationWorkspace />
    </div>
  );
}
