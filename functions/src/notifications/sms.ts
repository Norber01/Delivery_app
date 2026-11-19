/** SMS port. Messages are plain text; keep under 160 GSM characters where possible. */
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, text: string): Promise<{ providerMessageId: string | null }>;
}

export class SmsProviderError extends Error {}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Hubtel quick-send SMS (GET /v1/messages/send). Verify sender-ID approval and the
 * endpoint with Hubtel during onboarding; credentials come from Secret Manager.
 */
export class HubtelSmsProvider implements SmsProvider {
  readonly name = 'hubtel';
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly senderId: string,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private readonly baseUrl = 'https://smsc.hubtel.com/v1/messages/send',
  ) {}

  async send(toE164: string, text: string) {
    const params = new URLSearchParams({
      clientid: this.clientId,
      clientsecret: this.clientSecret,
      from: this.senderId,
      to: toE164.replace(/^\+/, ''),
      content: text,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}?${params}`, { signal: ctrl.signal });
      const body = (await res.json().catch(() => ({}))) as { messageId?: string; MessageId?: string };
      if (!res.ok) throw new SmsProviderError(`Hubtel SMS failed (${res.status})`);
      return { providerMessageId: body.messageId ?? body.MessageId ?? null };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface SmsTemplateData {
  trackingNumber: string;
  companyName: string;
  amount?: string;
  trackUrl?: string;
}

export type SmsTemplate = 'booking_created' | 'booking_pending_payment' | 'payment_received' | 'refund_processed';

export function renderSms(template: SmsTemplate, d: SmsTemplateData): string {
  const track = d.trackUrl ? ` Track: ${d.trackUrl}` : '';
  switch (template) {
    case 'booking_created':
      return `${d.companyName}: booking ${d.trackingNumber} confirmed. We will assign a driver for pickup.${track}`;
    case 'booking_pending_payment':
      return `${d.companyName}: booking ${d.trackingNumber} received. Pay ${d.amount} online to confirm it.${track}`;
    case 'payment_received':
      return `${d.companyName}: payment of ${d.amount} received for ${d.trackingNumber}. Thank you.${track}`;
    case 'refund_processed':
      return `${d.companyName}: refund of ${d.amount} for ${d.trackingNumber} has been processed.`;
  }
}
