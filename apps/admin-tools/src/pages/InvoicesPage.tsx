import { INVOICE_PAYMENT_METHODS } from '@courier/constants';
import type { InvoiceDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

const STATUSES = ['issued', 'partially_paid', 'overdue', 'paid', 'void'] as const;
const LABEL: Record<InvoiceDoc['status'], string> = { issued: 'Issued', partially_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', void: 'Void' };
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** Finance: run invoicing, record payments received, void invoices raised in error. */
export function InvoicesPage() {
  const { db } = getFirebase();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('issued');
  const { data, error } = useQuery<InvoiceDoc>(query(collection(db, 'invoices'), where('status', '==', status), orderBy('issuedAt', 'desc'), limit(200)), [status]);
  const [period, setPeriod] = useState(lastMonth());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<InvoiceDoc | null>(null);
  useEffect(() => {
    setOpen(null);
    if (!openId) return;
    return onSnapshot(doc(db, 'invoices', openId), (s) => setOpen(s.exists() ? (s.data() as InvoiceDoc) : null));
  }, [db, openId]);

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.generateInvoices({ period });
      setMsg({ ok: true, text: r.invoices.length ? `Issued ${r.invoices.length} invoice(s): ${r.invoices.map((i) => i.number).join(', ')}` : 'Nothing to invoice for that month.' });
    } catch (x) {
      setMsg({ ok: false, text: (x as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <form onSubmit={generate} className="card flex flex-wrap items-end gap-3 text-sm">
        <label>Billing month<input className="input mt-1" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
        <button className="btn-primary" disabled={busy}>{busy ? 'Generating…' : 'Generate invoices'}</button>
        <p className="text-slate-500">Runs automatically on the 1st of each month. Safe to re-run: bookings are never invoiced twice.</p>
        {msg && <p role="status" className={`w-full ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
      </form>
      <div className="flex gap-1" role="tablist">
        {STATUSES.map((s) => (
          <button key={s} role="tab" aria-selected={s === status} className={`rounded px-3 py-1.5 text-sm ${s === status ? 'bg-brand-600 text-white' : 'bg-white text-slate-700'}`} onClick={() => setStatus(s)}>
            {LABEL[s]}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr><th className="px-3 py-2">Number</th><th className="px-3 py-2">Business</th><th className="px-3 py-2">Due</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Outstanding</th></tr>
            </thead>
            <tbody>
              {data.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">None.</td></tr>}
              {data.map((i) => (
                <tr key={i._id} className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${i._id === openId ? 'bg-brand-50' : ''}`} onClick={() => setOpenId(i._id)}>
                  <td className="px-3 py-2 font-mono">{i.number}</td>
                  <td className="px-3 py-2">{i.businessName}</td>
                  <td className="px-3 py-2">{i.dueAt.slice(0, 10)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatGhs(i.totalPesewas)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatGhs(i.totalPesewas - i.paidPesewas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {open ? <InvoiceDetail key={open.id} inv={open} /> : <p className="text-sm text-slate-500">Select an invoice.</p>}
      </div>
    </main>
  );
}

function InvoiceDetail({ inv }: { inv: InvoiceDoc }) {
  const outstanding = inv.totalPesewas - inv.paidPesewas;
  const [amount, setAmount] = useState((outstanding / 100).toFixed(2));
  useEffect(() => setAmount((outstanding / 100).toFixed(2)), [outstanding]);
  const [method, setMethod] = useState<(typeof INVOICE_PAYMENT_METHODS)[number]>('bank_transfer');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
  const open = inv.status !== 'paid' && inv.status !== 'void';
  return (
    <section className="card space-y-3 text-sm">
      <header>
        <h2 className="text-lg font-semibold">{inv.number} · {LABEL[inv.status]}</h2>
        <p className="text-slate-600">{inv.businessName} · TIN {inv.tin} · {inv.period}{inv.part > 1 ? ` part ${inv.part}` : ''} · {inv.lines.length} deliveries</p>
        <p>Total {formatGhs(inv.totalPesewas)} · paid {formatGhs(inv.paidPesewas)} · <strong>outstanding {formatGhs(outstanding)}</strong></p>
        {inv.voidReason && <p className="text-slate-600">Void: {inv.voidReason}</p>}
      </header>
      {msg && <p role="status" className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}
      {inv.payments.length > 0 && (
        <ul className="text-slate-600">
          {inv.payments.map((p, i) => <li key={i}>{p.at.slice(0, 10)} · {formatGhs(p.amountPesewas)} · {p.method.replace('_', ' ')} · {p.reference}</li>)}
        </ul>
      )}
      {open && (
        <form
          className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.recordInvoicePayment({ invoiceId: inv.id, amountPesewas: Math.round(Number(amount) * 100), method, reference }), 'Payment recorded.');
          }}
        >
          <h3 className="font-semibold sm:col-span-2">Record payment received</h3>
          <label>Amount (GH₵)<input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label>Method
            <select className="input mt-1" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {INVOICE_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
            </select>
          </label>
          <label className="sm:col-span-2">Bank / MoMo reference<input className="input mt-1" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
          <button className="btn-primary sm:col-span-2">Record payment</button>
        </form>
      )}
      {open && inv.paidPesewas === 0 && (
        <form
          className="flex gap-2 border-t border-slate-100 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirm(`Void ${inv.number}? Its deliveries return to the next invoice run.`)) void run(() => api.voidInvoice({ invoiceId: inv.id, reason }), 'Invoice voided.');
          }}
        >
          <input className="input" placeholder="Reason for voiding" aria-label="Void reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn-secondary">Void</button>
        </form>
      )}
    </section>
  );
}
