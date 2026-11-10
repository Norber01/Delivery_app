import { Link, NavLink, Outlet } from 'react-router';
import { config } from '../lib/config';

export function Layout() {
  const nav = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'text-brand-700' : 'text-slate-600 hover:text-slate-900'}`;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-brand-700">
            <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
              ➜
            </span>
            {config.companyName}
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={nav}>
              Home
            </NavLink>
            <NavLink to="/book" className="btn-primary ml-2">
              Book a delivery
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} {config.companyName}. Company-owned fleet and hubs across Ghana.
          </p>
          <p className="flex gap-4">
            <Link to="/terms" className="hover:text-slate-800">
              Terms of carriage
            </Link>
            {config.supportPhone && <a href={`tel:${config.supportPhone.replace(/\s/g, '')}`}>{config.supportPhone}</a>}
          </p>
        </div>
      </footer>
    </div>
  );
}
