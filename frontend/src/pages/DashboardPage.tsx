import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DepositGap, Property } from '../types';
import { TransactionTable } from '../components/TransactionTable';
import {
  Card,
  EmptyState,
  ErrorState,
  formatCurrency,
  formatDate,
  LoadingState,
} from '../components/ui/States';
import { MoneyValue } from '../components/ui/MoneyValue';
import { Tooltip } from '../components/ui/Tooltip';
import { formatLabel } from '../utils/formatLabel';
import {
  ownerTransactionsState,
  propertyTransactionsState,
} from '../utils/transactionsNav';
import {
  mergeAndSortTransactions,
} from '../utils/unifiedTransaction';
import {
  buildDashboardPeriod,
  defaultDashboardPeriod,
  monthsInPeriod,
  periodOptions,
  type DashboardPeriod,
  type PeriodType,
} from '../utils/dashboardPeriod';

const RECENT_LIMIT = 10;
const DEFAULT_EXPENSE_BREAKDOWN_MIN = 10000;


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
  const [showAllExpenseCategories, setShowAllExpenseCategories] = useState(false);
  const [expenseBreakdownMinInput, setExpenseBreakdownMinInput] = useState(
    String(DEFAULT_EXPENSE_BREAKDOWN_MIN),
  );
  const expenseBreakdownMinAmount = useMemo(() => {
    const parsed = Number(expenseBreakdownMinInput);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EXPENSE_BREAKDOWN_MIN;
  }, [expenseBreakdownMinInput]);

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
  const alertsQuery = useQuery({
    queryKey: ['alerts'],
    queryFn: api.getAlerts,
  });
  const alertSummary = useMemo(() => {
    const data = alertsQuery.data;
    if (!data) return null;
    return {
      open_count: data.total,
      error_count: data.error_count,
      warning_count: data.warning_count,
    };
  }, [alertsQuery.data]);
  const gapsQuery = useQuery({
    queryKey: ['deposit-gaps', period],
    queryFn: () => fetchPeriodGaps(period),
  });
  const propertiesQuery = useQuery({
    queryKey: ['properties'],
    queryFn: api.getProperties,
  });
  const periodFloatQuery = useQuery({
    queryKey: ['dashboard-period-float', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getPeriodFloat({ date_from: period.dateFrom, date_to: period.dateTo }),
  });
  const recentDepositsQuery = useQuery({
    queryKey: ['dashboard-recent-deposits', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getDeposits({
        date_from: period.dateFrom,
        date_to: period.dateTo,
        page: 1,
        page_size: RECENT_LIMIT,
        include_running_balance: false,
      }),
  });
  const recentExpensesQuery = useQuery({
    queryKey: ['dashboard-recent-expenses', period.dateFrom, period.dateTo],
    queryFn: () =>
      api.getExpenses({
        date_from: period.dateFrom,
        date_to: period.dateTo,
        page: 1,
        page_size: RECENT_LIMIT,
        include_running_balance: false,
      }),
  });

  const topAlerts = alertsQuery.data?.items.slice(0, 5) ?? [];
  const pendingUploads =
    alertsQuery.data?.items.filter((alert) =>
      ['upload_pending', 'duplicate_deposit'].includes(alert.alert_type),
    ) ?? [];

  const expenseCategories = expenseSummaryQuery.data?.by_category ?? [];
  const expenseBreakdownRows = useMemo(() => {
    const sorted = expenseCategories
      .slice()
      .sort((a, b) => Number(b.total_amount) - Number(a.total_amount));
    if (showAllExpenseCategories) {
      return sorted.map((item) => ({
        key: item.category,
        label: formatLabel(item.category),
        total: Number(item.total_amount),
        count: item.expense_count,
      }));
    }
    const above = sorted.filter(
      (item) => Number(item.total_amount) >= expenseBreakdownMinAmount,
    );
    const below = sorted.filter(
      (item) => Number(item.total_amount) < expenseBreakdownMinAmount,
    );
    const rows = above.map((item) => ({
      key: item.category,
      label: formatLabel(item.category),
      total: Number(item.total_amount),
      count: item.expense_count,
    }));
    if (below.length > 0) {
      rows.push({
        key: '__other_below_min__',
        label: `Other (under ${formatCurrency(expenseBreakdownMinAmount)})`,
        total: below.reduce((sum, item) => sum + Number(item.total_amount), 0),
        count: below.reduce((sum, item) => sum + item.expense_count, 0),
      });
    }
    return rows;
  }, [expenseCategories, expenseBreakdownMinAmount, showAllExpenseCategories]);
  const maxCategoryTotal = Math.max(...expenseBreakdownRows.map((item) => item.total), 1);
  const hasSmallExpenseCategories = expenseCategories.some(
    (item) => Number(item.total_amount) < expenseBreakdownMinAmount,
  );

  const periodFloatByProperty = useMemo(() => {
    const map = new Map<
      string,
      { depositTotal: number; expenseTotal: number; depositCount: number; expenseCount: number }
    >();
    for (const row of periodFloatQuery.data?.properties ?? []) {
      map.set(row.property_id, {
        depositTotal: Number(row.deposit_total),
        expenseTotal: Number(row.expense_total),
        depositCount: row.deposit_count,
        expenseCount: row.expense_count,
      });
    }
    return map;
  }, [periodFloatQuery.data]);

  const propertyHealth = useMemo(() => {
    const properties = propertiesQuery.data ?? [];
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
        const floats = periodFloatByProperty.get(property.id);
        const depositTotal = floats?.depositTotal ?? 0;
        const expenseTotal = floats?.expenseTotal ?? 0;
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
  }, [propertiesQuery.data, periodFloatByProperty, gapsQuery.data, monthsCount]);

  const ownerPeriodRows = useMemo(() => {
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
      const floats = periodFloatByProperty.get(property.id);
      if (floats) {
        existing.depositTotal += floats.depositTotal;
        existing.expenseTotal += floats.expenseTotal;
        existing.depositCount += floats.depositCount;
        existing.expenseCount += floats.expenseCount;
      }
      byOwner.set(property.owner_id, existing);
    });

    return Array.from(byOwner.values())
      .filter((owner) => owner.depositTotal > 0 || owner.expenseTotal > 0)
      .sort(
        (a, b) => b.depositTotal - b.expenseTotal - (a.depositTotal - a.expenseTotal),
      );
  }, [periodFloatByProperty, propertiesQuery.data]);

  const propertyById = useMemo(() => {
    const map = new Map<string, Property>();
    (propertiesQuery.data ?? []).forEach((property) => map.set(property.id, property));
    return map;
  }, [propertiesQuery.data]);

  const recentActivity = useMemo(
    () =>
      mergeAndSortTransactions(
        recentDepositsQuery.data?.items ?? [],
        recentExpensesQuery.data?.items ?? [],
      ).slice(0, RECENT_LIMIT),
    [recentDepositsQuery.data, recentExpensesQuery.data],
  );

  if (depositSummaryQuery.isLoading || expenseSummaryQuery.isLoading) {
    return <LoadingState label="Loading dashboard..." />;
  }

  if (depositSummaryQuery.isError || expenseSummaryQuery.isError) {
    return (
      <ErrorState
        message="We couldn't load the dashboard. Please check your connection and try again."
        error={depositSummaryQuery.error ?? expenseSummaryQuery.error}
      />
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
          {alertSummary && alertSummary.open_count > 0 ? (
            <span className="ml-2 rounded-full bg-rose-500 px-2 py-0.5 text-xs text-white">
              {alertSummary.open_count}
            </span>
          ) : null}
        </Link>
        <Link to="/ai" className="btn-secondary">
          Ask AI
        </Link>
      </section>

      {/* Financial snapshot */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <button
          type="button"
          className="text-left"
          onClick={() =>
            navigate('/transactions', {
              state: { dateFrom: period.dateFrom, dateTo: period.dateTo, kinds: ['deposit'] },
            })
          }
        >
          <Card
            title="Deposits"
            value={formatCurrency(depositTotal)}
            subtitle={`${depositSummaryQuery.data!.deposit_count} in ${period.label}`}
            tooltip="Deposit total for the selected period. Click to open Transactions."
          />
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() =>
            navigate('/transactions', {
              state: { dateFrom: period.dateFrom, dateTo: period.dateTo, kinds: ['expense'] },
            })
          }
        >
          <Card
            title="Expenses"
            value={formatCurrency(expenseTotal)}
            subtitle={`${expenseSummaryQuery.data!.expense_count} in ${period.label}`}
            tooltip="Expense total for the selected period. Click to open Transactions."
          />
        </button>
        <button
          type="button"
          className="text-left"
          onClick={() =>
            navigate('/transactions', {
              state: {
                dateFrom: period.dateFrom,
                dateTo: period.dateTo,
                kinds: ['deposit', 'expense'],
              },
            })
          }
        >
          <Card
            title="Net position"
            value={formatCurrency(netTotal)}
            subtitle="Company float for period"
            tooltip="Deposits minus expenses (company float) for this period."
          />
        </button>
        <Card
          title="Transactions"
          value={totalTransactions}
          subtitle={`${depositSummaryQuery.data!.property_count} properties with deposits`}
          tooltip="Deposit + expense count in this period."
        />
        <button type="button" className="text-left" onClick={() => navigate('/alerts')}>
          <Card
            title="Open alerts"
            value={alertSummary?.open_count ?? '—'}
            subtitle={
              alertSummary
                ? `${alertSummary.error_count} errors · ${alertSummary.warning_count} warnings`
                : 'Loading...'
            }
            tooltip="Unresolved warnings or errors needing review."
          />
        </button>
        {gapsQuery.data && gapsQuery.data.length > 0 ? (
          <Card
            title="Missing deposits"
            value={gapsQuery.data.length}
            subtitle={`Across ${period.label}`}
            tooltip="Expected deposits not found in this period."
          />
        ) : null}
      </section>

      {/* Recent activity (period-scoped) — early for presentation clarity */}
      <section className="panel">
        <div className="section-header flex items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Recent activity — {period.label}</h3>
            <p className="section-subtitle">Latest deposits and expenses in the selected period.</p>
          </div>
          <Link
            to="/transactions"
            state={{
              dateFrom: period.dateFrom,
              dateTo: period.dateTo,
            }}
            className="btn-secondary text-sm"
          >
            View all
          </Link>
        </div>
        {recentDepositsQuery.isLoading || recentExpensesQuery.isLoading ? (
          <div className="p-5">
            <LoadingState label="Loading activity..." />
          </div>
        ) : recentActivity.length > 0 ? (
          <TransactionTable
            rows={recentActivity}
            onRowClick={(row) =>
              navigate('/transactions', {
                state: {
                  ...propertyTransactionsState(
                    row.property_id,
                    row.client_prop_id,
                    periodDates,
                  ),
                  highlightId: row.id,
                  highlightKind: row.kind,
                },
              })
            }
          />
        ) : (
          <div className="p-5">
            <EmptyState message="No transactions in this period." />
          </div>
        )}
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
        {propertiesQuery.isLoading || periodFloatQuery.isLoading ? (
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
                      <Tooltip content="Company-float deposits in this period.">Deposits</Tooltip>
                    </p>
                    <p>
                      <MoneyValue amount={item.depositTotal} />
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">
                      <Tooltip content="Company-float expenses in this period.">Expenses</Tooltip>
                    </p>
                    <p className="amount-expense">{formatCurrency(item.expenseTotal)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">
                      <Tooltip content="Deposits minus expenses.">Balance</Tooltip>
                    </p>
                    <p>
                      <MoneyValue amount={item.net} />
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
        <div className="section-header flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="section-title">Expense breakdown — {period.label}</h3>
            <p className="section-subtitle">
              {showAllExpenseCategories
                ? 'Totals by category for the selected period.'
                : `Categories from ${formatCurrency(expenseBreakdownMinAmount)}; smaller totals are grouped.`}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2 shrink-0">
            <label className="block space-y-1 text-sm">
              <span className="label-text">Min amount</span>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={expenseBreakdownMinInput}
                onChange={(event) => {
                  setExpenseBreakdownMinInput(event.target.value);
                  setShowAllExpenseCategories(false);
                }}
                disabled={showAllExpenseCategories}
                className="field w-28 text-sm"
                aria-label="Minimum category amount"
              />
            </label>
            {hasSmallExpenseCategories || showAllExpenseCategories ? (
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={() => setShowAllExpenseCategories((open) => !open)}
              >
                {showAllExpenseCategories
                  ? `Group under ${formatCurrency(expenseBreakdownMinAmount)}`
                  : 'Show all'}
              </button>
            ) : null}
          </div>
        </div>
        {expenseBreakdownRows.length > 0 ? (
          <ul className="space-y-4 p-5">
            {expenseBreakdownRows.map((item) => {
              const width = Math.round((item.total / maxCategoryTotal) * 100);
              return (
                <li key={item.key}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{item.label}</span>
                    <span>
                      {formatCurrency(item.total)}
                      <span className="ml-2 text-xs text-muted">({item.count})</span>
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

      {/* Missing deposits — only when expected-deposit rules produce gaps */}
      {gapsQuery.data && gapsQuery.data.length > 0 ? (
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
                        navigate('/transactions', {
                          state: propertyTransactionsState(
                            gap.property_id,
                            property?.client_prop_id,
                            periodDates,
                          ),
                        })
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
        </section>
      ) : null}

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
                        <MoneyValue amount={owner.depositTotal} />
                        <span className="ml-1 text-xs text-muted">({owner.depositCount})</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="amount-expense">{formatCurrency(owner.expenseTotal)}</span>
                        <span className="ml-1 text-xs text-muted">({owner.expenseCount})</span>
                      </td>
                      <td className="px-5 py-3">
                        <MoneyValue amount={net} />
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
    </div>
  );
}
