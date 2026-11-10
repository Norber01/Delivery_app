import { GHANA_REGIONS, type GhanaRegion } from '@courier/constants';
import type { GeocodeResult } from '@courier/shared-utils';
import { useEffect, useRef, useState } from 'react';
import type { AddressDraft } from '../lib/draft';
import { searchAddress } from '../lib/geocode';
import { Field } from './Field';

interface Props {
  title: string;
  value: AddressDraft;
  onChange: (v: AddressDraft) => void;
  errors: Record<string, string>;
}

const matchRegion = (name?: string): GhanaRegion | '' =>
  (GHANA_REGIONS.find((r) => name?.toLowerCase().includes(r.toLowerCase())) ?? '') as GhanaRegion | '';

export function AddressField({ title, value, onChange, errors }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const set = (patch: Partial<AddressDraft>) => onChange({ ...value, ...patch });

  // Debounced search: ≥3 chars, 350 ms (cost control, docs/12).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      try {
        setSearchError(null);
        setResults(await searchAddress(q, ctrl.signal));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setSearchError((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const choose = (r: GeocodeResult) => {
    onChange({
      ...value,
      line1: r.label.slice(0, 200),
      city: r.city ?? value.city,
      region: matchRegion(r.region) || value.region,
      location: r.location,
    });
    setQuery('');
    setResults([]);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return setSearchError('Location is not available on this device.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        set({ location: { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) } });
      },
      () => {
        setLocating(false);
        setSearchError('We could not get your location. Please search for the address instead.');
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const locationError = errors['location.lat'] ?? errors['location.lng'] ?? errors.location;

  return (
    <fieldset className="card space-y-4">
      <legend className="px-1 text-base font-semibold text-slate-900">{title}</legend>

      <div className="relative space-y-1">
        <label className="block text-sm font-medium text-slate-700" htmlFor={`${title}-search`}>
          Find the location
        </label>
        <div className="flex gap-2">
          <input
            id={`${title}-search`}
            className="input"
            placeholder="Search a street, area or landmark (e.g. Osu Oxford Street)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <button type="button" className="btn-secondary shrink-0" onClick={useMyLocation} disabled={locating}>
            {locating ? 'Locating…' : 'Use my location'}
          </button>
        </div>
        {results.length > 0 && (
          <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg" role="listbox">
            {results.map((r) => (
              <li key={`${r.location.lat},${r.location.lng},${r.label}`}>
                <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50" onClick={() => choose(r)}>
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        )}
        {searchError && <p className="text-xs text-amber-700">{searchError}</p>}
        {value.location ? (
          <p className="text-xs text-brand-700">
            ✓ Location set ({value.location.lat.toFixed(5)}, {value.location.lng.toFixed(5)})
          </p>
        ) : (
          <p className={`text-xs ${locationError ? 'text-red-600' : 'text-slate-500'}`}>
            {locationError ? 'Please set the location using search or your current location.' : 'A map location is required so our driver can find you.'}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Address / description" error={errors.line1}>
            {(p) => <input {...p} className="input" value={value.line1} onChange={(e) => set({ line1: e.target.value })} />}
          </Field>
        </div>
        <Field label="House / building / floor" optional error={errors.line2}>
          {(p) => <input {...p} className="input" value={value.line2} onChange={(e) => set({ line2: e.target.value })} />}
        </Field>
        <Field label="Nearby landmark" optional error={errors.landmark}>
          {(p) => (
            <input {...p} className="input" placeholder="e.g. opposite the Total filling station" value={value.landmark} onChange={(e) => set({ landmark: e.target.value })} />
          )}
        </Field>
        <Field label="Town / city" error={errors.city}>
          {(p) => <input {...p} className="input" value={value.city} onChange={(e) => set({ city: e.target.value })} />}
        </Field>
        <Field label="Region" error={errors.region}>
          {(p) => (
            <select {...p} className="input" value={value.region} onChange={(e) => set({ region: e.target.value as GhanaRegion })}>
              <option value="">Select region</option>
              {GHANA_REGIONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="GhanaPost GPS address" optional hint="e.g. GA-123-4567" error={errors.ghanaPostGps}>
          {(p) => (
            <input {...p} className="input uppercase" value={value.ghanaPostGps} onChange={(e) => set({ ghanaPostGps: e.target.value })} />
          )}
        </Field>
      </div>
    </fieldset>
  );
}
