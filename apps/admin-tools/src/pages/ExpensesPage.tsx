import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '@courier/constants';
import type { ExpenseDoc, HubDoc, VehicleDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { canManageInvoices, useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';
import { cedis, openEvidence, uploadReceipt } from '../lib/receipt';
import { useQuery } from '../lib/useLive';

const STATUS_LABEL = { submitted: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected' } as const;
const CATEGORY_LABEL: Record<string, string> = { fuel: 'Fuel', maintenance: 'Maintenance', driver_payment: 'Driver pay', hub: 'Hub', other: 'Other' };

/** Fleet and finance record costs; finance approves them (never their own). Approved costs feed the reports. */
export function ExpensesPage() {
  const { db } = getFirebase();
  const { role, user } = useStaffAuth();
  const isFinance = canManageInvoices(role);
  const [status, setStatus] = useState<(typeof EXPENSE_STATUSES)[number]>('submitted');
  const list = useQuery<ExpenseDoc>(query(collection(db, 'expenses'), where('status', '==', status), orderBy('incurredAt', 'desc'), limit(200)), [status]);
  const vehicles = useQuery<VehicleDoc>(query(collection(db, 'vehicles'), orderBy('registrationNumber')), []);
  const hubs = useQuery<HubDoc>(query(collection(db, 'hubs'), orderBy('code')), []);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const total = list.data.reduce((n, e) => n + e.amountPesewas, 0);

  async function run(f: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      const x = e as ApiError;
      setMsg({ ok: false, text: [x.message, ...Object.values(x.fields ?? {})].join(' ') });
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-bold">Expenses</h1>
      <NewExpense vehicles={vehicles.data} hubs={hubs.data} onDone={(t) => setMsg(t)} />
      <div className="flex flex-wrap items-center gap-1" role="tablist">
        {EXPENSE_STATUSES.map((s) => (
          <button key={s} role="tab" aria-selected={s === status} className={`rounded px-3 py-1.5 text-sm ${s === status ? 'bg-brand-600 text-white' : 'bg-white text-slate-700'}`} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </button>
        ))}
        <span className="ml-auto text-sm text-slate-600">{list.data.length} · {formatGhs(total)}</span>
      </div>
      {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      {list.error && <p className="text-sm text-red-700">{list.error}</p>}
      <ul className="space-y-2">
        {list.data.length === 0 && <li className="card text-sm text-slate-500">Nothing here.</li>}
        {list.data.map((e) => (
          <li key={e.id} className="card flex flex-wrap items-start gap-3 text-sm" aria-label={`Expense ${e.description}`}>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{e.description}</p>
              <p className="text-slate-500">
                {CATEGORY_LABEL[e.category]} · {e.incurredAt.slice(0, 10)}
                {e.vehicleId && ` · ${vehicles.data.find((v) => v.id === e.vehicleId)?.registrationNumber ?? e.vehicleId}`}
                {e.hubId && ` · ${hubs.data.find((h) => h.id === e.hubId)?.code ?? e.hubId}`}
                {e.reviewNote && ` · ${e.reviewNote}`}
              </p>
              {e.receiptKey && (
                <button className="text-brand-700 hover:underline" onClick={() => openEvidence(e.receiptKey!).catch((x: ApiError) => setMsg({ ok: false, text: x.message }))}>
                  View receipt
                </button>
              )}
            </div>
            <p className="text-base font-semibold tabular-nums">{formatGhs(e.amountPesewas)}</p>
            {isFinance && e.status === 'submitted' && (
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                {e.submittedBy === user?.uid ? (
                  <span className="text-xs text-slate-500">You submitted this — another finance user must review it.</span>
                ) : (
                  <>
                    <input className="input w-48 py-1" placeholder="Reason (to reject)" aria-label="Review note" value={notes[e.id] ?? ''} onChange={(x) => setNotes({ ...notes, [e.id]: x.target.value })} />
                    <button className="btn-primary py-1" onClick={() => run(() => api.reviewExpense({ expenseId: e.id, decision: 'approved' }), 'Approved.')}>Approve</button>
                    <button className="btn-secondary py-1" onClick={() => run(() => api.reviewExpense({ expenseId: e.id, decision: 'rejected', note: notes[e.id] }), 'Rejected.')}>Reject</button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

function NewExpense({ vehicles, hubs, onDone }: { vehicles: VehicleDoc[]; hubs: HubDoc[]; onDone: (m: { ok: boolean; text: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ category: 'hub', description: '', amount: '', vehicleId: '', hubId: '', date: new Date().toISOString().slice(0, 10) });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="btn-secondary" onClick={() => setOpen(true)}>+ Record an expense</button>;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const receiptKey = file ? await uploadReceipt(file) : undefined;
      await api.submitExpense({
        category: v.category,
        description: v.description,
        amountPesewas: cedis(v.amount || '0'),
        ...(v.vehicleId ? { vehicleId: v.vehicleId } : {}),
        ...(v.hubId ? { hubId: v.hubId } : {}),
        incurredAt: new Date(`${v.date}T12:00:00Z`).toISOString(),
        ...(receiptKey ? { receiptKey } : {}),
      });
      onDone({ ok: true, text: 'Expense recorded and sent for approval.' });
      setOpen(false);
      setV({ ...v, description: '', amount: '' });
      setFile(null);
    } catch (x) {
      const err = x as ApiError;
      onDone({ ok: false, text: [err.message, ...Object.values(err.fields ?? {})].join(' ') });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="card grid gap-3 text-sm sm:grid-cols-3">
      <label>Category
        <select className="input mt-1" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>
          {EXPENSE_CATEGORIES.filter((c) => c !== 'driver_payment').map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </select>
      </label>
      <label>Amount (GH₵)<input className="input mt-1" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></label>
      <label>Date<input className="input mt-1" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>
      <label className="sm:col-span-3">Description<input className="input mt-1" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
      <label>Vehicle
        <select className="input mt-1" value={v.vehicleId} onChange={(e) => setV({ ...v, vehicleId: e.target.value })}>
          <option value="">—</option>
          {vehicles.map((x) => <option key={x.id} value={x.id}>{x.registrationNumber}</option>)}
        </select>
      </label>
      <label>Hub
        <select className="input mt-1" value={v.hubId} onChange={(e) => setV({ ...v, hubId: e.target.value })}>
          <option value="">—</option>
          {hubs.map((h) => <option key={h.id} value={h.id}>{h.code} · {h.name}</option>)}
        </select>
      </label>
      <label>Receipt<input className="mt-1 block" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <div className="flex gap-2 sm:col-span-3">
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Submit for approval'}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
