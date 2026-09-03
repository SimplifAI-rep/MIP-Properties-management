import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { VerificationWorkspace } from '../components/VerificationWorkspace';
import { formatDate } from '../components/ui/States';

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
  const bankThrough = settings?.last_verification_date
    ? formatDate(settings.last_verification_date)
    : '—';
  const cardThrough = workspace?.last_cc_verification_date
    ? formatDate(workspace.last_cc_verification_date)
    : '—';
  const pendingBank = settings?.unverified_count ?? 0;
  const pendingCard = workspace?.cc_pool.pending_count ?? 0;
  const pendingTotal = pendingBank + pendingCard;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="page-heading">Verification</h2>
        <p className="page-desc mt-1">
          Upload a statement, confirm matching transactions, then complete the period.
        </p>
      </div>

      <p className="text-sm muted-text">
        Bank through {bankThrough}
        {' · '}
        Card through {cardThrough}
        {' · '}
        {pendingTotal} pending
      </p>

      <VerificationWorkspace />
    </div>
  );
}
