import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Deposit, Expense } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';

const RECENT_LIMIT = 10;

interface RecentItem {
  id: string;
  kind: 'deposit' | 'expense';
  transaction_date: string;
  property_name: string;
  owner_name: string;
  amount: string;
  label: string;
}

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function currentPeriod() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    label: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  };
}

function depositToRecent(deposit: Deposit): RecentItem {
  return {
    id: deposit.id,
    kind: 'deposit',
    transaction_date: deposit.transaction_date,
    property_name: deposit.property_name,
    owner_name: deposit.owner_name,
    amount: deposit.amount,
    label: deposit.description ?? deposit.account_number,
  };
}

function expenseToRecent(expense: Expense): RecentItem {
  return {
    id: expense.id,
    kind: 'expense',
    transaction_date: expense.transaction_date,
    property_name: expense.property_name,
    owner_name: expense.owner_name,
    amount: expense.amount,
    label: expense.vendor_name
      ? `${expense.vendor_name} · ${label(expense.category)}`
      : label(expense.category),
  };
}

function severityBadge(severity: string) {
  if (severity === 'error') return 'badge-expense';
  if (severity === 'warning') return 'badge-warning';
  return 'badge-neutral';
}

export function DashboardPage() {
  const period = currentPeriod();

  const depositSummaryQuery = useQuery({
    queryKey: ['deposit-summary'],
    queryFn: api.getDepositSummary,
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary'],
    queryFn: api.getExpenseSummary,
  });
  const alertSummaryQuery = useQuery({
    queryKey: ['alert-summary'],
    queryFn: api.getAlertSummary,
  });
  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: api.getAlerts,
  });
  const gapsQuery = useQuery({
    queryKey: ['deposit-gaps', period.year, period.month],
    queryFn: () => api.getDepositGaps(period.year, period.month),
  });
  const ownersQuery = useQuery({
    queryKey: ['owners'],
    queryFn: api.getOwners,
  });
  const depositsQuery = useQuery({
    queryKey: ['dashboard-recent-deposits'],
    queryFn: () => api.getDeposits({ page: 1, page_size: RECENT_LIMIT }),
  });
  const expensesQuery = useQuery({
    queryKey: ['dashboard-recent-expenses'],
    queryFn: () => api.getExpenses({ page: 1, page_size: RECENT_LIMIT }),
  });

  const recentActivity = useMemo(() => {
    const deposits = (depositsQuery.data?.items ?? []).map(depositToRecent);
    const expenses = (expensesQuery.data?.items ?? []).map(expenseToRecent);
    return [...deposits, ...expenses]
      .sort(
        (a, b) =>
          new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime(),
      )
      .slice(0, RECENT_LIMIT);
  }, [depositsQuery.data, expensesQuery.data]);

  const topAlerts = alertsQuery.data?.items.slice(0, 5) ?? [];
  const expenseCategories = expenseSummaryQuery.data?.by_category ?? [];
  const maxCategoryTotal = Math.max(
    ...expenseCategories.map((item) => Number(item.total_amount)),
    1,
  );

  if (depositSummaryQuery.isLoading || expenseSummaryQuery.isLoading) {
    return <LoadingState label="Loading dashboard..." />;
  }

  if (depositSummaryQuery.isError || expenseSummaryQuery.isError) {
    return (
      <ErrorState message="Could not load dashboard. Make sure the API server is running on port 8000." />
    );
  }

  const depositTotal = Number(depositSummaryQuery.data!.total_amount);
  const expenseTotal = Number(expenseSummaryQuery.data!.total_amount);
  const netTotal = depositTotal - expenseTotal;
  const totalTransactions =
    depositSummaryQuery.data!.deposit_count + expenseSummaryQuery.data!.expense_count;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-heading">Dashboard</h2>
        <p className="page-desc">
          Portfolio overview for {period.label} — deposits, expenses, alerts, and recent activity.
        </p>
      </div>

      {/* 1. Financial snapshot */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Card
          title="Total deposits"
          value={formatCurrency(depositTotal)}
          subtitle={`${depositSummaryQuery.data!.deposit_count} transactions`}
        />
        <Card
          title="Total expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseSummaryQuery.data!.expense_count} transactions`}
        />
        <Card
          title="Net position"
          value={formatCurrency(netTotal)}
          subtitle="Deposits minus expenses"
        />
        <Card
          title="Transactions"
          value={totalTransactions}
          subtitle={`${depositSummaryQuery.data!.property_count} properties with deposits`}
        />
        <Card
          title="Open alerts"
          value={alertSummaryQuery.data?.open_count ?? '—'}
          subtitle={
            alertSummaryQuery.data
              ? `${alertSummaryQuery.data.error_count} errors · ${alertSummaryQuery.data.warning_count} warnings`
              : 'Loading...'
          }
        />
        <Card
          title="Missing this month"
          value={gapsQuery.data?.length ?? depositSummaryQuery.data!.missing_deposit_count}
          subtitle="Expected deposits not received"
        />
      </section>

      {/* 2. Alerts + 4. Expense breakdown */}
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="panel">
          <div className="section-header flex items-start justify-between gap-3">
            <div>
              <h3 className="section-title">Alerts at a glance</h3>
              <p className="section-subtitle">Items that need your attention.</p>
            </div>
            <Link to="/alerts" className="btn-secondary text-sm">
              View all
            </Link>
          </div>
          {alertsQuery.isLoading ? (
            <div className="p-5">
              <LoadingState label="Loading alerts..." />
            </div>
          ) : topAlerts.length > 0 ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {topAlerts.map((alert) => (
                <li key={alert.id}>
                  <Link
                    to="/alerts"
                    className="block px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{alert.title}</p>
                        <p className="mt-1 text-xs text-muted">{alert.message}</p>
                        <p className="mt-1 text-xs text-muted">
                          {alert.property_name} · {alert.owner_name}
                        </p>
                      </div>
                      <span className={severityBadge(alert.severity)}>{alert.severity}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-5">
              <EmptyState message="No open alerts." />
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-header">
            <h3 className="section-title">Expense breakdown</h3>
            <p className="section-subtitle">Totals by category across all properties.</p>
          </div>
          {expenseSummaryQuery.isLoading ? (
            <div className="p-5">
              <LoadingState label="Loading expenses..." />
            </div>
          ) : expenseCategories.length > 0 ? (
            <ul className="space-y-4 p-5">
              {expenseCategories
                .slice()
                .sort((a, b) => Number(b.total_amount) - Number(a.total_amount))
                .map((item) => {
                  const width = Math.round((Number(item.total_amount) / maxCategoryTotal) * 100);
                  return (
                    <li key={item.category}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium capitalize">{label(item.category)}</span>
                        <span>
                          {formatCurrency(item.total_amount)}
                          <span className="ml-2 text-xs text-muted">({item.expense_count})</span>
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className="h-full rounded-full bg-rose-500 dark:bg-rose-600"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <div className="p-5">
              <EmptyState message="No expenses recorded yet." />
            </div>
          )}
        </section>
      </div>

      {/* 3. Current month gaps */}
      <section className="panel">
        <div className="section-header">
          <h3 className="section-title">Missing expected deposits — {period.label}</h3>
          <p className="section-subtitle">
            Properties where the expected monthly deposit was not received.
          </p>
        </div>
        {gapsQuery.isLoading ? (
          <div className="p-5">
            <LoadingState label="Checking gaps..." />
          </div>
        ) : gapsQuery.data && gapsQuery.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">Property</th>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Expected</th>
                  <th className="px-5 py-3 font-medium">Due day</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {gapsQuery.data.map((gap) => (
                  <tr key={gap.property_id} className="table-row">
                    <td className="px-5 py-3 font-medium">{gap.property_name}</td>
                    <td className="px-5 py-3">{gap.owner_name}</td>
                    <td className="px-5 py-3">{formatCurrency(gap.expected_amount)}</td>
                    <td className="px-5 py-3">{gap.due_day}</td>
                    <td className="px-5 py-3">
                      <span className="badge-warning">{gap.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5 muted-text">No missing deposits for {period.label}.</div>
        )}
      </section>

      {/* 5. Owner overview */}
      <section className="panel">
        <div className="section-header flex items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Owner overview</h3>
            <p className="section-subtitle">Deposits, expenses, and net position per owner.</p>
          </div>
          <Link to="/owners" className="btn-secondary text-sm">
            View owners
          </Link>
        </div>
        {ownersQuery.isLoading ? (
          <div className="p-5">
            <LoadingState label="Loading owners..." />
          </div>
        ) : ownersQuery.data && ownersQuery.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Properties</th>
                  <th className="px-5 py-3 font-medium">Deposits</th>
                  <th className="px-5 py-3 font-medium">Expenses</th>
                  <th className="px-5 py-3 font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {ownersQuery.data.map((owner) => {
                  const net = Number(owner.total_deposits) - Number(owner.total_expenses);
                  return (
                    <tr key={owner.id} className="table-row">
                      <td className="px-5 py-3 font-medium">{owner.name}</td>
                      <td className="px-5 py-3">{owner.property_count}</td>
                      <td className="px-5 py-3">
                        <span className="amount-deposit">{formatCurrency(owner.total_deposits)}</span>
                        <span className="ml-1 text-xs text-muted">({owner.deposit_count})</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="amount-expense">{formatCurrency(owner.total_expenses)}</span>
                        <span className="ml-1 text-xs text-muted">({owner.expense_count})</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={net >= 0 ? 'amount-deposit' : 'amount-expense'}>
                          {formatCurrency(net)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5">
            <EmptyState message="No owners found." />
          </div>
        )}
      </section>

      {/* 6. Recent activity */}
      <section className="panel">
        <div className="section-header flex items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Recent activity</h3>
            <p className="section-subtitle">Latest deposits and expenses across the portfolio.</p>
          </div>
          <Link to="/transactions" className="btn-secondary text-sm">
            View all
          </Link>
        </div>
        {depositsQuery.isLoading || expensesQuery.isLoading ? (
          <div className="p-5">
            <LoadingState label="Loading activity..." />
          </div>
        ) : recentActivity.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table-shell">
              <thead className="table-head">
                <tr>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Property</th>
                  <th className="px-5 py-3 font-medium">Owner</th>
                  <th className="px-5 py-3 font-medium">Details</th>
                  <th className="px-5 py-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((item) => (
                  <tr
                    key={`${item.kind}-${item.id}`}
                    className={item.kind === 'deposit' ? 'row-deposit' : 'row-expense'}
                  >
                    <td className="px-5 py-3">
                      <span className={item.kind === 'deposit' ? 'badge-deposit' : 'badge-expense'}>
                        {item.kind}
                      </span>
                    </td>
                    <td className="px-5 py-3">{formatDate(item.transaction_date)}</td>
                    <td className="px-5 py-3 font-medium">{item.property_name}</td>
                    <td className="px-5 py-3">{item.owner_name}</td>
                    <td className="px-5 py-3 text-muted">{item.label}</td>
                    <td className="px-5 py-3">
                      <span className={item.kind === 'deposit' ? 'amount-deposit' : 'amount-expense'}>
                        {item.kind === 'deposit' ? '+' : '−'}
                        {formatCurrency(item.amount)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5">
            <EmptyState message="No transactions yet." />
          </div>
        )}
      </section>
    </div>
  );
}
