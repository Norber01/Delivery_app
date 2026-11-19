import { STAFF_ROLES, type StaffRole } from '@courier/constants';
import type { HubDoc } from '@courier/shared-types';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

const ROLE_LABEL: Record<StaffRole, string> = {
  hub_operator: 'Hub operator',
  dispatcher: 'Dispatcher',
  fleet_manager: 'Fleet manager',
  finance: 'Finance',
  admin: 'Administrator',
  super_admin: 'Super administrator',
};
interface UserRow {
  uid: string;
  role: StaffRole;
  email?: string | null;
  name?: string | null;
  hubIds?: string[];
}

/** Admins give staff access to people who have signed up on the website (by their email). */
export function StaffPage() {
  const { db } = getFirebase();
  const { role: myRole, user } = useStaffAuth();
  const staff = useQuery<UserRow>(query(collection(db, 'users'), where('role', 'in', [...STAFF_ROLES])), []);
  const hubs = useQuery<HubDoc>(query(collection(db, 'hubs'), orderBy('code')), []);
  const grantable = STAFF_ROLES.filter((r) => myRole === 'super_admin' || (r !== 'admin' && r !== 'super_admin'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('dispatcher');
  const [hubIds, setHubIds] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function change(target: { email?: string; uid?: string }, newRole: string, hubs: string[] = [], label = '') {
    setBusy(true);
    setMsg(null);
    try {
      await api.setUserRole({ ...target, role: newRole, ...(newRole === 'hub_operator' ? { hubIds: hubs } : {}) });
      setMsg({ ok: true, text: `${label || target.email} is now ${newRole === 'customer' ? 'a customer (staff access removed)' : ROLE_LABEL[newRole as StaffRole]}. They must sign out and in again.` });
      return true;
    } catch (e) {
      const x = e as ApiError;
      setMsg({ ok: false, text: [x.message, ...Object.values(x.fields ?? {})].join(' ') });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function grant(e: FormEvent) {
    e.preventDefault();
    if (await change({ email: email.trim() }, role, hubIds)) {
      setEmail('');
      setHubIds([]);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4">
      <form onSubmit={grant} className="card space-y-3 text-sm">
        <h2 className="text-lg font-semibold">Give someone staff access</h2>
        <p className="text-slate-600">The person first creates an account on the public website with their work email. Staff must set up two-step verification the first time they open this app.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>Their email<input className="input mt-1" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Role
            <select className="input mt-1" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
        </div>
        {role === 'hub_operator' && (
          <fieldset>
            <legend className="mb-1 font-medium">Hubs they work at</legend>
            {hubs.data.length === 0 && <p className="text-slate-500">No hubs yet — add them on the Network page.</p>}
            <div className="flex flex-wrap gap-3">
              {hubs.data.map((h) => (
                <label key={h._id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={hubIds.includes(h._id)} onChange={(e) => setHubIds(e.target.checked ? [...hubIds, h._id] : hubIds.filter((x) => x !== h._id))} />
                  {h.code} · {h.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <button className="btn-primary" disabled={busy}>Give access</button>
        {msg && <p role="status" className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}
      </form>

      <section className="card p-0">
        <h2 className="px-4 pt-3 text-lg font-semibold">Staff</h2>
        {staff.error && <p className="px-4 text-sm text-red-700">{staff.error}</p>}
        <ul className="divide-y divide-slate-100 text-sm">
          {staff.data
            .slice()
            .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))
            .map((u) => {
              const protectedRow = u.uid === user?.uid || ((u.role === 'admin' || u.role === 'super_admin') && myRole !== 'super_admin');
              return (
                <li key={u._id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <span>
                    <span className="font-medium">{u.email ?? u.uid}</span> <span className="text-slate-500">· {ROLE_LABEL[u.role]}{u.hubIds?.length ? ` (${u.hubIds.join(', ')})` : ''}</span>
                  </span>
                  {!protectedRow && (
                    <button className="text-red-600 hover:underline" disabled={busy} onClick={() => confirm(`Remove staff access for ${u.email ?? u.uid}?`) && change({ uid: u.uid }, 'customer', [], u.email ?? u.uid)}>
                      Remove access
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      </section>
    </main>
  );
}
