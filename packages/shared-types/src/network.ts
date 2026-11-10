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
