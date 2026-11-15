import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MapView, project } from '../src/index.js';

describe('schematic projection', () => {
  it('keeps points inside the box with north up and east right', () => {
    const pts = project([{ lat: 5.55, lng: -0.2 }, { lat: 5.65, lng: -0.15 }], 640, 320);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(640);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(320);
    }
    expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x); // east is right
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y); // north is up
  });
  it('centres a single point', () => {
    const [p] = project([{ lat: 5.6, lng: -0.18 }], 640, 320);
    expect(p!.x).toBeCloseTo(320, 0);
    expect(p!.y).toBeCloseTo(160, 0);
  });
});

describe('MapView', () => {
  it('falls back to the schematic map without a token', () => {
    const { container, getByRole } = render(
      <MapView
        ariaLabel="Delivery map"
        markers={[
          { id: 'p', kind: 'pickup', lat: 5.55, lng: -0.18, label: 'Pickup' },
          { id: 'd', kind: 'destination', lat: 5.66, lng: -0.16, label: 'Destination' },
          { id: 'drv', kind: 'driver', lat: 5.6, lng: -0.17, label: 'Driver', muted: true },
        ]}
      />,
    );
    expect(getByRole('img', { name: 'Delivery map' })).toBeTruthy();
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(3);
    expect(container.querySelector('[data-marker="driver"]')!.getAttribute('opacity')).toBe('0.45');
  });
});
