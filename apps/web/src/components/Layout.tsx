import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../lib/auth';
import { config } from '../lib/config';

export function Layout() {
  const { user, role } = useAuth();
  const nav = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-2 text-sm font-semibold ${isActive ? 'bg-field text-black' : 'text-slate-600 hover:text-black'}`;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 bg-white/95 shadow-[0_1px_0_rgba(0,0,0,0.06)] backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-2.5">
          <Link to="/" className="flex min-w-0 items-center gap-2 text-lg font-extrabold tracking-tight text-black">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-400 text-black">
              ➜
            </span>
            <span className="truncate">{config.companyName}</span>
          </Link>
          <nav className="flex shrink-0 items-center gap-0.5">
            <NavLink to="/track" className={nav}>
              Track
            </NavLink>
            {(role === 'business_owner' || role === 'business_staff') && (
              <NavLink to="/business" className={nav}>
                Business
              </NavLink>
            )}
            <NavLink to={user && role ? '/account' : '/signin'} className={nav}>
              {user && role ? 'My account' : 'Sign in'}
            </NavLink>
            <NavLink to="/book" className="btn-accent ml-1 hidden min-h-10 px-4 sm:inline-flex">
              Send a parcel
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:justify-between">
          <p>
            © {new Date().getFullYear()} {config.companyName}. Company riders, from your door to theirs.
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
