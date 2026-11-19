import { MAX_INVOICE_LINES, type Role } from '@courier/constants';
import type { BusinessReport, InvoiceDoc } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';
import { businessReportSchema, generateInvoicesSchema, issuesToFieldErrors, recordInvoicePaymentSchema, voidInvoiceSchema } from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { callerBusiness } from './businessService.js';
import type { BusinessStore } from './types.js';

const FINANCE: Role[] = ['finance', 'admin', 'super_admin'];

export interface InvoiceDeps {
  biz: BusinessStore;
  now: () => Date;
  newId: () => string;
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION_FAILED', 'Invalid request.', 'invalid-argument', issuesToFieldErrors(r.error));
  return r.data;
}

/** First instant of the month after `period` (YYYY-MM), in UTC (Ghana is UTC+0 all year). */
export function periodEnd(period: string): Date {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1));
}

export function previousPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Invoice every uninvoiced, invoice-billed booking created before the end of `period`. Each
 * booking is stamped with its invoice inside the invoice's transaction, so re-running is safe
 * and a booking can never appear on two invoices. Large months are split into parts.
 */
export async function generateInvoices(deps: InvoiceDeps, caller: Caller | 'system', raw: unknown): Promise<{ invoices: { id: string; number: string; businessId: string; totalPesewas: number }[] }> {
  if (caller !== 'system') requireRole(caller, FINANCE);
  const { period, businessId } = parse(generateInvoicesSchema, raw);
  const end = periodEnd(period);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  if (start > deps.now()) throw new AppError('VALIDATION_FAILED', 'That month has not started.', 'invalid-argument');
  const businesses = businessId ? [await deps.biz.getBusiness(businessId)].filter((b) => b !== null) : await deps.biz.listCreditBusinesses();
  const out: { id: string; number: string; businessId: string; totalPesewas: number }[] = [];
  for (const b of businesses) {
    for (let part = 1; ; part++) {
      const bookings = await deps.biz.listUninvoicedBookings(b.id, end, MAX_INVOICE_LINES);
      if (bookings.length === 0) break;
      const issuedAt = deps.now();
      const termDays = b.creditTerms?.termDays ?? 30;
      const inv: InvoiceDoc = {
        id: `inv_${deps.newId()}`,
        number: await deps.biz.nextInvoiceNumber(period),
        businessId: b.id,
        businessName: b.legalName,
        tin: b.tin,
        period,
        part,
        lines: bookings.map((k) => ({
          trackingNumber: k.trackingNumber,
          date: k.createdAt.toISOString(),
          description: `${k.deliveryType.replace('_', '-')} · ${k.pickup.city} → ${k.destination.city} · ${k.recipient.name}`,
          reference: k.clientReference ?? null,
          amountPesewas: k.price.totalPesewas,
        })),
        // Recomputed by the store over the bookings actually included.
        totalPesewas: bookings.reduce((n, k) => n + k.price.totalPesewas, 0),
        paidPesewas: 0,
        status: 'issued',
        issuedAt: issuedAt.toISOString(),
        dueAt: new Date(issuedAt.getTime() + termDays * 86_400_000).toISOString(),
        payments: [],
        voidReason: null,
      };
      const included = await deps.biz.createInvoice(inv, bookings.map((k) => k.trackingNumber));
      if (included.length === 0) break; // all were taken by a concurrent run
      out.push({ id: inv.id, number: inv.number, businessId: b.id, totalPesewas: inv.lines.filter((l) => included.includes(l.trackingNumber)).reduce((n, l) => n + l.amountPesewas, 0) });
      if (bookings.length < MAX_INVOICE_LINES) break;
    }
  }
  return { invoices: out };
}

/** Finance records money received (bank transfer, MoMo to the company wallet, cheque, cash). */
export async function recordInvoicePayment(deps: InvoiceDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE);
  const input = parse(recordInvoicePaymentSchema, raw);
  const result = await deps.biz.updateInvoice(
    input.invoiceId,
    (inv) => {
      if (inv.status === 'void' || inv.status === 'paid') return { error: `This invoice is ${inv.status}.` };
      const outstanding = inv.totalPesewas - inv.paidPesewas;
      if (input.amountPesewas > outstanding) return { error: `The outstanding amount is ${formatGhs(outstanding)}.` };
      const paid = inv.paidPesewas + input.amountPesewas;
      return {
        invoice: {
          paidPesewas: paid,
          status: paid >= inv.totalPesewas ? 'paid' : 'partially_paid',
          payments: [...inv.payments, { amountPesewas: input.amountPesewas, method: input.method, reference: input.reference, recordedBy: caller.uid, at: deps.now().toISOString() }],
        },
        creditReleasePesewas: input.amountPesewas,
      };
    },
    { actorUid: caller.uid, actorRole: caller.role, action: 'invoice.payment', targetType: 'invoice', targetId: input.invoiceId, after: input },
  );
  if (!result) throw new AppError('NOT_FOUND', 'Invoice not found.', 'not-found');
  if ('error' in result) throw new AppError('VALIDATION_FAILED', result.error);
  if (result.status === 'paid') {
    await deps.biz.updateInvoiceBookings(result.lines.map((l) => l.trackingNumber), { paymentStatus: 'paid' });
  }
  await deps.biz.refreshOverdueFlag(result.businessId);
  return { invoiceId: result.id, status: result.status, paidPesewas: result.paidPesewas };
}

/** Void an unpaid invoice (e.g. raised in error); its bookings return to the next invoice run. */
export async function voidInvoice(deps: InvoiceDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE);
  const input = parse(voidInvoiceSchema, raw);
  const result = await deps.biz.updateInvoice(
    input.invoiceId,
    (inv) => (inv.paidPesewas > 0 || inv.status === 'void' ? { error: 'Only unpaid invoices can be voided.' } : { invoice: { status: 'void', voidReason: input.reason } }),
    { actorUid: caller.uid, actorRole: caller.role, action: 'invoice.void', targetType: 'invoice', targetId: input.invoiceId, after: { reason: input.reason } },
  );
  if (!result) throw new AppError('NOT_FOUND', 'Invoice not found.', 'not-found');
  if ('error' in result) throw new AppError('VALIDATION_FAILED', result.error);
  await deps.biz.updateInvoiceBookings(result.lines.map((l) => l.trackingNumber), { invoiceId: null });
  await deps.biz.refreshOverdueFlag(result.businessId);
  return { invoiceId: result.id, status: result.status };
}

/** Scheduled daily: mark invoices past due and block invoice billing for those businesses. */
export async function markOverdueInvoices(deps: InvoiceDeps) {
  const due = await deps.biz.listOverdueCandidates(deps.now());
  const businesses = new Set<string>();
  for (const inv of due) {
    await deps.biz.updateInvoice(
      inv.id,
      (i) => (i.status === 'issued' || i.status === 'partially_paid' ? { invoice: { status: 'overdue' } } : { error: 'skip' }),
      { actorUid: null, actorRole: 'system', action: 'invoice.overdue', targetType: 'invoice', targetId: inv.id },
    );
    businesses.add(inv.businessId);
  }
  for (const b of businesses) await deps.biz.refreshOverdueFlag(b);
  return { overdue: due.length };
}

// ---- Monthly report ----------------------------------------------------------------------------

export async function getBusinessReport(deps: InvoiceDeps, caller: Caller, raw: unknown): Promise<BusinessReport> {
  const { month, businessId } = parse(businessReportSchema, raw);
  let bid: string;
  if (caller.role === 'business_owner' || caller.role === 'business_staff') bid = (await callerBusiness(deps, caller)).id;
  else {
    requireRole(caller, FINANCE);
    if (!businessId) throw new AppError('VALIDATION_FAILED', 'Choose a business.', 'invalid-argument');
    bid = businessId;
  }
  const end = periodEnd(month);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const bookings = await deps.biz.listBusinessBookings(bid, start, end);
  const deliveries = new Map((await deps.biz.getDeliveries(bookings.filter((b) => b.deliveryId).map((b) => b.deliveryId!))).map((d) => [d.id, d]));

  const report: BusinessReport = {
    month,
    bookings: bookings.length,
    delivered: 0,
    inProgress: 0,
    cancelled: 0,
    failedAttempts: 0,
    onTimePercent: null,
    spendPesewas: 0,
    byType: { intra_city: 0, intercity: 0, long_distance: 0 },
    byDestination: [],
    rows: [],
  };
  const cities = new Map<string, number>();
  let onTime = 0;
  for (const b of bookings) {
    const d = b.deliveryId ? deliveries.get(b.deliveryId) : undefined;
    const status = b.status === 'cancelled' ? 'cancelled' : (d?.status ?? (b.status === 'pending_payment' ? 'awaiting_payment' : 'awaiting_assignment'));
    const deliveredAt = d?.status === 'delivered' ? d.updatedAt.toISOString() : null;
    if (status === 'cancelled') report.cancelled++;
    else {
      report.spendPesewas += b.price.totalPesewas;
      report.byType[b.deliveryType]++;
      cities.set(b.destination.city, (cities.get(b.destination.city) ?? 0) + 1);
      if (status === 'delivered') {
        report.delivered++;
        if (d && d.updatedAt.toISOString() <= d.expectedDeliveryAt) onTime++;
      } else if (status !== 'returned') report.inProgress++;
    }
    report.failedAttempts += d?.exceptions.filter((x) => x.stage === 'delivery').length ?? 0;
    report.rows.push({
      trackingNumber: b.trackingNumber,
      createdAt: b.createdAt.toISOString(),
      reference: b.clientReference ?? null,
      recipient: b.recipient.name,
      destinationCity: b.destination.city,
      deliveryType: b.deliveryType,
      status,
      deliveredAt,
      amountPesewas: status === 'cancelled' ? 0 : b.price.totalPesewas,
      paymentPreference: b.paymentPreference,
    });
  }
  report.onTimePercent = report.delivered ? Math.round((onTime / report.delivered) * 1000) / 10 : null;
  report.byDestination = [...cities.entries()].map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count).slice(0, 10);
  return report;
}
