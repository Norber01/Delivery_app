import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

const steps = [
  ['Book in a minute', 'Enter the two addresses and what you are sending. You see the full price before you confirm.'],
  ['We pick it up', 'A pickup rider collects the parcel from the sender and brings it to our warehouse.'],
  ['We deliver it', 'A delivery rider takes it to the recipient, who gives a one-time code so we know it reached the right person.'],
] as const;

const reasons = [
  ['Price up front', 'Itemised, no haggling, no surprises at the door.'],
  ['Our own riders', 'Every rider is a verified company rider in uniform.'],
  ['Live tracking', 'Follow the parcel and the rider on the map, with text updates.'],
  ['Proof of delivery', 'A code, signature or photo for every parcel.'],
] as const;

export function HomePage() {
  const navigate = useNavigate();
  const [tn, setTn] = useState('');
  const track = (e: FormEvent) => {
    e.preventDefault();
    const v = tn.trim().toUpperCase().replace(/[\s-]/g, '');
    if (v) navigate(`/track/${v}`);
  };
  return (
    <>
      <section className="bg-accent-400">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-10 md:grid-cols-[1.1fr_1fr] md:py-16">
          <div className="space-y-5">
            <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight text-black md:text-6xl">Courier across the city, today.</h1>
            <p className="max-w-md text-lg text-black/75">Picked up from your door, delivered to theirs. Pay the rider in cash or online.</p>
          </div>
          <div className="card space-y-4 p-6">
            <Link to="/book" className="btn-primary w-full py-4 text-base">
              Send a parcel
            </Link>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="h-px flex-1 bg-slate-200" /> or track one <span className="h-px flex-1 bg-slate-200" />
            </div>
            <form onSubmit={track} className="flex gap-2">
              <input className="input font-mono uppercase placeholder:normal-case" aria-label="Tracking number" placeholder="Tracking number, e.g. GH7K…" value={tn} onChange={(e) => setTn(e.target.value)} />
              <button className="btn-secondary shrink-0">Track</button>
            </form>
            <p className="text-xs text-slate-500">No account needed. Online shops and companies can open a business account for monthly invoicing.</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="mb-6 text-2xl font-bold tracking-tight">How it works</h2>
        <ol className="grid gap-4 md:grid-cols-3">
          {steps.map(([t, b], i) => (
            <li key={t} className="card space-y-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-400 text-lg font-extrabold text-black">{i + 1}</span>
              <h3 className="text-lg font-bold">{t}</h3>
              <p className="text-sm text-slate-600">{b}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {reasons.map(([t, b]) => (
            <div key={t} className="rounded-2xl bg-white/60 p-5">
              <h3 className="font-bold">{t}</h3>
              <p className="mt-1 text-sm text-slate-600">{b}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-brand-600 p-6 text-white">
          <div>
            <p className="text-lg font-bold">Selling online?</p>
            <p className="text-sm text-white/70">Upload many orders at once and pay one invoice a month.</p>
          </div>
          <Link to="/business/register" className="btn-accent">
            Open a business account
          </Link>
        </div>
      </section>
    </>
  );
}
