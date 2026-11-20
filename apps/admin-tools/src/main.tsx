import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider, useLocation } from 'react-router';
import './index.css';
import { AuthProvider, canBackup, canDispatch, canManageBusinesses, canManageExpenses, canManageFleet, canManageInvoices, canManageNetwork, canOperateHubs, canOversee, canSeeRiders, useStaffAuth } from './lib/auth';
import { OverviewPage } from './pages/OverviewPage';
import { WarehousePage } from './pages/WarehousePage';
import { BackupPage } from './pages/BackupPage';
import { BusinessesPage } from './pages/BusinessesPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { StaffPage } from './pages/StaffPage';
import { RoutesPage } from './pages/RoutesPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { DriverPayPage } from './pages/DriverPayPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DriverDemoPage } from './pages/DriverDemoPage';
import { RiderAppPage } from './pages/RiderAppPage';

const DEMO = import.meta.env.VITE_DEMO === 'true';
import { NetworkPage } from './pages/NetworkPage';
import { config } from './lib/config';
import { DispatchPage } from './pages/DispatchPage';
import { FleetPage } from './pages/FleetPage';
import { Centered, EnrollMfaPage, SignInPage } from './pages/SignInPage';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: boolean;
}

/** Gate: signed in → staff role → second factor used this session. */
function Shell() {
  const { user, role, isStaff, mfa, loading, signOut } = useStaffAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
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
  const groups: [string, NavItem[]][] = [
    [
      '',
      [
        { to: '/overview', label: 'Today', icon: '◉', show: canOversee(role) },
        { to: '/dispatch', label: 'Orders', icon: '▤', show: canDispatch(role) },
        { to: '/hub', label: 'Warehouse', icon: '▣', show: canOperateHubs(role) },
        { to: '/fleet', label: 'Riders & vehicles', icon: '🛵', show: canSeeRiders(role) },
        { to: '/routes', label: 'Rider routes', icon: '↝', show: canDispatch(role) },
      ],
    ],
    [
      'Money',
      [
        { to: '/driver-pay', label: 'Rider pay & cash', icon: '₵', show: canManageInvoices(role) },
        { to: '/expenses', label: 'Expenses', icon: '−', show: canManageExpenses(role) },
        { to: '/invoices', label: 'Invoices', icon: '≡', show: canManageInvoices(role) },
        { to: '/analytics', label: 'Reports', icon: '▲', show: canManageInvoices(role) },
        { to: '/backup', label: 'Excel backup', icon: '⤓', show: canBackup(role) },
      ],
    ],
    [
      'Settings',
      [
        { to: '/businesses', label: 'Business customers', icon: '◧', show: canManageBusinesses(role) },
        { to: '/staff', label: 'Staff access', icon: '☺', show: canManageNetwork(role) },
        { to: '/network', label: 'Areas & warehouses', icon: '⌂', show: canManageNetwork(role) },
      ],
    ],
    ['Demo', [{ to: '/driver-demo', label: 'Rider phone (demo)', icon: '📱', show: DEMO }]],
  ];
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold ${isActive ? 'bg-accent-400 text-black' : 'text-slate-700 hover:bg-field'}`;
  const nav = (
    <nav aria-label="Main" className="space-y-4">
      {groups.map(([title, items]) => {
        const visible = items.filter((i) => i.show);
        if (!visible.length) return null;
        return (
          <div key={title || 'main'} className="space-y-0.5">
            {title && <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</p>}
            {visible.map((i) => (
              <NavLink key={i.to} to={i.to} className={link}>
                <span aria-hidden className="w-5 text-center">
                  {i.icon}
                </span>
                {i.label}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );
  const who = (
    <div className="space-y-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
      <p className="truncate">{user.email}</p>
      <p className="font-semibold text-slate-700">{ROLE_NAME[role ?? ''] ?? role}</p>
      <button className="btn-secondary min-h-9 w-full py-1" onClick={() => signOut()}>
        Sign out
      </button>
    </div>
  );
  const brand = (
    <span className="flex items-center gap-2 font-extrabold tracking-tight">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-black">
        ➜
      </span>
      <span className="truncate">{config.companyName}</span>
    </span>
  );
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-5 overflow-y-auto bg-white p-4 shadow-[1px_0_0_rgba(0,0,0,0.06)] lg:flex" style={{ top: 'var(--demo-bar, 0px)' }}>
        {brand}
        <div className="flex-1">{nav}</div>
        {who}
      </aside>
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-white px-4 py-2 shadow-[0_1px_0_rgba(0,0,0,0.06)] lg:hidden">
        <button className="grid h-10 w-10 place-items-center rounded-xl bg-field text-lg" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(true)}>
          ☰
        </button>
        {brand}
      </header>
      {open && (
        <div className="fixed inset-x-0 bottom-0 z-40 lg:hidden" style={{ top: 'var(--demo-bar, 0px)' }} role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-black/30" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-5 overflow-y-auto bg-white p-4">
            {brand}
            <div className="flex-1">{nav}</div>
            {who}
          </div>
        </div>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const ROLE_NAME: Record<string, string> = {
  hub_operator: 'Warehouse staff',
  dispatcher: 'Dispatcher',
  fleet_manager: 'Fleet manager',
  finance: 'Finance',
  manager: 'Manager',
  admin: 'Administrator',
  super_admin: 'Owner (super administrator)',
};

function Home() {
  const { role } = useStaffAuth();
  if (canOversee(role)) return <Navigate to="/overview" replace />;
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
  // Demo only: the rider app, outside the staff screens (riders sign in with their own account).
  ...(DEMO ? [{ path: '/rider', element: <RiderAppPage /> }] : []),
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/overview', element: <Guard allow={canOversee}><OverviewPage /></Guard> },
      { path: '/dispatch', element: <Guard allow={canDispatch}><DispatchPage /></Guard> },
      { path: '/fleet', element: <Guard allow={canSeeRiders}><FleetPage /></Guard> },
      { path: '/hub', element: <Guard allow={canOperateHubs}><WarehousePage /></Guard> },
      { path: '/backup', element: <Guard allow={canBackup}><BackupPage /></Guard> },
      { path: '/network', element: <Guard allow={canManageNetwork}><NetworkPage /></Guard> },
      ...(DEMO ? [{ path: '/driver-demo', element: <DriverDemoPage /> }] : []),
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
], { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' });

// Demo build: start the in-browser backend straight away (shows the demo bar on every page).
if (import.meta.env.VITE_DEMO === 'true') void import('@courier/demo-backend').then((m) => m.demoReady());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
