const PAGE_LABELS: Array<{ path: string; label: string; end?: boolean }> = [
  { path: '/', label: 'Dashboard', end: true },
  { path: '/properties', label: 'Properties' },
  { path: '/owners', label: 'Owners' },
  { path: '/transactions', label: 'Transactions' },
  { path: '/alerts', label: 'Alerts' },
  { path: '/data-import', label: 'Data import' },
  { path: '/ai', label: 'AI Query' },
];

/** Human-readable page name from the current URL path. */
export function getPageLabel(pathname = window.location.pathname): string {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  for (const item of PAGE_LABELS) {
    if (item.end) {
      if (normalized === item.path) return item.label;
      continue;
    }
    if (normalized === item.path || normalized.startsWith(`${item.path}/`)) {
      return item.label;
    }
  }
  return normalized === '/' ? 'Dashboard' : normalized;
}
