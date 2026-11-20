import { useEffect, useState, type FormEvent } from 'react';
import { config } from '../lib/config';
import { demo, DriverPhone } from './DriverDemoPage';

const KEY = 'courier-demo-rider';

/**
 * Demo only: the rider app as a rider sees it on their phone — sign in with their own email and
 * password, then their jobs. No staff menu. (The real app is the Android app in apps/driver-app.)
 */
export function RiderAppPage() {
  // The demo backend starts in the background; wait for it when this is the first page opened.
  const [api, setApi] = useState(demo);
  useEffect(() => {
    if (api) return;
    const t = setInterval(() => demo() && setApi(demo), 100);
    return () => clearInterval(t);
  }, [api]);
  const [uid, setUid] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const remember = (v: string | null) => {
    setUid(v);
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch {
      /* private window: stays signed in for this page only */
    }
  };

  // "Sign in as…" in the demo bar opens /rider?as=<uid>.
  useEffect(() => {
    const as = new URLSearchParams(location.search).get('as');
    if (as) {
      remember(as);
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  if (!api) return <p className="p-8 text-center text-slate-500">Loading…</p>;

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      remember(api!.signInRider(email, password).uid);
    } catch (x) {
      setError((x as Error).message);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-md p-3 sm:py-8">
      {uid ? (
        <DriverPhone key={uid} uid={uid} api={api} onSignOut={() => remember(null)} />
      ) : (
        <section className="space-y-5 rounded-[2rem] border-[6px] border-black bg-page p-6 shadow-xl" aria-label="Rider sign in">
          <div className="space-y-2 pt-6 text-center">
            <span aria-hidden className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-accent-400 text-2xl text-black">
              ➜
            </span>
            <h1 className="text-2xl font-extrabold tracking-tight">{config.companyName} Rider</h1>
            <p className="text-sm text-slate-600">Sign in with the email your manager registered and the password you set.</p>
          </div>
          <form onSubmit={submit} className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Email</span>
              <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button className="btn-accent w-full py-3 text-base">Sign in</button>
          </form>
          <p className="rounded-xl bg-white p-3 text-xs text-slate-600">
            Demo riders: <strong>kwame@demo.gh</strong> or <strong>kojo@demo.gh</strong> (pickup), <strong>esi@demo.gh</strong> or <strong>abena@demo.gh</strong> (delivery). Password: <strong>demo1234</strong>.
          </p>
        </section>
      )}
    </main>
  );
}
