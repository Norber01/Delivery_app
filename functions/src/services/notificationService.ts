import type { SmsProvider } from '../notifications/sms.js';
import type { NotificationRecord, Store } from '../store/types.js';

export const MAX_SMS_ATTEMPTS = 3;

/** Which customer preference controls each template. Unlisted templates are essential (always sent). */
const PREFERENCE_FOR_TEMPLATE: Record<string, 'smsBookingUpdates' | 'smsPaymentReceipts'> = {
  booking_created: 'smsBookingUpdates',
  booking_pending_payment: 'smsBookingUpdates',
  payment_received: 'smsPaymentReceipts',
  refund_processed: 'smsPaymentReceipts',
};

/**
 * Deliver one queued notification. Without a configured provider the record is marked
 * `skipped` (visible to staff) rather than pretending it was sent.
 */
export async function deliverNotification(
  deps: { store: Store; sms: SmsProvider | null },
  n: NotificationRecord,
): Promise<NotificationRecord['status']> {
  if (n.status !== 'queued') return n.status;
  const prefKey = PREFERENCE_FOR_TEMPLATE[n.template];
  if (prefKey) {
    const prefs = await deps.store.getSmsPreferences(n.trackingNumber);
    if (prefs && !prefs[prefKey]) {
      await deps.store.updateNotification(n.id, { status: 'skipped', error: 'Customer opted out' });
      return 'skipped';
    }
  }
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
