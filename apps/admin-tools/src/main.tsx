import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider } from 'react-router';
import './index.css';
import { AuthProvider, canDispatch, canManageBusinesses, canManageExpenses, canManageFleet, canManageInvoices, canManageNetwork, canOperateHubs, useStaffAuth } from './lib/auth';
import { BusinessesPage } from './pages/BusinessesPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { StaffPage } from './pages/StaffPage';
import { RoutesPage } from './pages/RoutesPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { DriverPayPage } from './pages/DriverPayPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { HubPage } from './pages/HubPage';
import { NetworkPage } from './pages/NetworkPage';
import { config } from './lib/config';
import { DispatchPage } from './pages/DispatchPage';
import { FleetPage } from './pages/FleetPage';
import { Centered, EnrollMfaPage, SignInPage } from './pages/SignInPage';

/** Gate: signed in → staff role → second factor used this session. */
function Shell() {
  const { user, role, isStaff, mfa, loading, signOut } = useStaffAuth();
  if (loading) return <p className="p-8 text-center text-slate-500">Loading…</p>;
  if (!user) return <SignInPage />;
  if (!isStaff)
    return (
      <Centered title="No operations access">
        <p className="text-sm text-slate-600">This account is not set up for operations. Ask an administrator.</p>
        <button className="btn-secondary" onClick={() => signOut()}>
          Sign out
        </button>
      </Centered>
    );
  if (!mfa) return <EnrollMfaPage />;
  const link = ({ isActive }: { isActive: boolean }) => `rounded px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:text-slate-900'}`;
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2">
        <span className="font-bold text-brand-700">{config.companyName} · Ops</span>
        <nav className="-mx-1 flex max-w-full gap-1 overflow-x-auto">
          {canDispatch(role) && <NavLink to="/dispatch" className={link}>Dispatch</NavLink>}
          {canDispatch(role) && <NavLink to="/routes" className={link}>Routes</NavLink>}
          {canOperateHubs(role) && <NavLink to="/hub" className={link}>Hub</NavLink>}
          {canManageFleet(role) && <NavLink to="/fleet" className={link}>Fleet</NavLink>}
          {canManageNetwork(role) && <NavLink to="/network" className={link}>Network</NavLink>}
          {canManageNetwork(role) && <NavLink to="/staff" className={link}>Staff</NavLink>}
          {canManageBusinesses(role) && <NavLink to="/businesses" className={link}>Businesses</NavLink>}
          {canManageInvoices(role) && <NavLink to="/invoices" className={link}>Invoices</NavLink>}
          {canManageExpenses(role) && <NavLink to="/expenses" className={link}>Expenses</NavLink>}
          {canManageInvoices(role) && <NavLink to="/driver-pay" className={link}>Driver pay</NavLink>}
          {canManageInvoices(role) && <NavLink to="/analytics" className={link}>Analytics</NavLink>}
        </nav>
        <span className="ml-auto hidden text-sm text-slate-500 sm:inline">
          {user.email} · {role}
        </span>
        <button className="btn-secondary py-1" onClick={() => signOut()}>
          Sign out
        </button>
      </header>
      <Outlet />
    </div>
  );
}

function Home() {
  const { role } = useStaffAuth();
  if (canDispatch(role)) return <Navigate to="/dispatch" replace />;
  if (canOperateHubs(role)) return <Navigate to="/hub" replace />;
  if (canManageFleet(role)) return <Navigate to="/fleet" replace />;
  if (canManageInvoices(role)) return <Navigate to="/invoices" replace />;
  return <p className="p-8 text-slate-600">Your role ({role}) has no screens yet.</p>;
}

function Guard({ allow, children }: { allow: (r: ReturnType<typeof useStaffAuth>['role']) => boolean; children: React.ReactNode }) {
  const { role } = useStaffAuth();
  return allow(role) ? <>{children}</> : <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/dispatch', element: <Guard allow={canDispatch}><DispatchPage /></Guard> },
      { path: '/fleet', element: <Guard allow={canManageFleet}><FleetPage /></Guard> },
      { path: '/hub', element: <Guard allow={canOperateHubs}><HubPage /></Guard> },
      { path: '/network', element: <Guard allow={canManageNetwork}><NetworkPage /></Guard> },
      { path: '/routes', element: <Guard allow={canDispatch}><RoutesPage /></Guard> },
      { path: '/expenses', element: <Guard allow={canManageExpenses}><ExpensesPage /></Guard> },
      { path: '/driver-pay', element: <Guard allow={canManageInvoices}><DriverPayPage /></Guard> },
      { path: '/analytics', element: <Guard allow={canManageInvoices}><AnalyticsPage /></Guard> },
      { path: '/staff', element: <Guard allow={canManageNetwork}><StaffPage /></Guard> },
      { path: '/businesses', element: <Guard allow={canManageBusinesses}><BusinessesPage /></Guard> },
      { path: '/invoices', element: <Guard allow={canManageInvoices}><InvoicesPage /></Guard> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
