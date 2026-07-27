import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getAdminToken, setAdminToken } from '../api/client';

type AuthContextValue = {
  isAdmin: boolean;
  configured: boolean;
  ready: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const session = await api.getAdminSession();
      setConfigured(session.configured);
      setIsAdmin(session.authenticated);
      if (!session.authenticated && getAdminToken()) {
        setAdminToken(null);
      }
    } catch {
      setIsAdmin(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (password: string) => {
      const result = await api.adminLogin(password);
      setAdminToken(result.token);
      setIsAdmin(true);
      setConfigured(true);
    },
    [],
  );

  const logout = useCallback(() => {
    setAdminToken(null);
    setIsAdmin(false);
  }, []);

  const value = useMemo(
    () => ({ isAdmin, configured, ready, login, logout, refresh }),
    [isAdmin, configured, ready, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
