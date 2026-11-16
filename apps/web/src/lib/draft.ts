import type { GhanaRegion, PaymentPreference, SpecialHandling, Urgency } from '@courier/constants';
import type { LatLng } from '@courier/shared-types';
import type { QuoteRequestInput } from '@courier/validation';

export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  region: GhanaRegion | '';
  landmark: string;
  ghanaPostGps: string;
  location: LatLng | null;
}

export interface PackageDraft {
  description: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  quantity: string;
  declaredValueGhs: string;
}

export interface ContactDraft {
  name: string;
  phone: string;
  email: string;
}

export interface BookingDraft {
  pickup: AddressDraft;
  destination: AddressDraft;
  packages: PackageDraft[];
  urgency: Urgency;
  specialHandling: SpecialHandling[];
  sender: ContactDraft;
  recipient: ContactDraft;
  instructions: string;
  paymentPreference: PaymentPreference;
  acceptTerms: boolean;
}

export const emptyAddress = (): AddressDraft => ({
  line1: '',
  line2: '',
  city: '',
  region: '',
  landmark: '',
  ghanaPostGps: '',
  location: null,
});

export const emptyPackage = (): PackageDraft => ({
  description: '',
  weightKg: '',
  lengthCm: '',
  widthCm: '',
  heightCm: '',
  quantity: '1',
  declaredValueGhs: '',
});

export const emptyContact = (): ContactDraft => ({ name: '', phone: '', email: '' });

export const initialDraft = (): BookingDraft => ({
  pickup: emptyAddress(),
  destination: emptyAddress(),
  packages: [emptyPackage()],
  urgency: 'standard',
  specialHandling: [],
  sender: emptyContact(),
  recipient: emptyContact(),
  instructions: '',
  paymentPreference: 'cash_on_pickup',
  acceptTerms: false,
});

const opt = (s: string) => (s.trim() ? s.trim() : undefined);
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function toAddress(a: AddressDraft) {
  return {
    line1: a.line1,
    line2: opt(a.line2),
    city: a.city,
    region: a.region,
    landmark: opt(a.landmark),
    ghanaPostGps: opt(a.ghanaPostGps),
    location: a.location ?? { lat: NaN, lng: NaN },
  };
}

/** Convert the form draft to the API's quote request (validated by the shared schema). */
export function draftToQuoteRequest(d: BookingDraft): QuoteRequestInput {
  return {
    pickup: toAddress(d.pickup),
    destination: toAddress(d.destination),
    packages: d.packages.map((p) => ({
      description: p.description,
      weightKg: num(p.weightKg),
      lengthCm: num(p.lengthCm),
      widthCm: num(p.widthCm),
      heightCm: num(p.heightCm),
      quantity: num(p.quantity),
      declaredValuePesewas: p.declaredValueGhs.trim() ? Math.round(Number(p.declaredValueGhs) * 100) : undefined,
    })),
    urgency: d.urgency,
    specialHandling: d.specialHandling,
  } as QuoteRequestInput;
}

export function contactToInput(c: ContactDraft) {
  return { name: c.name, phone: c.phone, email: opt(c.email) };
}
