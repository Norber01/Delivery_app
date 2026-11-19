import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, role, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="px-4 py-16 text-center text-slate-500">Loading…</p>;
  if (!user || !role) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}
