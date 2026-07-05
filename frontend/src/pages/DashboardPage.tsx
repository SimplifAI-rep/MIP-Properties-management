import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, ErrorState, formatCurrency, LoadingState } from '../components/ui/States';

export function DashboardPage() {
  const summaryQuery = useQuery({
    queryKey: ['deposit-summary'],
    queryFn: api.getDepositSummary,
  });
  const gapsQuery = useQuery({
    queryKey: ['deposit-gaps', 2026, 3],
    queryFn: () => api.getDepositGaps(2026, 3),
  });

  if (summaryQuery.isLoading) return <LoadingState />;
  if (summaryQuery.isError) {
    return (
      <ErrorState message="Could not load dashboard. Make sure the API server is running on port 8000." />
    );
  }

  const summary = summaryQuery.data!;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Dashboard</h2>
        <p className="mt-1 text-sm text-slate-500">
          Overview of property deposits and expected income gaps.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card
          title="Total Deposits"
          value={formatCurrency(summary.total_amount)}
          subtitle="All imported deposits"
        />
        <Card title="Deposit Count" value={summary.deposit_count} />
        <Card title="Properties" value={summary.property_count} />
        <Card
          title="Missing This Month"
          value={summary.missing_deposit_count}
          subtitle="Expected deposits not found"
        />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4">
          <h3 className="font-semibold text-slate-900">Missing Expected Deposits — March 2026</h3>
          <p className="text-sm text-slate-500">
            Properties where the expected monthly deposit was not received.
          </p>
        </div>
        {gapsQuery.isLoading ? (
          <div className="p-5">
            <LoadingState label="Checking gaps..." />
          </div>
        ) : gapsQuery.data && gapsQuery.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Property</th>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Expected</th>
                  <th className="px-5 py-3 font-medium">Due Day</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {gapsQuery.data.map((gap) => (
                  <tr key={gap.property_id} className="border-t border-slate-100">
                    <td className="px-5 py-3 font-medium">{gap.property_name}</td>
                    <td className="px-5 py-3">{gap.owner_name}</td>
                    <td className="px-5 py-3">{formatCurrency(gap.expected_amount)}</td>
                    <td className="px-5 py-3">{gap.due_day}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                        {gap.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5 text-sm text-slate-500">No missing deposits for March 2026.</div>
        )}
      </section>
    </div>
  );
}
