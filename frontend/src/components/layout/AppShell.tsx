import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/properties', label: 'Properties' },
  { to: '/owners', label: 'Owners' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/ai', label: 'AI Query' },
];

export function AppShell() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sidebar">
        <div className="flex items-start justify-between px-6 py-5">
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
        <nav className="flex gap-1 overflow-x-auto px-4 pb-4 lg:flex-col lg:px-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav-link-active' : 'nav-link-inactive')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
