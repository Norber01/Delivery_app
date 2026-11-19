export type MarkerKind = 'pickup' | 'destination' | 'driver' | 'hub';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  kind: MarkerKind;
  label: string;
  /** Faded marker, e.g. a stale driver position. */
  muted?: boolean;
  selected?: boolean;
}

export interface MapViewProps {
  markers: MapMarker[];
  /** Mapbox public token (URL-restricted). Without it, the schematic map is shown. */
  mapboxToken?: string;
  height?: number;
  onMarkerClick?: (id: string) => void;
  /** Accessible description of what the map shows. */
  ariaLabel: string;
}

export const MARKER_COLORS: Record<MarkerKind, string> = {
  pickup: '#2563eb',
  destination: '#16a34a',
  driver: '#ea580c',
  hub: '#7c3aed',
};
