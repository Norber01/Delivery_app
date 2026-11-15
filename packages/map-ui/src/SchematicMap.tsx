import { MARKER_COLORS, type MapMarker, type MapViewProps } from './types.js';

/** Equirectangular projection of markers into a box with padding (fine at city scale). */
export function project(markers: Pick<MapMarker, 'lat' | 'lng'>[], width: number, height: number, pad = 28) {
  if (markers.length === 0) return [];
  const lats = markers.map((m) => m.lat);
  const lngs = markers.map((m) => m.lng);
  const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  let minX = Math.min(...lngs) * kx;
  let maxX = Math.max(...lngs) * kx;
  let minY = Math.min(...lats);
  let maxY = Math.max(...lats);
  // Keep a minimum span (~1 km) so a single point is centred, not stretched.
  const minSpan = 0.01;
  if (maxX - minX < minSpan) [minX, maxX] = [(minX + maxX) / 2 - minSpan / 2, (minX + maxX) / 2 + minSpan / 2];
  if (maxY - minY < minSpan) [minY, maxY] = [(minY + maxY) / 2 - minSpan / 2, (minY + maxY) / 2 + minSpan / 2];
  const scale = Math.min((width - 2 * pad) / (maxX - minX), (height - 2 * pad) / (maxY - minY));
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  return markers.map((m) => ({ x: offX + (m.lng * kx - minX) * scale, y: height - (offY + (m.lat - minY) * scale) }));
}

/**
 * Tile-free fallback: shows relative positions of pickup, destination and drivers. Used when
 * no Mapbox token is configured or the map library cannot load (e.g. offline).
 */
export function SchematicMap({ markers, height = 320, onMarkerClick, ariaLabel }: Omit<MapViewProps, 'mapboxToken'>) {
  const width = 640;
  const pts = project(markers, width, height);
  const pickup = markers.findIndex((m) => m.kind === 'pickup');
  const dest = markers.findIndex((m) => m.kind === 'destination');
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} className="block w-full rounded-lg bg-slate-100" style={{ maxHeight: height }}>
        <defs>
          <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#e2e8f0" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#grid)" />
        {pickup >= 0 && dest >= 0 && (
          <line x1={pts[pickup]!.x} y1={pts[pickup]!.y} x2={pts[dest]!.x} y2={pts[dest]!.y} stroke="#94a3b8" strokeWidth="2" strokeDasharray="6 6" />
        )}
        {markers.map((m, i) => (
          <g
            key={m.id}
            transform={`translate(${pts[i]!.x},${pts[i]!.y})`}
            opacity={m.muted ? 0.45 : 1}
            onClick={onMarkerClick ? () => onMarkerClick(m.id) : undefined}
            style={{ cursor: onMarkerClick ? 'pointer' : undefined }}
            data-marker={m.kind}
          >
            <circle r={m.selected ? 11 : 8} fill={MARKER_COLORS[m.kind]} stroke="white" strokeWidth="3" />
            <text y={-14} textAnchor="middle" fontSize="12" fontWeight="600" fill="#0f172a" stroke="white" strokeWidth="3" paintOrder="stroke">
              {m.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-500">Schematic view — positions are to scale, streets not shown.</figcaption>
    </figure>
  );
}
