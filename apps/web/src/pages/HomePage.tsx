import { Link } from 'react-router';

const services = [
  {
    title: 'Same-city delivery',
    body: 'Motorbikes, cars and vans for fast pickups and drop-offs within the city — standard, express or same-day.',
  },
  {
    title: 'Intercity delivery',
    body: 'Scheduled departures between major cities through our own hubs, with final-mile delivery to the door.',
  },
  {
    title: 'Long-distance delivery',
    body: 'Dedicated company vehicles for destinations outside our hub network, priced by distance.',
  },
];

const steps = [
  ['Enter addresses', 'Tell us where to collect and where to deliver.'],
  ['Describe the package', 'Weight, size and any special handling.'],
  ['Get an instant price', 'Transparent, itemised pricing — no surprises.'],
  ['Confirm and track', 'Receive a tracking number straight away.'],
];

export function HomePage() {
  return (
    <>
      <section className="bg-gradient-to-br from-brand-700 to-brand-500 text-white">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-2 md:py-24">
          <div className="space-y-6">
            <h1 className="text-4xl font-bold leading-tight md:text-5xl">Reliable deliveries across Ghana.</h1>
            <p className="text-lg text-brand-50">
              Our own drivers, our own vehicles, our own hubs. One team responsible for your package from pickup to delivery.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to="/book" className="btn bg-white text-brand-700 hover:bg-brand-50">
                Get a price &amp; book
              </Link>
            </div>
            <p className="text-sm text-brand-100">No account needed. Individuals, online sellers and businesses welcome.</p>
          </div>
          <ul className="grid gap-3 self-center text-sm">
            {['Itemised, upfront pricing', 'Verified company drivers', 'Proof of delivery on every package', 'Hub-to-hub custody tracking'].map(
              (t) => (
                <li key={t} className="flex items-center gap-3 rounded-lg bg-white/10 px-4 py-3">
                  <span aria-hidden className="text-accent-400">
                    ✓
                  </span>
                  {t}
                </li>
              ),
            )}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="mb-6 text-2xl font-bold">Our services</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {services.map((s) => (
            <article key={s.title} className="card">
              <h3 className="mb-2 font-semibold text-brand-700">{s.title}</h3>
              <p className="text-sm text-slate-600">{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 className="mb-6 text-2xl font-bold">How booking works</h2>
          <ol className="grid gap-4 md:grid-cols-4">
            {steps.map(([t, b], i) => (
              <li key={t} className="space-y-2">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 font-bold text-brand-700">{i + 1}</span>
                <h3 className="font-semibold">{t}</h3>
                <p className="text-sm text-slate-600">{b}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
