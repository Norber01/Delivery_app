import type { GhanaRegion } from '@courier/constants';
import type { LatLng } from './common.js';

export interface ServiceArea {
  id: string;
  name: string;
  city: string;
  region: GhanaRegion;
  center: LatLng;
  radiusKm: number;
  active: boolean;
}

export interface HubDoc {
  id: string;
  /** Short code printed on labels and manifests, e.g. ACC-01. */
  code: string;
  name: string;
  type: import('@courier/constants').HubType;
  serviceAreaId: string;
  city: string;
  /** The hub intercity parcels for this service area are routed through. */
  primaryForArea: boolean;
  address: string;
  location: LatLng;
  phone: string | null;
  active: boolean;
}

/** Scheduled intercity lane between two hubs (operational; prices live in pricing rules). */
export interface RouteDoc {
  id: string;
  /** e.g. ACC-KSI */
  code: string;
  originHubId: string;
  destinationHubId: string;
  originAreaId: string;
  destinationAreaId: string;
  distanceKm: number;
  typicalDurationMinutes: number;
  /** Local departure times "HH:MM" on the given ISO weekdays (1 = Monday). */
  schedule: { daysOfWeek: number[]; departureTimes: string[] };
  active: boolean;
}
