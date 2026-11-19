import * as ImageManipulator from 'expo-image-manipulator';
import { ActionError } from '../core/queue';
import { api } from './api';

/** Compress a camera photo and upload it to evidence storage through a signed URL. */
export async function uploadPhoto(uri: string, deliveryId: string): Promise<string> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(uri);
  ctx.resize({ width: 1280 });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
  const blob = await (await fetch(saved.uri)).blob();
  const ticket = await api.requestUpload({ deliveryId, contentType: 'image/jpeg', bytes: blob.size });
  const res = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (res.status === 201 || res.status === 409) return ticket.key; // 409: already stored on a previous attempt
  throw new ActionError(`Photo upload failed (${res.status})`, 'UPLOAD_FAILED', res.status >= 500);
}

/** Compress a receipt photo and upload it (fuel receipts). */
export async function uploadReceipt(uri: string): Promise<string> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(uri);
  ctx.resize({ width: 1280 });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: ImageManipulator.SaveFormat.JPEG });
  const blob = await (await fetch(saved.uri)).blob();
  const ticket = await api.requestReceiptUpload({ contentType: 'image/jpeg', bytes: blob.size });
  const res = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  if (res.status === 201 || res.status === 409) return ticket.key;
  throw new ActionError(`Receipt upload failed (${res.status})`, 'UPLOAD_FAILED', res.status >= 500);
}
