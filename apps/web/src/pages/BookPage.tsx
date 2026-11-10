import { SPECIAL_HANDLING, type PaymentPreference, type SpecialHandling, type Urgency } from '@courier/constants';
import type { CreateBookingResponse, QuoteResponse } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { addressSchema, contactSchema, issuesToFieldErrors, quoteRequestSchema, type QuoteRequestInput } from '@courier/validation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { AddressField } from '../components/AddressField';
import { Field, scoped } from '../components/Field';
import { PackagesEditor } from '../components/PackagesEditor';
import { PriceBreakdown } from '../components/PriceBreakdown';
import { api } from '../lib/api';
import { ApiError, QUOTE_INVALIDATING_CODES } from '../lib/errors';
import { contactToInput, draftToQuoteRequest, initialDraft, type BookingDraft, type ContactDraft } from '../lib/draft';

type Step = 'route' | 'packages' | 'quote' | 'details' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'route', label: 'Addresses' },
  { id: 'packages', label: 'Package' },
  { id: 'quote', label: 'Price' },
  { id: 'details', label: 'Contacts' },
  { id: 'done', label: 'Booked' },
];

const URGENCY_OPTIONS: { value: Urgency; label: string; hint: string }[] = [
  { value: 'standard', label: 'Standard', hint: 'Best value' },
  { value: 'express', label: 'Express', hint: 'Priority dispatch' },
  { value: 'same_day', label: 'Same day', hint: 'Within the same city only' },
];

const HANDLING_LABEL: Record<SpecialHandling, string> = {
  fragile: 'Fragile',
  perishable: 'Perishable (food etc.)',
  high_value: 'High value',
  documents: 'Documents',
  liquid: 'Contains liquid',
};

const PAYMENT_OPTIONS: { value: PaymentPreference; label: string; hint: string }[] = [
  { value: 'cash_on_pickup', label: 'Pay the driver at pickup', hint: 'Cash or Mobile Money to the driver when your package is collected.' },
  {
    value: 'mobile_money',
    label: 'Mobile Money (before pickup)',
    hint: 'Our team will send you a payment request. Your booking is confirmed once payment is verified.',
  },
  {
    value: 'card',
    label: 'Card (before pickup)',
    hint: 'Our team will send you a secure payment link. Your booking is confirmed once payment is verified.',
  },
];

interface Quoted {
  key: string;
  request: QuoteRequestInput;
  response: QuoteResponse;
}

const keyOf = (r: QuoteRequestInput) => JSON.stringify(r);

export function BookPage() {
  const [step, setStep] = useState<Step>('route');
  const [draft, setDraft] = useState<BookingDraft>(initialDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [booking, setBooking] = useState<CreateBookingResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const request = useMemo(() => draftToQuoteRequest(draft), [draft]);
  const quoteIsCurrent = quoted !== null && quoted.key === keyOf(request);
  const msLeft = quoted ? new Date(quoted.response.expiresAt).getTime() - now : 0;

  useEffect(() => {
    if (step !== 'quote' && step !== 'details') return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [step]);

  useEffect(() => {
    // Braces matter: scrollTo returns a Promise in newer browsers, which must not be returned as a cleanup.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  // Editing clears stale validation errors; they are recomputed on the next submit.
  const patch = (p: Partial<BookingDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setErrors((e) => (Object.keys(e).length ? {} : e));
  };
  const go = (s: Step) => {
    setErrors({});
    setFormError(null);
    setStep(s);
  };

  function submitRoute(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const key of ['pickup', 'destination'] as const) {
      const r = addressSchema.safeParse(request[key]);
      if (!r.success) for (const [k, v] of Object.entries(issuesToFieldErrors(r.error))) errs[`${key}.${k}`] = v;
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0) go('packages');
  }

  async function submitPackages(e: FormEvent) {
    e.preventDefault();
    const parsed = quoteRequestSchema.safeParse(request);
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error));
      return;
    }
    if (quoteIsCurrent && msLeft > 60_000) return go('quote');
    setBusy(true);
    setFormError(null);
    try {
      const response = await api.getQuote(request);
      setQuoted({ key: keyOf(request), request, response });
      setNow(Date.now());
      go('quote');
    } catch (err) {
      const apiErr = err as ApiError;
      setErrors(apiErr.fields);
      setFormError(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDetails(e: FormEvent) {
    e.preventDefault();
    if (!quoted || !quoteIsCurrent) return go('packages');
    const errs: Record<string, string> = {};
    for (const key of ['sender', 'recipient'] as const) {
      const r = contactSchema.safeParse(contactToInput(draft[key]));
      if (!r.success) for (const [k, v] of Object.entries(issuesToFieldErrors(r.error))) errs[`${key}.${k}`] = v;
    }
    if (!draft.acceptTerms) errs.acceptTerms = 'Please accept the terms of carriage.';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    setFormError(null);
    try {
      const res = await api.createBooking({
        quoteId: quoted.response.quoteId,
        quote: quoted.request,
        sender: contactToInput(draft.sender),
        recipient: contactToInput(draft.recipient),
        instructions: draft.instructions.trim() || undefined,
        paymentPreference: draft.paymentPreference,
        acceptTerms: true,
      });
      setBooking(res);
      go('done');
    } catch (err) {
      const apiErr = err as ApiError;
      if (QUOTE_INVALIDATING_CODES.includes(apiErr.code)) {
        setQuoted(null);
        setStep('packages');
      }
      setErrors(apiErr.fields);
      setFormError(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const routeLabel = quoted
    ? `${quoted.response.pickupAreaName} → ${quoted.response.destinationAreaName ?? draft.destination.city}`
    : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-3xl font-bold">Book a delivery</h1>

      <ol className="mb-8 grid grid-cols-5 gap-2 text-xs font-medium">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`border-t-4 pt-2 ${i <= stepIndex ? 'border-brand-600 text-brand-700' : 'border-slate-200 text-slate-400'}`}>
            {s.label}
          </li>
        ))}
      </ol>

      {formError && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {formError}
        </div>
      )}

      {step === 'route' && (
        <form onSubmit={submitRoute} className="space-y-6" noValidate>
          <AddressField title="Pickup" value={draft.pickup} onChange={(pickup) => patch({ pickup })} errors={scoped('pickup', errors)} />
          <AddressField
            title="Destination"
            value={draft.destination}
            onChange={(destination) => patch({ destination })}
            errors={scoped('destination', errors)}
          />
          <div className="flex justify-end">
            <button className="btn-primary">Continue</button>
          </div>
        </form>
      )}

      {step === 'packages' && (
        <form onSubmit={submitPackages} className="space-y-6" noValidate>
          <PackagesEditor
            value={draft.packages}
            onChange={(packages) => patch({ packages })}
            errors={scoped('packages', errors)}
            showDeclaredValue={draft.specialHandling.includes('high_value')}
          />

          <fieldset className="card space-y-3">
            <legend className="px-1 font-semibold">Delivery speed</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {URGENCY_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={`cursor-pointer rounded-lg border p-3 text-sm ${draft.urgency === o.value ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
                >
                  <input type="radio" name="urgency" className="sr-only" checked={draft.urgency === o.value} onChange={() => patch({ urgency: o.value })} />
                  <span className="block font-semibold">{o.label}</span>
                  <span className="text-slate-500">{o.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="card space-y-3">
            <legend className="px-1 font-semibold">Special handling</legend>
            <div className="flex flex-wrap gap-3">
              {SPECIAL_HANDLING.map((h) => (
                <label key={h} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-brand-600"
                    checked={draft.specialHandling.includes(h)}
                    onChange={(e) =>
                      patch({
                        specialHandling: e.target.checked ? [...draft.specialHandling, h] : draft.specialHandling.filter((x) => x !== h),
                      })
                    }
                  />
                  {HANDLING_LABEL[h]}
                </label>
              ))}
            </div>
            {errors.specialHandling && <p className="text-xs text-red-600">{errors.specialHandling}</p>}
          </fieldset>

          <div className="flex justify-between">
            <button type="button" className="btn-secondary" onClick={() => go('route')}>
              Back
            </button>
            <button className="btn-primary" disabled={busy}>
              {busy ? 'Calculating…' : 'Get price'}
            </button>
          </div>
        </form>
      )}

      {step === 'quote' && quoted && (
        <div className="space-y-6">
          <PriceBreakdown quote={quoted.response.quote} route={routeLabel} />
          <p className="text-sm text-slate-600">
            {msLeft > 0 ? `This price is held for ${Math.max(1, Math.round(msLeft / 60_000))} more minute(s).` : 'This price has expired.'}
          </p>
          <div className="flex justify-between">
            <button type="button" className="btn-secondary" onClick={() => go('packages')}>
              Change details
            </button>
            {msLeft > 0 ? (
              <button type="button" className="btn-primary" onClick={() => go('details')}>
                Continue to book
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => go('packages')}>
                Get a new price
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'details' && quoted && (
        <form onSubmit={submitDetails} className="space-y-6" noValidate>
          <ContactFields title="Sender" value={draft.sender} onChange={(sender) => patch({ sender })} errors={scoped('sender', errors)} />
          <ContactFields
            title="Recipient"
            value={draft.recipient}
            onChange={(recipient) => patch({ recipient })}
            errors={scoped('recipient', errors)}
          />

          <div className="card space-y-4">
            <Field label="Instructions for our driver" optional error={errors.instructions}>
              {(p) => (
                <textarea
                  {...p}
                  className="input"
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. Call on arrival; gate code; best time to collect"
                  value={draft.instructions}
                  onChange={(e) => patch({ instructions: e.target.value })}
                />
              )}
            </Field>
          </div>

          <fieldset className="card space-y-3">
            <legend className="px-1 font-semibold">Payment</legend>
            {PAYMENT_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${draft.paymentPreference === o.value ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
              >
                <input
                  type="radio"
                  name="payment"
                  className="mt-1 accent-brand-600"
                  checked={draft.paymentPreference === o.value}
                  onChange={() => patch({ paymentPreference: o.value })}
                />
                <span>
                  <span className="block font-semibold">{o.label}</span>
                  <span className="text-slate-500">{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="card flex items-center justify-between">
            <span className="font-semibold">Total to pay</span>
            <span className="text-xl font-bold">{formatGhs(quoted.response.quote.totalPesewas)}</span>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-brand-600"
              checked={draft.acceptTerms}
              onChange={(e) => patch({ acceptTerms: e.target.checked })}
            />
            <span>
              I confirm the package details are accurate and accept the{' '}
              <Link to="/terms" target="_blank" className="text-brand-700 underline">
                terms of carriage
              </Link>
              .
              {errors.acceptTerms && <span className="block text-xs text-red-600">{errors.acceptTerms}</span>}
            </span>
          </label>

          <div className="flex justify-between">
            <button type="button" className="btn-secondary" onClick={() => go('quote')}>
              Back
            </button>
            <button className="btn-primary" disabled={busy || msLeft <= 0}>
              {busy ? 'Booking…' : 'Confirm booking'}
            </button>
          </div>
        </form>
      )}

      {step === 'done' && booking && <BookingConfirmation booking={booking} />}
    </div>
  );
}

function ContactFields({
  title,
  value,
  onChange,
  errors,
}: {
  title: string;
  value: ContactDraft;
  onChange: (v: ContactDraft) => void;
  errors: Record<string, string>;
}) {
  const set = (p: Partial<ContactDraft>) => onChange({ ...value, ...p });
  return (
    <fieldset className="card grid gap-4 sm:grid-cols-3">
      <legend className="px-1 font-semibold">{title}</legend>
      <Field label="Full name" error={errors.name}>
        {(p) => <input {...p} className="input" autoComplete="name" value={value.name} onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Mobile number" error={errors.phone}>
        {(p) => (
          <input
            {...p}
            className="input"
            type="tel"
            inputMode="tel"
            placeholder="024 123 4567"
            value={value.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        )}
      </Field>
      <Field label="Email" optional error={errors.email}>
        {(p) => <input {...p} className="input" type="email" value={value.email} onChange={(e) => set({ email: e.target.value })} />}
      </Field>
    </fieldset>
  );
}

function BookingConfirmation({ booking }: { booking: CreateBookingResponse }) {
  const confirmed = booking.status === 'confirmed';
  return (
    <div className="card space-y-5 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-100 text-2xl text-brand-700">✓</div>
      <div>
        <h2 className="text-2xl font-bold">{confirmed ? 'Booking confirmed' : 'Booking received'}</h2>
        <p className="text-slate-600">
          {confirmed
            ? 'Our dispatch team will assign a driver for pickup.'
            : 'We will send you a payment request. Your booking is confirmed as soon as payment is verified.'}
        </p>
      </div>
      <div className="rounded-lg bg-slate-50 p-4">
        <p className="text-sm text-slate-500">Tracking number</p>
        <p className="font-mono text-2xl font-bold tracking-wider">{booking.trackingNumber}</p>
        <p className="mt-2 text-sm text-slate-600">Total: {formatGhs(booking.totalPesewas)}</p>
      </div>
      {booking.guestAccessToken && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-left text-sm text-amber-900">
          <p className="mb-1 font-semibold">Save your booking access code</p>
          <p className="mb-2">You will need it with your tracking number to view or manage this booking. It is shown only once.</p>
          <p className="break-all rounded bg-white px-2 py-1 font-mono">{booking.guestAccessToken}</p>
        </div>
      )}
      <Link to="/" className="btn-secondary">
        Back to home
      </Link>
    </div>
  );
}
