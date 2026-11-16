import type { BusinessDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import { api, type ApiError } from '../lib/api';
import { canReviewBusinesses, useStaffAuth } from '../lib/auth';
import { getFirebase } from '../lib/firebase';
import { useQuery } from '../lib/useLive';

const STATUSES = ['pending', 'verified', 'rejected', 'suspended'] as const;

/** Business verification (admin) and credit / contract pricing (finance). */
export function BusinessesPage() {
  const { db } = getFirebase();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const { data, error } = useQuery<BusinessDoc>(query(collection(db, 'sellers'), where('verificationStatus', '==', status), orderBy('legalName')), [status]);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = data.find((b) => b._id === openId) ?? null;
  return (
    <main className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[1fr_1.2fr]">
      <section className="space-y-3">
        <div className="flex gap-1" role="tablist">
          {STATUSES.map((s) => (
            <button key={s} role="tab" aria-selected={s === status} className={`rounded px-3 py-1.5 text-sm capitalize ${s === status ? 'bg-brand-600 text-white' : 'bg-white text-slate-700'}`} onClick={() => setStatus(s)}>
              {s}
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <ul className="card divide-y divide-slate-100 p-0">
          {data.length === 0 && <li className="px-4 py-3 text-sm text-slate-500">No {status} businesses.</li>}
          {data.map((b) => (
            <li key={b._id}>
              <button className={`w-full px-4 py-3 text-left text-sm hover:bg-slate-50 ${b._id === openId ? 'bg-brand-50' : ''}`} onClick={() => setOpenId(b._id)}>
                <span className="font-semibold">{b.legalName}</span> <span className="text-slate-500">· {b.tradingName}</span>
                <span className="block text-xs text-slate-500">
                  TIN {b.tin} · {b.pickupAddress.city}
                  {b.creditTerms ? ` · credit ${formatGhs(b.creditUsedPesewas)} / ${formatGhs(b.creditTerms.limitPesewas)}` : ''}
                  {b.hasOverdueInvoices ? ' · OVERDUE' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {open ? <BusinessDetail key={open._id} b={open} /> : <p className="text-sm text-slate-500">Select a business.</p>}
    </main>
  );
}

function BusinessDetail({ b }: { b: BusinessDoc }) {
  const { role } = useStaffAuth();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(b.creditTerms ? String(b.creditTerms.limitPesewas / 100) : '');
  const [termDays, setTermDays] = useState(String(b.creditTerms?.termDays ?? 30));
  const [discount, setDiscount] = useState(String(b.contractDiscountPercent || ''));
  const [validTo, setValidTo] = useState('');

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
  async function openDoc(key: string) {
    const w = window.open('', '_blank');
    try {
      const { url } = await api.getEvidenceUrl(key);
      if (w) w.location.href = url;
    } catch (e) {
      w?.close();
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  }
  const review = (decision: 'verified' | 'rejected' | 'suspended') => run(() => api.reviewBusiness({ businessId: b.id, decision, ...(note ? { note } : {}) }), `Marked ${decision}.`);
  const saveCredit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.setCreditTerms({ businessId: b.id, limitPesewas: Math.round(Number(limit || 0) * 100), termDays: Number(termDays) }), 'Credit terms saved.');
  };
  const saveContract = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () => api.setContractPricing({ businessId: b.id, discountPercent: Number(discount || 0), validFrom: new Date().toISOString(), validTo: validTo ? new Date(`${validTo}T23:59:59Z`).toISOString() : '' }),
      'Contract pricing saved.',
    );
  };

  return (
    <section className="card space-y-4 text-sm">
      <header>
        <h2 className="text-lg font-semibold">{b.legalName}</h2>
        <p className="text-slate-600">Trading as {b.tradingName} · Reg. {b.registrationNumber} · TIN {b.tin}</p>
        <p className="text-slate-600">{b.contact.name} · {b.contact.phone}{b.contact.email ? ` · ${b.contact.email}` : ''}</p>
        <p className="text-slate-600">Pickup: {b.pickupAddress.line1}, {b.pickupAddress.city} · Staff: {b.staffUids.length}</p>
        {b.verificationNote && <p className="mt-1 text-amber-800">Note: {b.verificationNote}</p>}
      </header>
      {msg && <p role="status" className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</p>}

      <div>
        <h3 className="mb-1 font-semibold">Documents</h3>
        <div className="flex flex-wrap gap-2">
          {b.documentKeys.map((k, i) => (
            <button key={k} className="btn-secondary py-1" onClick={() => openDoc(k)}>Document {i + 1}</button>
          ))}
        </div>
      </div>

      {canReviewBusinesses(role) && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h3 className="font-semibold">Verification</h3>
          <input className="input" placeholder="Note (required to reject or suspend)" aria-label="Verification note" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            {b.verificationStatus !== 'verified' && <button className="btn-primary py-1" onClick={() => review('verified')}>Verify</button>}
            {b.verificationStatus === 'pending' && <button className="btn-secondary py-1" onClick={() => review('rejected')}>Reject</button>}
            {b.verificationStatus === 'verified' && <button className="btn-secondary py-1" onClick={() => review('suspended')}>Suspend</button>}
          </div>
        </div>
      )}

      {b.verificationStatus === 'verified' && (
        <>
          <form onSubmit={saveCredit} className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <h3 className="font-semibold sm:col-span-3">
              Credit (invoice billing){' '}
              <span className="font-normal text-slate-500">— used {formatGhs(b.creditUsedPesewas)}{b.creditTerms ? `, approved ${b.creditTerms.approvedAt.slice(0, 10)}` : ', none approved'}</span>
            </h3>
            <label>Limit (GH₵, 0 removes)<input className="input mt-1" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
            <label>Payment terms (days)<input className="input mt-1" inputMode="numeric" value={termDays} onChange={(e) => setTermDays(e.target.value)} /></label>
            <button className="btn-primary">Save credit</button>
          </form>
          <form onSubmit={saveContract} className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <h3 className="font-semibold sm:col-span-3">Contract pricing <span className="font-normal text-slate-500">— current discount {b.contractDiscountPercent}%</span></h3>
            <label>Discount %<input className="input mt-1" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>
            <label>Valid until<input className="input mt-1" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></label>
            <button className="btn-primary">Save contract</button>
          </form>
        </>
      )}
    </section>
  );
}
