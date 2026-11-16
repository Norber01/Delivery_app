import type { AddressBookEntry } from '@courier/shared-types';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useState, type FormEvent } from 'react';
import { AddressField } from '../../components/AddressField';
import { scoped } from '../../components/Field';
import { api } from '../../lib/api';
import { getDb } from '../../lib/db';
import { emptyAddress, type AddressDraft } from '../../lib/draft';
import type { ApiError } from '../../lib/errors';

/** The business's regular customers, reusable when booking. */
export function AddressBook({ businessId }: { businessId: string }) {
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addr, setAddr] = useState<AddressDraft>(emptyAddress);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => onSnapshot(query(collection(getDb(), 'sellers', businessId, 'addressBook'), orderBy('label')), (s) => setEntries(s.docs.map((d) => d.data() as AddressBookEntry))), [businessId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.saveAddressEntry({
        label,
        contact: { name, phone },
        address: { line1: addr.line1, city: addr.city, region: addr.region, ...(addr.landmark ? { landmark: addr.landmark } : {}), location: addr.location ?? { lat: NaN, lng: NaN } },
      });
      setAdding(false);
      setLabel('');
      setName('');
      setPhone('');
      setAddr(emptyAddress());
      setErrors({});
      setMsg(null);
    } catch (x) {
      setErrors((x as ApiError).fields);
      setMsg((x as ApiError).message);
    }
  }

  return (
    <section className="space-y-3">
      <p className="text-sm text-slate-600">{entries.length} saved customer address(es).</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {entries.map((e) => (
          <li key={e.id} className="card flex justify-between gap-3 text-sm">
            <div>
              <p className="font-semibold">{e.label}</p>
              <p>{e.contact.name} · {e.contact.phone}</p>
              <p className="text-slate-600">{e.address.line1}, {e.address.city}</p>
            </div>
            <button className="text-red-600 hover:underline" onClick={() => api.deleteAddressEntry({ id: e.id })}>Remove</button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={save} className="space-y-3" noValidate>
          {msg && <p className="text-sm text-red-700">{msg}</p>}
          <div className="card grid gap-3 sm:grid-cols-3">
            <label className="text-sm">Label<input className="input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <label className="text-sm">Customer name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />{errors['contact.name'] && <span className="text-xs text-red-600">{errors['contact.name']}</span>}</label>
            <label className="text-sm">Mobile number<input className="input mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} />{errors['contact.phone'] && <span className="text-xs text-red-600">{errors['contact.phone']}</span>}</label>
          </div>
          <AddressField title="Customer address" value={addr} onChange={setAddr} errors={scoped('address', errors)} />
          <div className="flex gap-2">
            <button className="btn-primary">Save</button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button className="btn-secondary" onClick={() => setAdding(true)}>+ Add customer address</button>
      )}
    </section>
  );
}
