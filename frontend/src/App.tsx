import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AIQueryPage } from './pages/AIQueryPage';
import { DashboardPage } from './pages/DashboardPage';
import { DepositsPage } from './pages/DepositsPage';
import { ExpensesPage } from './pages/ExpensesPage';
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="properties" element={<PropertiesPage />} />
            <Route path="deposits" element={<DepositsPage />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="ai" element={<AIQueryPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
