import { PAYOUT_METHODS } from '@courier/constants';
import type { DriverCashLedger, DriverDoc, DriverPayRules, DriverPayStatement } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { cedis, lastMonth } from '../lib/receipt';
import { useQuery } from '../lib/useLive';

type Msg = { ok: boolean; text: string } | null;
const STATUS = { draft: 'Draft', approved: 'Approved', paid: 'Paid' } as const;
const errText = (e: unknown) => {
  const x = e as ApiError;
  return [x.message, ...Object.values(x.fields ?? {})].join(' ');
};

export function DriverPayPage() {
  const [tab, setTab] = useState<'statements' | 'cash' | 'rates'>('statements');
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-bold">Driver pay & cash</h1>
      <div className="flex gap-1" role="tablist">
        {([['statements', 'Monthly statements'], ['cash', 'Cash held by drivers'], ['rates', 'Pay rates']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`rounded px-3 py-1.5 text-sm ${tab === k ? 'bg-brand-600 text-white' : 'bg-white text-slate-700'}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'statements' && <Statements />}
      {tab === 'cash' && <Cash />}
      {tab === 'rates' && <Rates />}
    </main>
  );
}

function Statements() {
  const { db } = getFirebase();
  const [period, setPeriod] = useState(lastMonth());
  const list = useQuery<DriverPayStatement>(query(collection(db, 'driverPayments'), where('period', '==', period), orderBy('driverName')), [period]);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.generateDriverPay(period);
      setMsg({ ok: true, text: `${r.saved} draft statement(s) prepared${r.final ? `, ${r.final} already approved/paid left unchanged` : ''}.` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }
  const total = list.data.reduce((n, s) => n + s.grossPesewas, 0);
  return (
    <section className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3 text-sm">
        <label>Month<input className="input mt-1" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button className="btn-primary" onClick={generate} disabled={busy}>{busy ? 'Calculating…' : 'Prepare statements'}</button>
        <p className="text-slate-500">From shifts, completed jobs and linehaul trips. Safe to repeat; approved and paid statements never change.</p>
        {msg && <p role="status" className={`w-full ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      </div>
      {list.error && <p className="text-sm text-red-700">{list.error}</p>}
      {list.data.length > 0 && <p className="text-sm text-slate-600">{list.data.length} driver(s) · total {formatGhs(total)}</p>}
      {list.data.map((s) => <Statement key={s.id} s={s} />)}
    </section>
  );
}

function Statement({ s }: { s: DriverPayStatement }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [adj, setAdj] = useState({ label: '', amount: '' });
  const [pay, setPay] = useState({ method: 'mobile_money', reference: '' });
  async function run(f: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await f();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }
  return (
    <article className="card space-y-2 text-sm" aria-label={`Statement ${s.driverName}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{s.driverName}</h3>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.status === 'paid' ? 'bg-green-100 text-green-800' : s.status === 'approved' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'}`}>{STATUS[s.status]}</span>
      </header>
      <table className="w-full">
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.label}><td>{l.label}</td><td className="text-right tabular-nums">{l.quantity} × {formatGhs(l.ratePesewas)}</td><td className="w-28 text-right tabular-nums">{formatGhs(l.amountPesewas)}</td></tr>
          ))}
          {s.adjustments.map((a, i) => (
            <tr key={i} className="text-slate-600"><td colSpan={2}>{a.label}</td><td className="text-right tabular-nums">{formatGhs(a.amountPesewas)}</td></tr>
          ))}
          <tr className="border-t border-slate-200 font-semibold"><td colSpan={2}>Total</td><td className="text-right tabular-nums">{formatGhs(s.grossPesewas)}</td></tr>
        </tbody>
      </table>
      <p className="text-xs text-slate-500">
        {s.daysWorked} day(s) · {s.kmDriven} km
        {s.cashOutstandingPesewas > 0 && <span className="text-amber-700"> · still holds {formatGhs(s.cashOutstandingPesewas)} customer cash</span>}
        {s.payout && ` · paid by ${s.payout.method.replace('_', ' ')} (${s.payout.reference})`}
      </p>
      {msg && <p role="status" className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}
      {s.status === 'draft' && (
        <div className="flex flex-wrap gap-2">
          <input className="input w-56 py-1" placeholder="Bonus or deduction (e.g. Fuel advance)" aria-label="Adjustment label" value={adj.label} onChange={(e) => setAdj({ ...adj, label: e.target.value })} />
          <input className="input w-32 py-1" placeholder="GH₵ (− to deduct)" aria-label="Adjustment amount" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} />
          <button className="btn-secondary py-1" onClick={() => run(() => api.adjustDriverPay({ statementId: s.id, label: adj.label, amountPesewas: cedis(adj.amount || '0') }), 'Adjustment added.')}>Add</button>
          <button className="btn-primary py-1" onClick={() => run(() => api.approveDriverPay(s.id), 'Approved.')}>Approve</button>
        </div>
      )}
      {s.status === 'approved' && (
        <div className="flex flex-wrap gap-2">
          <select className="input w-40 py-1" aria-label="Payout method" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
            {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
          <input className="input w-48 py-1" placeholder="Transaction reference" aria-label="Payout reference" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
          <button className="btn-primary py-1" onClick={() => run(() => api.markDriverPaid({ statementId: s.id, ...pay }), 'Marked as paid.')}>Mark paid</button>
        </div>
      )}
    </article>
  );
}

function Cash() {
  const { db } = getFirebase();
  const drivers = useQuery<DriverDoc>(query(collection(db, 'drivers'), orderBy('name')), []);
  const ledgers = useQuery<DriverCashLedger>(collection(db, 'driverCash'), []);
  const [form, setForm] = useState({ driverUid: '', amount: '', method: 'cash', reference: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const rows = drivers.data.map((d) => {
    const l = ledgers.data.find((x) => x._id === d.uid);
    return { d, held: (l?.collectedPesewas ?? 0) - (l?.remittedPesewas ?? 0), collected: l?.collectedPesewas ?? 0 };
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.recordCashRemittance({ driverUid: form.driverUid, amountPesewas: cedis(form.amount || '0'), method: form.method, reference: form.reference });
      setMsg({ ok: true, text: 'Hand-in recorded.' });
      setForm({ ...form, amount: '', reference: '' });
    } catch (x) {
      setMsg({ ok: false, text: errText(x) });
    }
  }
  return (
    <section className="space-y-3">
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-3 py-2">Driver</th><th className="px-3 py-2 text-right">Collected (all time)</th><th className="px-3 py-2 text-right">Still holding</th></tr></thead>
          <tbody>
            {rows.map(({ d, held, collected }) => (
              <tr key={d.uid} className="border-t border-slate-100">
                <td className="px-3 py-2">{d.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatGhs(collected)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${held > 0 ? 'font-semibold text-amber-700' : ''}`}>{formatGhs(held)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit} className="card grid gap-3 text-sm sm:grid-cols-4 sm:items-end">
        <h3 className="font-semibold sm:col-span-4">Record cash handed in</h3>
        <label>Driver
          <select className="input mt-1" value={form.driverUid} onChange={(e) => setForm({ ...form, driverUid: e.target.value })}>
            <option value="">Choose…</option>
            {rows.filter((r) => r.held > 0).map(({ d, held }) => <option key={d.uid} value={d.uid}>{d.name} ({formatGhs(held)})</option>)}
          </select>
        </label>
        <label>Amount (GH₵)<input className="input mt-1" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        <label>How
          <select className="input mt-1" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label>Reference<input className="input mt-1" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label>
        <button className="btn-primary sm:col-span-4 sm:w-40">Record</button>
        {msg && <p role="status" className={`sm:col-span-4 ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      </form>
    </section>
  );
}

function Rates() {
  const { db } = getFirebase();
  const [rules, setRules] = useState<DriverPayRules | null>(null);
  const [v, setV] = useState({ daily: '', direct: '', first: '', last: '', linehaul: '' });
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(
    () =>
      onSnapshot(doc(db, 'config', 'driverPay'), (s) => {
        const r = s.exists() ? (s.data() as DriverPayRules) : null;
        setRules(r);
        if (r) {
          const c = (p: number) => (p / 100).toFixed(2);
          setV({ daily: c(r.dailyRatePesewas), direct: c(r.perJobPesewas.direct), first: c(r.perJobPesewas.first_mile), last: c(r.perJobPesewas.last_mile), linehaul: c(r.perLinehaulTripPesewas) });
        }
      }),
    [db],
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api.setDriverPayRules({
        dailyRatePesewas: cedis(v.daily || '0'),
        perJobPesewas: { direct: cedis(v.direct || '0'), first_mile: cedis(v.first || '0'), last_mile: cedis(v.last || '0') },
        perLinehaulTripPesewas: cedis(v.linehaul || '0'),
      });
      setMsg({ ok: true, text: 'Pay rates saved. They apply the next time statements are prepared.' });
    } catch (x) {
      setMsg({ ok: false, text: errText(x) });
    }
  }
  const field = (k: keyof typeof v, label: string) => <label>{label}<input className="input mt-1" inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>;
  return (
    <form onSubmit={save} className="card grid gap-3 text-sm sm:grid-cols-3">
      {field('daily', 'Per day worked (GH₵)')}
      {field('direct', 'Per same-city delivery')}
      {field('first', 'Per collection to hub')}
      {field('last', 'Per delivery from hub')}
      {field('linehaul', 'Per intercity linehaul trip')}
      <p className="text-xs text-slate-500 sm:col-span-3">Drivers can see these rates in their app. {rules && `Last changed ${rules.updatedAt.slice(0, 10)}.`}</p>
      <button className="btn-primary sm:w-40">Save rates</button>
      {msg && <p role="status" className={`sm:col-span-3 ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
    </form>
  );
}
