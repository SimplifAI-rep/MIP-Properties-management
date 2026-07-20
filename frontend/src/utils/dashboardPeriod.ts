export type PeriodType = 'month' | 'quarter' | 'year';

export interface DashboardPeriod {
  type: PeriodType;
  year: number;
  month: number;
  dateFrom: string;
  dateTo: string;
  label: string;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function toIsoDate(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function quarterStartMonth(month: number) {
  return Math.floor((month - 1) / 3) * 3 + 1;
}

export function buildDashboardPeriod(
  type: PeriodType,
  year: number,
  month: number,
): DashboardPeriod {
  if (type === 'month') {
    const dateFrom = toIsoDate(year, month, 1);
    const dateTo = toIsoDate(year, month, lastDayOfMonth(year, month));
    const label = new Date(year, month - 1, 1).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
    });
    return { type, year, month, dateFrom, dateTo, label };
  }

  if (type === 'quarter') {
    const startMonth = quarterStartMonth(month);
    const endMonth = startMonth + 2;
    const quarter = Math.ceil(startMonth / 3);
    const dateFrom = toIsoDate(year, startMonth, 1);
    const dateTo = toIsoDate(year, endMonth, lastDayOfMonth(year, endMonth));
    return {
      type,
      year,
      month,
      dateFrom,
      dateTo,
      label: `Q${quarter} ${year}`,
    };
  }

  const dateFrom = toIsoDate(year, 1, 1);
  const dateTo = toIsoDate(year, 12, 31);
  return { type, year, month, dateFrom, dateTo, label: String(year) };
}

export function defaultDashboardPeriod(): DashboardPeriod {
  const now = new Date();
  return buildDashboardPeriod('month', now.getFullYear(), now.getMonth() + 1);
}

export function monthsInPeriod(period: DashboardPeriod): Array<{ year: number; month: number }> {
  if (period.type === 'month') {
    return [{ year: period.year, month: period.month }];
  }

  if (period.type === 'quarter') {
    const startMonth = quarterStartMonth(period.month);
    return [
      { year: period.year, month: startMonth },
      { year: period.year, month: startMonth + 1 },
      { year: period.year, month: startMonth + 2 },
    ];
  }

  return Array.from({ length: 12 }, (_, index) => ({
    year: period.year,
    month: index + 1,
  }));
}

export function periodOptions(availableYears?: number[]) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years =
    availableYears && availableYears.length > 0
      ? [...availableYears].sort((a, b) => b - a)
      : [currentYear - 1, currentYear, currentYear + 1];
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return {
      value: month,
      label: new Date(currentYear, index, 1).toLocaleDateString('en-GB', { month: 'long' }),
    };
  });
  return { years, months };
}
