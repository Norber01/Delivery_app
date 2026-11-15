import type { SignatureStrokes } from '@courier/shared-types';

/**
 * Normalise raw pad points (pixels) into 0..1 strokes, thinning points closer than `minStep`
 * pixels so the stored signature stays small (validated server-side: ≤ 60 strokes, ≤ 3000 points).
 */
export function normaliseStrokes(raw: { x: number; y: number }[][], width: number, height: number, minStep = 2): SignatureStrokes {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return raw
    .map((stroke) => {
      const out: [number, number][] = [];
      let last: { x: number; y: number } | null = null;
      for (const p of stroke) {
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < minStep) continue;
        out.push([+clamp(p.x / width).toFixed(4), +clamp(p.y / height).toFixed(4)]);
        last = p;
      }
      return out;
    })
    .filter((s) => s.length > 0)
    .slice(0, 60);
}

export const signaturePointCount = (s: SignatureStrokes) => s.reduce((n, x) => n + x.length, 0);
