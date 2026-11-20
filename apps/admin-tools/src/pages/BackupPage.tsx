import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { buildXlsx } from '../lib/xlsx';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function preset(kind: 'this' | 'last' | 'year' | 'all'): [string, string] {
  const now = new Date();
  if (kind === 'this') return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
  if (kind === 'last') return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))];
  if (kind === 'year') return [iso(new Date(now.getFullYear(), 0, 1)), iso(now)];
  return ['2020-01-01', iso(now)];
}
const PRESETS = [
  ['this', 'This month'],
  ['last', 'Last month'],
  ['year', 'This year'],
  ['all', 'Everything'],
] as const;

/** Manager / finance: download a backup of the business data as an Excel workbook. */
export function BackupPage() {
  const [[from, to], setRange] = useState(preset('this'));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function download() {
    setBusy(true);
    setMsg(null);
    try {
      const wb = await api.exportBackup({ from, to });
      const bytes = buildXlsx(wb.sheets);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `courier-backup-${from}-to-${to}.xlsx`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMsg({ ok: true, text: `Downloaded: ${wb.sheets.map((s) => `${s.rows.length} ${s.name.toLowerCase()}`).join(', ')}.` });
    } catch (x) {
      setMsg({ ok: false, text: (x as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4">
      <h1 className="text-2xl font-extrabold tracking-tight">Excel backup</h1>
      <div className="card space-y-4">
        <p className="text-sm text-slate-600">
          One Excel file with a sheet each for <strong>orders</strong> (with pickup and delivery riders), <strong>customers</strong>, <strong>payments</strong>, <strong>riders</strong>,{' '}
          <strong>rider cash hand-ins</strong>, <strong>rider pay</strong>, <strong>expenses</strong>, <strong>fuel</strong> and <strong>shifts</strong>. Keep it somewhere safe: it contains customers’ names and phone numbers.
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(([k, label]) => {
            const r = preset(k);
            const on = r[0] === from && r[1] === to;
            return (
              <button key={k} className={`chip px-3 py-1.5 text-sm ${on ? 'bg-brand-600 text-white' : 'bg-field text-slate-700'}`} onClick={() => setRange(r)}>
                {label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium">From</span>
            <input type="date" className="input" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">To</span>
            <input type="date" className="input" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} />
          </label>
        </div>
        <button className="btn-accent w-full py-3 text-base" disabled={busy || !from || !to} onClick={download}>
          {busy ? 'Preparing…' : 'Download Excel file'}
        </button>
        {msg && <p className={`rounded-xl px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
        <p className="text-xs text-slate-500">Dates are in UTC (Ghana time). Each download is recorded in the audit log.</p>
      </div>
    </div>
  );
}
