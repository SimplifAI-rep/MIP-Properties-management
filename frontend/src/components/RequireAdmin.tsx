import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LoadingState } from './ui/States';

/** Renders children only when an admin session is active. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin, ready } = useAuth();

  if (!ready) {
    return <LoadingState label="Checking access…" />;
  }
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return children;
}
