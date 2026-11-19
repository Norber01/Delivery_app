import { api } from './api';

/** Upload a receipt photo/PDF through a signed URL; returns its storage key. */
export async function uploadReceipt(file: File): Promise<string> {
  const contentType = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) ? file.type : 'image/jpeg';
  const t = await api.requestReceiptUpload({ contentType, bytes: file.size });
  const res = await fetch(t.uploadUrl, { method: 'PUT', headers: { 'Content-Type': t.contentType }, body: file });
  if (res.status !== 201) throw new Error(`Receipt upload failed (${res.status}). Try again.`);
  return t.key;
}

/** Open a stored receipt in a new tab (short-lived signed link). */
export async function openEvidence(key: string) {
  const w = window.open('', '_blank');
  try {
    const { url } = await api.getEvidenceUrl(key);
    if (w) w.location.href = url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

export const cedis = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);
export const thisMonth = () => new Date().toISOString().slice(0, 7);
export const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
