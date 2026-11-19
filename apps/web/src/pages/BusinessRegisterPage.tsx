import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { AddressField } from '../components/AddressField';
import { Field, scoped } from '../components/Field';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { emptyAddress, type AddressDraft } from '../lib/draft';
import type { ApiError } from '../lib/errors';

const toAddress = (a: AddressDraft) => ({
  line1: a.line1,
  city: a.city,
  region: a.region,
  ...(a.landmark ? { landmark: a.landmark } : {}),
  ...(a.ghanaPostGps ? { ghanaPostGps: a.ghanaPostGps } : {}),
  location: a.location ?? { lat: NaN, lng: NaN },
});

/** Upload one document through a signed URL; returns its storage key. */
async function uploadDocument(file: File): Promise<string> {
  const contentType = file.type === 'application/pdf' || file.type.startsWith('image/') ? file.type : 'application/pdf';
  const ticket = await api.requestBusinessDocumentUpload({ contentType, bytes: file.size });
  const res = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ticket.contentType }, body: file });
  if (res.status !== 201) throw new Error(`Upload failed (${res.status}). Try again.`);
  return ticket.key;
}

export function BusinessRegisterPage() {
  const { role, refreshClaims } = useAuth();
  const navigate = useNavigate();
  const [v, setV] = useState({ legalName: '', tradingName: '', registrationNumber: '', tin: '', name: '', phone: '', email: '' });
  const [pickup, setPickup] = useState<AddressDraft>(emptyAddress);
  const [billing, setBilling] = useState<AddressDraft>(emptyAddress);
  const [sameAddress, setSameAddress] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (role === 'business_owner' || role === 'business_staff') return <Navigate to="/business" replace />;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setErrors({});
    try {
      if (files.length === 0) throw Object.assign(new Error('Upload your certificate of registration.'), { fields: { documentKeys: 'Upload your certificate of registration' } });
      const documentKeys: string[] = [];
      for (const f of files) documentKeys.push(await uploadDocument(f));
      await api.registerBusiness({
        legalName: v.legalName,
        tradingName: v.tradingName,
        registrationNumber: v.registrationNumber,
        tin: v.tin,
        contact: { name: v.name, phone: v.phone, ...(v.email ? { email: v.email } : {}) },
        pickupAddress: toAddress(pickup),
        billingAddress: toAddress(sameAddress ? pickup : billing),
        documentKeys,
      });
      await refreshClaims();
      navigate('/business', { replace: true });
    } catch (err) {
      const x = err as ApiError & { fields?: Record<string, string> };
      setErrors(x.fields ?? {});
      setMsg(x.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold">Open a business account</h1>
        <p className="text-slate-600">
          For online sellers, shops and companies: bulk uploads, an address book for your customers, staff logins and monthly reports. Invoice billing on credit is available after verification.
        </p>
      </div>
      {msg && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{msg}</p>}
      <form onSubmit={submit} className="space-y-6" noValidate>
        <fieldset className="card grid gap-4 sm:grid-cols-2">
          <legend className="px-1 font-semibold">Company</legend>
          <Field label="Registered (legal) name" error={errors.legalName}>{(p) => <input {...p} className="input" value={v.legalName} onChange={set('legalName')} />}</Field>
          <Field label="Trading name" error={errors.tradingName}>{(p) => <input {...p} className="input" value={v.tradingName} onChange={set('tradingName')} />}</Field>
          <Field label="Registrar-General number" error={errors.registrationNumber}>{(p) => <input {...p} className="input uppercase" value={v.registrationNumber} onChange={set('registrationNumber')} />}</Field>
          <Field label="GRA TIN" hint="11 characters, e.g. C0012345678" error={errors.tin}>{(p) => <input {...p} className="input uppercase" value={v.tin} onChange={set('tin')} />}</Field>
        </fieldset>
        <fieldset className="card grid gap-4 sm:grid-cols-3">
          <legend className="px-1 font-semibold">Contact person</legend>
          <Field label="Name" error={errors['contact.name']}>{(p) => <input {...p} className="input" value={v.name} onChange={set('name')} />}</Field>
          <Field label="Mobile number" error={errors['contact.phone']}>{(p) => <input {...p} className="input" type="tel" value={v.phone} onChange={set('phone')} />}</Field>
          <Field label="Email" optional error={errors['contact.email']}>{(p) => <input {...p} className="input" type="email" value={v.email} onChange={set('email')} />}</Field>
        </fieldset>
        <AddressField title="Pickup address (where we collect your parcels)" value={pickup} onChange={setPickup} errors={scoped('pickupAddress', errors)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sameAddress} onChange={(e) => setSameAddress(e.target.checked)} /> Billing address is the same
        </label>
        {!sameAddress && <AddressField title="Billing address" value={billing} onChange={setBilling} errors={scoped('billingAddress', errors)} />}
        <fieldset className="card space-y-2">
          <legend className="px-1 font-semibold">Documents</legend>
          <p className="text-sm text-slate-600">Certificate of incorporation or business registration (PDF or photo, up to 8 MB each). Kept private; only our verification team can view them.</p>
          <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple aria-label="Registration documents" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 5))} />
          {errors.documentKeys && <p className="text-xs text-red-600">{errors.documentKeys}</p>}
        </fieldset>
        <button className="btn-primary" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit for verification'}
        </button>
      </form>
    </div>
  );
}
