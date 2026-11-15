import type { SignatureStrokes } from '@courier/shared-types';

/** Renders normalised (0..1) signature strokes as SVG. */
export function SignatureView({ strokes, width = 320, height = 120 }: { strokes: SignatureStrokes; width?: number; height?: number }) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-xs rounded border border-slate-200 bg-white" role="img" aria-label="Recipient signature">
      {strokes.map((s, i) => (
        <polyline key={i} points={s.map(([x, y]) => `${(x * width).toFixed(1)},${(y * height).toFixed(1)}`).join(' ')} fill="none" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
