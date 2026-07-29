import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { RequireAdmin } from './components/RequireAdmin';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { AIQueryPage } from './pages/AIQueryPage';
import { AlertRulesPage } from './pages/AlertRulesPage';
import { AlertsPage } from './pages/AlertsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DataImportPage } from './pages/DataImportPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { OwnersPage } from './pages/OwnersPage';
import { PropertiesPage } from './pages/PropertiesPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="properties" element={<PropertiesPage />} />
                <Route path="owners" element={<OwnersPage />} />
                <Route path="transactions" element={<TransactionsPage />} />
                <Route path="alerts" element={<AlertsPage />} />
                <Route
                  path="data-import"
                  element={
                    <RequireAdmin>
                      <DataImportPage />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/alert-rules"
                  element={
                    <RequireAdmin>
                      <AlertRulesPage />
                    </RequireAdmin>
                  }
                />
                <Route path="ai" element={<AIQueryPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
