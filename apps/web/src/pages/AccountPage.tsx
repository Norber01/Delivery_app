import type { BookingListItem } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { MAX_SAVED_ADDRESSES, savedAddressSchema, issuesToFieldErrors, type NotificationPrefs, type SavedAddress } from '@courier/validation';
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, setDoc, where, type Timestamp } from 'firebase/firestore';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { AddressField } from '../components/AddressField';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { emptyAddress, type AddressDraft } from '../lib/draft';
import type { ApiError } from '../lib/errors';
import { getFirebase } from '../lib/firebase';
import { BOOKING_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '../lib/labels';

const DEFAULT_PREFS: NotificationPrefs = { smsBookingUpdates: true, smsPaymentReceipts: true };

export function AccountPage() {
  const { user, signOut } = useAuth();
  const [bookings, setBookings] = useState<BookingListItem[] | null>(null);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [error, setError] = useState<string | null>(null);
  const uid = user!.uid;

  const loadBookings = async () => {
    const { db } = getFirebase();
    const snap = await getDocs(query(collection(db, 'deliveryRequests'), where('customerUid', '==', uid), orderBy('createdAt', 'desc'), limit(50)));
    setBookings(
      snap.docs.map((d) => {
        const b = d.data();
        return {
          trackingNumber: d.id,
          createdAt: (b.createdAt as Timestamp | undefined)?.toDate().toISOString() ?? '',
          status: b.status,
          paymentStatus: b.paymentStatus,
          deliveryType: b.deliveryType,
          originCity: b.pickup.city,
          destinationCity: b.destination.city,
          recipientName: b.recipient.name,
          totalPesewas: b.price.totalPesewas,
        };
      }),
    );
  };

  useEffect(() => {
    loadBookings().catch(() => setError('Could not load your bookings.'));
    const { db } = getFirebase();
    return onSnapshot(doc(db, 'customers', uid), (snap) => {
      setAddresses((snap.get('savedAddresses') as SavedAddress[] | undefined) ?? []);
      setPrefs({ ...DEFAULT_PREFS, ...(snap.get('notificationPrefs') as Partial<NotificationPrefs> | undefined) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  /** Resolves only once the server has accepted the write; reports failures. */
  const saveProfile = async (patch: { savedAddresses?: SavedAddress[]; notificationPrefs?: NotificationPrefs }) => {
    try {
      setError(null);
      await setDoc(doc(getFirebase().db, 'customers', uid), patch, { merge: true });
      return true;
    } catch {
      setError('Could not save your changes. Please try again.');
      return false;
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">My account</h1>
          <p className="text-slate-600">{user!.displayName ?? user!.email ?? user!.phoneNumber}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/book" className="btn-primary">
            New booking
          </Link>
          <button className="btn-secondary" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">My bookings</h2>
        {bookings === null ? (
          <p className="text-slate-500">Loading…</p>
        ) : bookings.length === 0 ? (
          <p className="card text-slate-600">No bookings yet.</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Tracking</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Route</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.trackingNumber} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <Link className="font-mono text-brand-700 hover:underline" to={`/track/${b.trackingNumber}`}>
                        {b.trackingNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{b.createdAt ? new Date(b.createdAt).toLocaleDateString('en-GH') : '—'}</td>
                    <td className="px-4 py-3">
                      {b.originCity} → {b.destinationCity}
                      <span className="block text-xs text-slate-500">to {b.recipientName}</span>
                    </td>
                    <td className="px-4 py-3">
                      {BOOKING_STATUS_LABEL[b.status]}
                      <span className="block text-xs text-slate-500">{PAYMENT_STATUS_LABEL[b.paymentStatus]}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatGhs(b.totalPesewas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ClaimBookingForm onClaimed={() => loadBookings()} />
      </section>

      <SavedAddresses addresses={addresses} onChange={(savedAddresses) => saveProfile({ savedAddresses })} />

      <section className="card space-y-3">
        <h2 className="text-xl font-semibold">Notifications</h2>
        {(
          [
            ['smsBookingUpdates', 'SMS updates about my bookings'],
            ['smsPaymentReceipts', 'SMS payment and refund confirmations'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              checked={prefs[k]}
              onChange={(e) => saveProfile({ notificationPrefs: { ...prefs, [k]: e.target.checked } })}
            />
            {label}
          </label>
        ))}
        <p className="text-xs text-slate-500">
          Messages go to the sender's phone number on each booking. Essential messages (such as delivery codes) are always sent.
        </p>
      </section>
    </div>
  );
}

function ClaimBookingForm({ onClaimed }: { onClaimed: () => void }) {
  const [open, setOpen] = useState(false);
  const [tn, setTn] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="text-sm text-brand-700 hover:underline" onClick={() => setOpen(true)}>
        Add a booking you made as a guest
      </button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.claimBooking({ trackingNumber: tn.trim(), accessToken: code.trim() });
      setTn('');
      setCode('');
      setMsg('Booking added to your account.');
      onClaimed();
    } catch (err) {
      setMsg((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <label className="text-sm">
        Tracking number
        <input className="input mt-1" value={tn} onChange={(e) => setTn(e.target.value)} />
      </label>
      <label className="text-sm">
        Access code
        <input className="input mt-1 font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <button className="btn-primary" disabled={busy}>
        Add booking
      </button>
      {msg && <p className="text-sm text-slate-600 sm:col-span-3">{msg}</p>}
    </form>
  );
}

function SavedAddresses({ addresses, onChange }: { addresses: SavedAddress[]; onChange: (a: SavedAddress[]) => Promise<boolean> }) {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [draft, setDraft] = useState<AddressDraft>(emptyAddress);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const candidate = {
      label,
      line1: draft.line1,
      line2: draft.line2 || undefined,
      city: draft.city,
      region: draft.region,
      landmark: draft.landmark || undefined,
      ghanaPostGps: draft.ghanaPostGps || undefined,
      location: draft.location ?? { lat: NaN, lng: NaN },
    };
    const parsed = savedAddressSchema.safeParse(candidate);
    if (!parsed.success) return setErrors(issuesToFieldErrors(parsed.error));
    // Firestore rejects undefined values; drop them.
    const clean = JSON.parse(JSON.stringify(parsed.data)) as SavedAddress;
    setSaving(true);
    const ok = await onChange([...addresses, clean].slice(0, MAX_SAVED_ADDRESSES));
    setSaving(false);
    if (!ok) return;
    setAdding(false);
    setLabel('');
    setDraft(emptyAddress());
    setErrors({});
  };

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Saved addresses</h2>
      {addresses.length === 0 && !adding && <p className="text-sm text-slate-600">Save addresses you use often to book faster.</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {addresses.map((a, i) => (
          <li key={`${a.label}-${i}`} className="card flex items-start justify-between gap-3">
            <div className="text-sm">
              <p className="font-semibold">{a.label}</p>
              <p className="text-slate-600">{a.line1}</p>
              <p className="text-slate-500">
                {a.city}, {a.region}
              </p>
            </div>
            <button className="text-sm text-red-600 hover:underline" onClick={() => onChange(addresses.filter((_, j) => j !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={add} className="space-y-3" noValidate>
          <label className="block text-sm font-medium">
            Label (e.g. Home, Shop)
            <input className="input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} />
            {errors.label && <span className="text-xs text-red-600">{errors.label}</span>}
          </label>
          <AddressField title="New address" value={draft} onChange={setDraft} errors={errors} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save address'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        addresses.length < MAX_SAVED_ADDRESSES && (
          <button className="btn-secondary" onClick={() => setAdding(true)}>
            + Add address
          </button>
        )
      )}
    </section>
  );
}
