import type { BusinessDoc } from '@courier/shared-types';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import type { ApiError } from '../../lib/errors';

export function Staff({ business }: { business: BusinessDoc }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const staff = Object.entries(business.staffDirectory ?? {});
  async function invite(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLink(null);
    try {
      setLink((await api.inviteBusinessStaff({ name, email })).setupLink);
      setName('');
      setEmail('');
    } catch (x) {
      setMsg((x as ApiError).message);
    }
  }
  return (
    <section className="space-y-4">
      <p className="text-sm text-slate-600">Staff can book, upload CSVs, use the address book and see reports. Only you can manage staff and see invoices.</p>
      <ul className="card divide-y divide-slate-100 p-0 text-sm">
        {staff.length === 0 && <li className="px-4 py-3 text-slate-500">No staff yet.</li>}
        {staff.map(([uid, s]) => (
          <li key={uid} className="flex items-center justify-between px-4 py-3">
            <span>{s.name} <span className="text-slate-500">· {s.email}</span></span>
            <button className="text-red-600 hover:underline" onClick={() => confirm(`Remove ${s.name}? They will lose access immediately.`) && api.removeBusinessStaff({ uid }).catch((e: ApiError) => setMsg(e.message))}>Remove</button>
          </li>
        ))}
      </ul>
      <form onSubmit={invite} className="card grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="text-sm">Work email<input className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <button className="btn-primary">Invite</button>
        {msg && <p className="text-sm text-red-700 sm:col-span-3">{msg}</p>}
        {link && (
          <p className="break-all rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:col-span-3">
            Send this one-time link to your staff member to set their password: <span className="font-mono">{link}</span>
          </p>
        )}
      </form>
    </section>
  );
}
