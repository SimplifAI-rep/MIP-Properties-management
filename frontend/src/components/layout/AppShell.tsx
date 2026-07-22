import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { FeedbackProvider, useFeedback } from '../../context/FeedbackContext';
import { useTheme } from '../../context/ThemeContext';
import { Tooltip } from '../ui/Tooltip';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/properties', label: 'Properties' },
  { to: '/owners', label: 'Owners' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/alerts', label: 'Alerts', showCount: true },
  { to: '/data-import', label: 'Data import' },
  { to: '/ai', label: 'AI Query' },
];

function AppShellInner() {
  const { theme, toggleTheme } = useTheme();
  const { openFeedback } = useFeedback();
  const alertSummaryQuery = useQuery({
    queryKey: ['alert-summary'],
    queryFn: api.getAlertSummary,
    refetchInterval: 60_000,
  });
  const openAlerts = alertSummaryQuery.data?.open_count ?? 0;

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sidebar">
        <div className="flex shrink-0 items-start justify-between px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              SimplifAI
            </p>
            <h1 className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">
              Property Assets
            </h1>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="theme-toggle"
            aria-label="Toggle dark mode"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link-active' : 'nav-link-inactive')}
            >
              {item.label}
              {item.showCount && openAlerts > 0 ? (
                <span className="ml-2 rounded-full bg-rose-500 px-2 py-0.5 text-xs text-white dark:bg-rose-600">
                  {openAlerts}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="nav-link-inactive w-full text-left"
            onClick={() => openFeedback()}
          >
            <Tooltip content="Send a problem report or improvement idea by email.">
              Feedback
            </Tooltip>
          </button>
        </div>
      </aside>
      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}

export function AppShell() {
  return (
    <FeedbackProvider>
      <AppShellInner />
    </FeedbackProvider>
  );
}
