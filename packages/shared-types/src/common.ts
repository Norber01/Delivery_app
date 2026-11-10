import type { GhanaRegion } from '@courier/constants';

/** Firestore timestamps are represented as ISO strings in API payloads and Timestamp in documents. */
export type IsoDateString = string;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  region: GhanaRegion;
  landmark?: string;
  /** GhanaPost GPS digital address, e.g. GA-123-4567. */
  ghanaPostGps?: string;
  location: LatLng;
}

export interface Contact {
  name: string;
  /** E.164, e.g. +233241234567 */
  phone: string;
  email?: string;
}

export interface PackageInfo {
  description: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  quantity: number;
  declaredValuePesewas?: number;
}
