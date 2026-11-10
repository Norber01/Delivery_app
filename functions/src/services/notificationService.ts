import type { SmsProvider } from '../notifications/sms.js';
import type { NotificationRecord, Store } from '../store/types.js';

export const MAX_SMS_ATTEMPTS = 3;

/**
 * Deliver one queued notification. Without a configured provider the record is marked
 * `skipped` (visible to staff) rather than pretending it was sent.
 */
export async function deliverNotification(
  deps: { store: Store; sms: SmsProvider | null },
  n: NotificationRecord,
): Promise<NotificationRecord['status']> {
  if (n.status !== 'queued') return n.status;
  if (!deps.sms) {
    await deps.store.updateNotification(n.id, { status: 'skipped', error: 'SMS provider not configured' });
    return 'skipped';
  }
  try {
    const { providerMessageId } = await deps.sms.send(n.recipientPhone, n.body);
    await deps.store.updateNotification(n.id, { status: 'sent', attempts: n.attempts + 1, providerMessageId, error: null });
    return 'sent';
  } catch (e) {
    const attempts = n.attempts + 1;
    const status = attempts >= MAX_SMS_ATTEMPTS ? 'failed' : 'queued';
    await deps.store.updateNotification(n.id, { status, attempts, error: (e as Error).message.slice(0, 300) });
    if (status === 'queued') throw e; // let the trigger retry
    return status;
  }
}
