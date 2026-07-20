import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Deposit, DepositGap, Expense, Property } from '../types';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';
import { Tooltip } from '../components/ui/Tooltip';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';
import {
  buildDashboardPeriod,
  defaultDashboardPeriod,
  monthsInPeriod,
  periodOptions,
  type DashboardPeriod,
  type PeriodType,
} from '../utils/dashboardPeriod';

const RECENT_LIMIT = 10;
const FETCH_SIZE = 200;

interface RecentItem {
  id: string;
  kind: 'deposit' | 'expense';
  transaction_date: string;
  property_id: string;
  client_prop_id: string;
  property_name: string;
  owner_id?: string;
  owner_name: string;
  amount: string;
  label: string;
}

interface PropertyHealth {
  property: Property;
  depositTotal: number;
  expenseTotal: number;
  net: number;
  depositStatus: 'ok' | 'missing' | 'partial';
  gapCount: number;
}

interface OwnerPeriodRow {
  ownerId: string;
  ownerName: string;
  propertyCount: number;
  depositTotal: number;
  expenseTotal: number;
  depositCount: number;
  expenseCount: number;
}

function label(value: string) {
  return value.replace(/_/g, ' ');
}

function depositToRecent(deposit: Deposit): RecentItem {
  return {
    id: deposit.id,
    kind: 'deposit',
    transaction_date: deposit.transaction_date,
    property_id: deposit.property_id,
    client_prop_id: deposit.client_prop_id,
    property_name: deposit.property_name,
    owner_name: deposit.owner_name,
    amount: deposit.amount,
    label: deposit.description ?? deposit.account_number ?? 'Deposit',
  };
}

function expenseToRecent(expense: Expense): RecentItem {
  return {
    id: expense.id,
    kind: 'expense',
    transaction_date: expense.transaction_date,
    property_id: expense.property_id,
    client_prop_id: expense.client_prop_id,
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

function depositStatusBadge(status: PropertyHealth['depositStatus']) {
  if (status === 'ok') return 'badge-deposit';
  if (status === 'missing') return 'badge-expense';
  return 'badge-warning';
}

function depositStatusLabel(status: PropertyHealth['depositStatus']) {
  if (status === 'ok') return 'On track';
  if (status === 'missing') return 'Missing';
  return 'Partial';
}

async function fetchPeriodGaps(period: DashboardPeriod): Promise<DepositGap[]> {
  const monthQueries = monthsInPeriod(period);
  const results = await Promise.all(
    monthQueries.map(({ year, month }) => api.getDepositGaps({ year, month })),
  );
  const seen = new Set<string>();
  return results.flat().filter((gap) => {
    const key = `${gap.property_id}:${gap.period_start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function DashboardPage() {
  const navigate = useNavigate();
  const defaults = defaultDashboardPeriod();
  const { months } = periodOptions();

  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [year, setYear] = useState(defaults.year);
  const [month, setMonth] = useState(defaults.month);

  const yearsQuery = useQuery({
    queryKey: ['transaction-years'],
    queryFn: api.getTransactionYears,
  });
  const years = useMemo(
    () => periodOptions(yearsQuery.data?.years).years,
    [yearsQuery.data?.years],
  );

  useEffect(() => {
    if (years.length === 0) return;
    if (!years.includes(year)) {
      setYear(years[0]);
    }
  }, [years, year]);

  const period = useMemo(
    () => buildDashboardPeriod(periodType, year, month),
    [periodType, year, month],
  );
  const monthsCount = monthsInPeriod(period).length;

  const depositSummaryQuery = useQuery({
    queryKey: ['deposit-summary', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getDepositSummary({ date_from: period.dateFrom, date_to: period.dateTo }),
  });
  const expenseSummaryQuery = useQuery({
    queryKey: ['expense-summary', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getExpenseSummary({ date_from: period.dateFrom, date_to: period.dateTo }),
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
    queryKey: ['deposit-gaps', period],
    queryFn: () => fetchPeriodGaps(period),
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const periodDepositsQuery = useQuery({
    queryKey: ['dashboard-period-deposits', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getDeposits({
        date_from: period.dateFrom,
        date_to: period.dateTo,
        page: 1,
        page_size: FETCH_SIZE,
      }),
  });
  const periodExpensesQuery = useQuery({
    queryKey: ['dashboard-period-expenses', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getExpenses({
        date_from: period.dateFrom,
        date_to: period.dateTo,
        page: 1,
        page_size: FETCH_SIZE,
      }),
  });

  const topAlerts = alertsQuery.data?.items.slice(0, 5) ?? [];
  const pendingUploads =
    alertsQuery.data?.items.filter((alert) =>
      ['upload_pending', 'duplicate_deposit'].includes(alert.alert_type),
    ) ?? [];

  const expenseCategories = expenseSummaryQuery.data?.by_category ?? [];
  const maxCategoryTotal = Math.max(
    ...expenseCategories.map((item) => Number(item.total_amount)),
    1,
  );

  const propertyHealth = useMemo(() => {
    const properties = propertiesQuery.data ?? [];
    const deposits = periodDepositsQuery.data?.items ?? [];
    const expenses = periodExpensesQuery.data?.items ?? [];
    const gaps = gapsQuery.data ?? [];

    const gapCountByProperty = new Map<string, number>();
    gaps.forEach((gap) => {
      gapCountByProperty.set(
        gap.property_id,
        (gapCountByProperty.get(gap.property_id) ?? 0) + 1,
      );
    });

    return properties
      .map((property): PropertyHealth => {
        const propertyDeposits = deposits.filter(
          (deposit) => deposit.property_id === property.id,
        );
        const propertyExpenses = expenses.filter(
          (expense) => expense.property_id === property.id,
        );
        const depositTotal = propertyDeposits.reduce(
          (sum, item) => sum + Number(item.amount),
          0,
        );
        const expenseTotal = propertyExpenses.reduce(
          (sum, item) => sum + Number(item.amount),
          0,
        );
        const gapCount = gapCountByProperty.get(property.id) ?? 0;
        let depositStatus: PropertyHealth['depositStatus'] = 'ok';
        if (gapCount > 0 && gapCount >= monthsCount) depositStatus = 'missing';
        else if (gapCount > 0) depositStatus = 'partial';

        return {
          property,
          depositTotal,
          expenseTotal,
          net: depositTotal - expenseTotal,
          depositStatus,
          gapCount,
        };
      })
      .filter(
        (item) => item.depositTotal > 0 || item.expenseTotal > 0 || item.gapCount > 0,
      )
      .sort((a, b) => b.net - a.net);
  }, [
    propertiesQuery.data,
    periodDepositsQuery.data,
    periodExpensesQuery.data,
    gapsQuery.data,
    monthsCount,
  ]);

  const ownerPeriodRows = useMemo(() => {
    const deposits = periodDepositsQuery.data?.items ?? [];
    const expenses = periodExpensesQuery.data?.items ?? [];
    const properties = propertiesQuery.data ?? [];
    const byOwner = new Map<string, OwnerPeriodRow>();

    properties.forEach((property) => {
      const existing = byOwner.get(property.owner_id) ?? {
        ownerId: property.owner_id,
        ownerName: property.owner_name,
        propertyCount: 0,
        depositTotal: 0,
        expenseTotal: 0,
        depositCount: 0,
        expenseCount: 0,
      };
      existing.propertyCount += 1;
      byOwner.set(property.owner_id, existing);
    });

    const ownerIdByName = new Map(
      properties.map((property) => [property.owner_name, property.owner_id] as const),
    );

    deposits.forEach((deposit) => {
      const ownerId = ownerIdByName.get(deposit.owner_name);
      if (!ownerId) return;
      const existing = byOwner.get(ownerId);
      if (!existing) return;
      existing.depositTotal += Number(deposit.amount);
      existing.depositCount += 1;
    });

    expenses.forEach((expense) => {
      const ownerId = ownerIdByName.get(expense.owner_name);
      if (!ownerId) return;
      const existing = byOwner.get(ownerId);
      if (!existing) return;
      existing.expenseTotal += Number(expense.amount);
      existing.expenseCount += 1;
    });

    return Array.from(byOwner.values())
      .filter((owner) => owner.depositTotal > 0 || owner.expenseTotal > 0)
      .sort(
        (a, b) => b.depositTotal - b.expenseTotal - (a.depositTotal - a.expenseTotal),
      );
  }, [periodDepositsQuery.data, periodExpensesQuery.data, propertiesQuery.data]);

  const propertyById = useMemo(() => {
    const map = new Map<string, Property>();
    (propertiesQuery.data ?? []).forEach((property) => map.set(property.id, property));
    return map;
  }, [propertiesQuery.data]);

  const recentActivity = useMemo(() => {
    const deposits = (periodDepositsQuery.data?.items ?? []).map(depositToRecent);
    const expenses = (periodExpensesQuery.data?.items ?? []).map(expenseToRecent);
    return [...deposits, ...expenses]
      .sort(
        (a, b) =>
          new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime(),
      )
      .slice(0, RECENT_LIMIT);
  }, [periodDepositsQuery.data, periodExpensesQuery.data]);

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
  const periodDates = { dateFrom: period.dateFrom, dateTo: period.dateTo };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="page-heading">Dashboard</h2>
          <p className="page-desc">
            Portfolio overview for {period.label} — deposits, expenses, alerts, and activity.
          </p>
        </div>

        <div className="filter-panel max-w-3xl lg:grid-cols-3">
          <label className="text-sm">
            <span className="label-text">Period</span>
            <select
              className="field"
              value={periodType}
              onChange={(event) => setPeriodType(event.target.value as PeriodType)}
            >
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label-text">Year</span>
            <select
              className="field"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {periodType !== 'year' ? (
            <label className="text-sm">
              <span className="label-text">
                {periodType === 'month' ? (
                  'Month'
                ) : (
                  <Tooltip content="Month used to pick the selected quarter.">
                    Anchor month
                  </Tooltip>
                )}
              </span>
              <select
                className="field"
                value={month}
                onChange={(event) => setMonth(Number(event.target.value))}
              >
                {months.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="hidden lg:block" />
          )}
        </div>
      </div>

      {/* Quick actions */}
      <section className="flex flex-wrap gap-2">
        <Link to="/transactions" state={{ showUpload: true }} className="btn-primary">
          Import file
        </Link>
        <Link to="/transactions" state={{ showForm: true }} className="btn-secondary">
          Add expense
        </Link>
        <Link to="/alerts" className="btn-secondary">
          View alerts
          {alertSummaryQuery.data && alertSummaryQuery.data.open_count > 0 ? (
            <span className="ml-2 rounded-full bg-rose-500 px-2 py-0.5 text-xs text-white">
              {alertSummaryQuery.data.open_count}
            </span>
          ) : null}
        </Link>
        <Link to="/ai" className="btn-secondary">
          Ask AI
        </Link>
      </section>

      {/* Financial snapshot */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <Card
          title="Deposits"
          value={formatCurrency(depositTotal)}
          subtitle={`${depositSummaryQuery.data!.deposit_count} in ${period.label}`}
          tooltip="Deposit total for the selected period."
        />
        <Card
          title="Expenses"
          value={formatCurrency(expenseTotal)}
          subtitle={`${expenseSummaryQuery.data!.expense_count} in ${period.label}`}
          tooltip="Expense total for the selected period."
        />
        <Card
          title="Net position"
          value={formatCurrency(netTotal)}
          subtitle="Deposits minus expenses"
          tooltip="Deposits minus expenses for this period."
        />
        <Card
          title="Transactions"
          value={totalTransactions}
          subtitle={`${depositSummaryQuery.data!.property_count} properties with deposits`}
          tooltip="Deposit + expense count in this period."
        />
        <Card
          title="Open alerts"
          value={alertSummaryQuery.data?.open_count ?? '—'}
          subtitle={
            alertSummaryQuery.data
              ? `${alertSummaryQuery.data.error_count} errors · ${alertSummaryQuery.data.warning_count} warnings`
              : 'Loading...'
          }
          tooltip="Unresolved warnings or errors needing review."
        />
        <Card
          title="Missing deposits"
          value={gapsQuery.data?.length ?? '—'}
          subtitle={`Across ${period.label}`}
          tooltip="Expected deposits not found in this period."
        />
      </section>

      {/* Pending uploads + alerts */}
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="panel">
          <div className="section-header flex items-start justify-between gap-3">
            <div>
              <h3 className="section-title">
                <Tooltip content="Uploads analyzed but not yet confirmed into the ledger.">
                  Pending uploads
                </Tooltip>
              </h3>
              <p className="section-subtitle">Files analyzed but not yet confirmed.</p>
            </div>
            <Link to="/alerts" className="btn-secondary text-sm">
              Review all
            </Link>
          </div>
          {alertsQuery.isLoading ? (
            <div className="p-5">
              <LoadingState label="Loading uploads..." />
            </div>
          ) : pendingUploads.length > 0 ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {pendingUploads.map((alert) => (
                <li key={alert.id}>
                  <Link
                    to="/alerts"
                    className="block px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  >
                    <p className="font-medium">{alert.title}</p>
                    <p className="mt-1 text-xs text-muted">{alert.message}</p>
                    <p className="mt-1 text-xs text-muted">
                      {alert.property_name} · {alert.transaction_type}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-5">
              <EmptyState message="No pending uploads." />
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-header flex items-start justify-between gap-3">
            <div>
              <h3 className="section-title">Alerts at a glance</h3>
              <p className="section-subtitle">Top items needing attention.</p>
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
      </div>

      {/* Property health cards */}
      <section>
        <div className="mb-3">
          <h3 className="section-title">
            <Tooltip content="Per-property activity and expected deposit status for this period.">
              Property health
            </Tooltip>
          </h3>
          <p className="section-subtitle">
            Properties with deposits, expenses, or missing expected deposits in {period.label}.
          </p>
        </div>
        {propertiesQuery.isLoading || periodDepositsQuery.isLoading || periodExpensesQuery.isLoading ? (
          <LoadingState label="Loading property health..." />
        ) : propertyHealth.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {propertyHealth.map((item) => (
              <Link
                key={item.property.id}
                to="/transactions"
                state={propertyTransactionsState(
                  item.property.id,
                  item.property.client_prop_id,
                  periodDates,
                )}
                className="panel block p-5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{item.property.name}</p>
                    <p className="text-xs text-muted">{item.property.owner_name}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted">
                      Prop ID: {item.property.client_prop_id}
                    </p>
                  </div>
                  <Tooltip
                    content={
                      item.depositStatus === 'ok'
                        ? 'Expected deposits found for this period.'
                        : item.depositStatus === 'missing'
                          ? 'Expected deposits missing for all months in this period.'
                          : 'Some expected deposits are missing in this period.'
                    }
                  >
                    <span className={depositStatusBadge(item.depositStatus)}>
                      {depositStatusLabel(item.depositStatus)}
                    </span>
                  </Tooltip>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-xs text-muted">
                      <Tooltip content="Deposits in this period.">Deposits</Tooltip>
                    </p>
                    <p className="amount-deposit">{formatCurrency(item.depositTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">
                      <Tooltip content="Expenses in this period.">Expenses</Tooltip>
                    </p>
                    <p className="amount-expense">{formatCurrency(item.expenseTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">
                      <Tooltip content="Deposits minus expenses.">Net</Tooltip>
                    </p>
                    <p className={item.net >= 0 ? 'amount-deposit' : 'amount-expense'}>
                      {formatCurrency(item.net)}
                    </p>
                  </div>
                </div>
                {item.gapCount > 0 ? (
                  <p className="mt-3 text-xs text-caution">
                    {item.gapCount} missing expected deposit(s) in period
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-muted">Expected deposits on track</p>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState message="No properties found." />
        )}
      </section>

      {/* Expense breakdown */}
      <section className="panel">
        <div className="section-header">
          <h3 className="section-title">Expense breakdown — {period.label}</h3>
          <p className="section-subtitle">Totals by category for the selected period.</p>
        </div>
        {expenseCategories.length > 0 ? (
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
            <EmptyState message="No expenses in this period." />
          </div>
        )}
      </section>

      {/* Missing deposits */}
      <section className="panel">
        <div className="section-header">
          <h3 className="section-title">
            <Tooltip content="Expected deposits not found for properties in this period.">
              Missing expected deposits
            </Tooltip>
            {' — '}
            {period.label}
          </h3>
          <p className="section-subtitle">
            Properties where the expected deposit was not received.
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
                  <th className="px-5 py-3 font-medium">Period</th>
                  <th className="px-5 py-3 font-medium">Expected</th>
                  <th className="px-5 py-3 font-medium">Due day</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {gapsQuery.data.map((gap) => {
                  const property = propertyById.get(gap.property_id);
                  return (
                    <tr
                      key={`${gap.property_id}-${gap.period_start}`}
                      className="table-row-link"
                      onClick={() =>
                        navigate(
                          '/transactions',
                          {
                            state: propertyTransactionsState(
                              gap.property_id,
                              property?.client_prop_id,
                              periodDates,
                            ),
                          },
                        )
                      }
                    >
                      <td className="px-5 py-3 font-medium">{gap.property_name}</td>
                      <td className="px-5 py-3">{gap.owner_name}</td>
                      <td className="px-5 py-3">{formatDate(gap.period_start)}</td>
                      <td className="px-5 py-3">{formatCurrency(gap.expected_amount)}</td>
                      <td className="px-5 py-3">{gap.due_day}</td>
                      <td className="px-5 py-3">
                        <span className="badge-warning">{gap.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-5 muted-text">No missing deposits for {period.label}.</div>
        )}
      </section>

      {/* Owner overview (period-scoped) */}
      <section className="panel">
        <div className="section-header flex items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Owner overview — {period.label}</h3>
            <p className="section-subtitle">Deposits, expenses, and net per owner in this period.</p>
          </div>
          <Link to="/owners" className="btn-secondary text-sm">
            View owners
          </Link>
        </div>
        {ownerPeriodRows.length > 0 ? (
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
                {ownerPeriodRows.map((owner) => {
                  const net = owner.depositTotal - owner.expenseTotal;
                  return (
                    <tr
                      key={owner.ownerId}
                      className="table-row-link"
                      onClick={() =>
                        navigate('/transactions', {
                          state: ownerTransactionsState(owner.ownerId, periodDates),
                        })
                      }
                    >
                      <td className="px-5 py-3 font-medium">{owner.ownerName}</td>
                      <td className="px-5 py-3">{owner.propertyCount}</td>
                      <td className="px-5 py-3">
                        <span className="amount-deposit">{formatCurrency(owner.depositTotal)}</span>
                        <span className="ml-1 text-xs text-muted">({owner.depositCount})</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="amount-expense">{formatCurrency(owner.expenseTotal)}</span>
                        <span className="ml-1 text-xs text-muted">({owner.expenseCount})</span>
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
            <EmptyState message="No owner activity in this period." />
          </div>
        )}
      </section>

      {/* Recent activity (period-scoped) */}
      <section className="panel">
        <div className="section-header flex items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Recent activity — {period.label}</h3>
            <p className="section-subtitle">Latest deposits and expenses in the selected period.</p>
          </div>
          <Link to="/transactions" className="btn-secondary text-sm">
            View all
          </Link>
        </div>
        {periodDepositsQuery.isLoading || periodExpensesQuery.isLoading ? (
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
                    className={`${item.kind === 'deposit' ? 'row-deposit' : 'row-expense'} table-row-link`}
                    onClick={() =>
                      navigate('/transactions', {
                        state: propertyTransactionsState(
                          item.property_id,
                          item.client_prop_id,
                          periodDates,
                        ),
                      })
                    }
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
            <EmptyState message="No transactions in this period." />
          </div>
        )}
      </section>
    </div>
  );
}
