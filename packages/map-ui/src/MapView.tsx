import { useEffect, useRef, useState } from 'react';
import { SchematicMap } from './SchematicMap.js';
import { MARKER_COLORS, type MapViewProps } from './types.js';

/**
 * Provider-neutral map component. Mapbox GL JS is loaded lazily (kept out of the main bundle)
 * only when a token is configured; any failure falls back to the schematic map.
 */
export function MapView(props: MapViewProps) {
  const { markers, mapboxToken, height = 320, onMarkerClick, ariaLabel } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import('mapbox-gl').Map | null>(null);
  const markerRefs = useRef<import('mapbox-gl').Marker[]>([]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!mapboxToken || !container.current || mapRef.current) return;
    let cancelled = false;
    import('mapbox-gl')
      .then(({ default: mapboxgl }) => {
        if (cancelled || !container.current) return;
        mapboxgl.accessToken = mapboxToken;
        const map = new mapboxgl.Map({ container: container.current, style: 'mapbox://styles/mapbox/streets-v12', center: [-0.187, 5.6037], zoom: 11, attributionControl: true });
        map.on('error', () => setFailed(true));
        map.on('load', () => setReady(true));
        mapRef.current = map;
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapboxToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    void import('mapbox-gl').then(({ default: mapboxgl }) => {
      markerRefs.current.forEach((m) => m.remove());
      markerRefs.current = markers.map((m) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.title = m.label;
        el.setAttribute('aria-label', m.label);
        el.style.cssText = `width:${m.selected ? 22 : 16}px;height:${m.selected ? 22 : 16}px;border-radius:9999px;border:3px solid white;background:${MARKER_COLORS[m.kind]};opacity:${m.muted ? 0.45 : 1};box-shadow:0 1px 3px rgba(0,0,0,.4);cursor:pointer`;
        if (onMarkerClick) el.addEventListener('click', () => onMarkerClick(m.id));
        return new mapboxgl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map);
      });
      if (markers.length) {
        const b = new mapboxgl.LngLatBounds();
        markers.forEach((m) => b.extend([m.lng, m.lat]));
        map.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
      }
    });
  }, [markers, ready, onMarkerClick]);

  if (!mapboxToken || failed) return <SchematicMap markers={markers} height={height} onMarkerClick={onMarkerClick} ariaLabel={ariaLabel} />;
  return <div ref={container} role="region" aria-label={ariaLabel} className="w-full overflow-hidden rounded-lg" style={{ height }} />;
}
