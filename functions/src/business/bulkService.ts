import { BULK } from '@courier/constants';
import type { Address, BulkConfirmResult, BulkPreview, BulkRowResult, DeliveryRequestDoc, PackageInfo } from '@courier/shared-types';
import { classifyDelivery, findServiceArea, formatGhs, generateTrackingNumber, priceShipment, PricingError, type MapProvider } from '@courier/shared-utils';
import { bulkConfirmSchema, bulkCsvRowSchema, bulkPreviewRequestSchema, issuesToFieldErrors, type BulkCsvRow } from '@courier/validation';
import type { Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { initialStatus } from '../services/bookingService.js';
import { resolveDistance } from '../services/quoteService.js';
import type { RateLimiter, Store } from '../store/types.js';
import { callerBusiness } from './businessService.js';
import type { BulkBatch, BusinessStore } from './types.js';

export interface BulkDeps {
  store: Store;
  biz: BusinessStore;
  rateLimiter: RateLimiter;
  maps: MapProvider | null;
  now: () => Date;
  newId: () => string;
  site?: { publicUrl: string; companyName: string };
  newTrackingNumber?: () => string;
}

const errorsOf = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => (v.toLowerCase().startsWith(k.replace(/_/g, ' ')) || v.startsWith(k) ? v : `${k}: ${v}`));

/** Geocode "line1, city" once per distinct query in the batch. */
async function geocoder(maps: MapProvider | null) {
  const cache = new Map<string, { lat: number; lng: number; label: string } | null>();
  return async (row: BulkCsvRow) => {
    const q = `${row.address_line1}, ${row.city}`;
    if (!cache.has(q)) {
      if (!maps) cache.set(q, null);
      else {
        try {
          const [r] = await maps.geocode(q, { limit: 1 });
          cache.set(q, r ? { ...r.location, label: r.label } : null);
        } catch {
          cache.set(q, null);
        }
      }
    }
    return cache.get(q)!;
  };
}

/**
 * Validate, geocode and price every CSV row server-side. Nothing is booked yet: the preview is
 * stored (1 h) and confirmed separately, so the prices shown are exactly what will be charged.
 */
export async function previewBulkBooking(deps: BulkDeps, caller: Caller, raw: unknown): Promise<BulkPreview> {
  const business = await callerBusiness(deps, caller);
  if (business.verificationStatus === 'rejected' || business.verificationStatus === 'suspended') {
    throw new AppError('BUSINESS_NOT_VERIFIED', 'This business account is not active.');
  }
  const parsed = bulkPreviewRequestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'The upload is invalid.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  const req = parsed.data;
  if (!(await deps.rateLimiter.consume(`bulk:${business.id}`, 30, 3600))) {
    throw new AppError('RATE_LIMITED', 'Too many uploads. Please wait and try again.', 'resource-exhausted');
  }
  const [rules, areas, contract] = await Promise.all([deps.store.getActivePricingRules(), deps.store.getServiceAreas(), deps.store.getContractTerms(business.id)]);
  if (!rules) throw new AppError('PRICING_NOT_CONFIGURED', 'Online pricing is temporarily unavailable.', 'unavailable');
  const pickupArea = findServiceArea(req.pickup.location, areas);
  if (!pickupArea) throw new AppError('PICKUP_NOT_SERVICED', 'We do not yet collect from this pickup address.');

  // Pass 1: validate rows and resolve coordinates.
  const geocode = await geocoder(deps.maps);
  const staged: { result: BulkRowResult; row?: BulkCsvRow; destination?: Address; packages?: PackageInfo[] }[] = [];
  for (const [index, rawRow] of req.rows.entries()) {
    const r = bulkCsvRowSchema.safeParse(rawRow);
    const reference = typeof rawRow.reference === 'string' && rawRow.reference.trim() ? rawRow.reference.trim().slice(0, 60) : null;
    if (!r.success) {
      staged.push({ result: { index, reference, ok: false, errors: errorsOf(issuesToFieldErrors(r.error)) } });
      continue;
    }
    const row = r.data;
    let location = row.lat !== undefined && row.lng !== undefined ? { lat: row.lat, lng: row.lng } : null;
    let geocodedLabel: string | null = null;
    if (!location) {
      const g = await geocode(row);
      if (!g) {
        staged.push({ result: { index, reference, ok: false, errors: ['Address not found: add lat and lng for this row'] } });
        continue;
      }
      location = { lat: g.lat, lng: g.lng };
      geocodedLabel = g.label;
    }
    const destination: Address = {
      line1: row.address_line1,
      city: row.city,
      region: row.region,
      ...(row.landmark ? { landmark: row.landmark } : {}),
      ...(row.ghanapost_gps ? { ghanaPostGps: row.ghanapost_gps } : {}),
      location,
    };
    const packages: PackageInfo[] = [
      {
        description: row.description,
        weightKg: row.weight_kg,
        lengthCm: row.length_cm,
        widthCm: row.width_cm,
        heightCm: row.height_cm,
        quantity: row.quantity ?? 1,
        ...(row.declared_value_ghs ? { declaredValuePesewas: Math.round(row.declared_value_ghs * 100) } : {}),
      },
    ];
    staged.push({ result: { index, reference, ok: true, errors: [], geocodedLabel }, row, destination, packages });
  }

  // Pass 2: price valid rows with the batch's total item count for the bulk tier.
  const batchItems = staged.reduce((n, s) => n + (s.packages?.[0]?.quantity ?? 0), 0);
  let bulkDiscountPercent = 0;
  for (const s of staged) {
    if (!s.row || !s.destination || !s.packages) continue;
    try {
      const c = classifyDelivery(rules, areas, req.pickup.location, s.destination.location);
      const distance = c.deliveryType === 'intercity' ? null : await resolveDistance(deps.maps, rules, req.pickup.location, s.destination.location);
      const quote = priceShipment(rules, {
        deliveryType: c.deliveryType,
        distanceKm: distance?.km ?? null,
        distanceSource: distance?.source ?? 'fixed_route',
        route: c.route,
        packages: s.packages,
        urgency: s.row.urgency ?? 'standard',
        specialHandling: s.row.special_handling,
        contract,
        bulkQuantity: batchItems,
      });
      const pct = /Bulk discount \((\d+(?:\.\d+)?)%\)/.exec(quote.lines.find((l) => l.code === 'DISCOUNT_BULK')?.label ?? '')?.[1];
      if (pct) bulkDiscountPercent = Math.max(bulkDiscountPercent, Number(pct));
      Object.assign(s.result, {
        recipient: { name: s.row.recipient_name, phone: s.row.recipient_phone, ...(s.row.recipient_email ? { email: s.row.recipient_email } : {}) },
        destination: s.destination,
        packages: s.packages,
        urgency: s.row.urgency ?? 'standard',
        specialHandling: s.row.special_handling,
        instructions: s.row.instructions ?? null,
        destinationAreaId: c.destinationArea?.id ?? null,
        quote,
      });
    } catch (e) {
      s.result.ok = false;
      s.result.errors = [e instanceof PricingError || e instanceof AppError ? e.message : 'Could not price this row'];
    }
  }

  const rows = staged.map((s) => s.result);
  const now = deps.now();
  const batch: BulkBatch = {
    id: `bb_${deps.newId()}`,
    businessId: business.id,
    createdBy: caller.uid!,
    pickup: req.pickup,
    pickupAreaId: pickupArea.id,
    paymentPreference: req.paymentPreference,
    rows,
    bulkDiscountPercent,
    created: {},
    createdAt: now,
    expiresAt: new Date(now.getTime() + BULK.previewTtlMinutes * 60_000),
  };
  await deps.biz.saveBatch(batch);
  const valid = rows.filter((r) => r.ok);
  return {
    batchId: batch.id,
    expiresAt: batch.expiresAt.toISOString(),
    rows,
    validCount: valid.length,
    invalidCount: rows.length - valid.length,
    totalPesewas: valid.reduce((n, r) => n + (r.quote?.totalPesewas ?? 0), 0),
    bulkDiscountPercent,
    paymentPreference: req.paymentPreference,
  };
}

/** Book every valid row of a preview. Safe to retry: rows already booked are skipped atomically. */
export async function confirmBulkBooking(deps: BulkDeps, caller: Caller, raw: unknown): Promise<BulkConfirmResult> {
  const business = await callerBusiness(deps, caller);
  const parsed = bulkConfirmSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Accept the terms of carriage to book.', 'invalid-argument', issuesToFieldErrors(parsed.error));
  const batch = await deps.biz.getBatch(parsed.data.batchId);
  if (!batch || batch.businessId !== business.id) throw new AppError('NOT_FOUND', 'Upload not found.', 'not-found');
  if (batch.expiresAt <= deps.now()) throw new AppError('BATCH_EXPIRED', 'This preview has expired. Upload the file again to get current prices.');

  const pending = batch.rows.filter((r) => r.ok && r.quote && !batch.created[String(r.index)]);
  if (batch.paymentPreference === 'business_invoice') {
    const total = pending.reduce((n, r) => n + r.quote!.totalPesewas, 0);
    const limit = business.creditTerms?.limitPesewas ?? 0;
    if (business.verificationStatus !== 'verified' || !business.creditTerms) {
      throw new AppError('BUSINESS_NOT_VERIFIED', 'Invoice billing needs a verified business with approved credit. Choose "pay the driver at pickup" instead.');
    }
    if (business.hasOverdueInvoices) throw new AppError('INVOICES_OVERDUE', 'An invoice is overdue. Settle it to book on account.');
    if (business.creditUsedPesewas + total > limit) {
      throw new AppError(
        'CREDIT_LIMIT_EXCEEDED',
        `This upload totals ${formatGhs(total)} but only ${formatGhs(Math.max(0, limit - business.creditUsedPesewas))} of credit is available.`,
      );
    }
  }

  const { status, paymentStatus } = initialStatus(batch.paymentPreference as 'business_invoice' | 'cash_on_pickup');
  const created: BulkConfirmResult['created'] = Object.entries(batch.created).map(([i, tn]) => ({ index: Number(i), trackingNumber: tn }));
  const failed: BulkConfirmResult['failed'] = [];
  for (const row of pending) {
    let outcome: string = 'tracking_number_taken';
    let trackingNumber = '';
    for (let attempt = 0; attempt < 5 && outcome === 'tracking_number_taken'; attempt++) {
      trackingNumber = (deps.newTrackingNumber ?? generateTrackingNumber)();
      const doc: DeliveryRequestDoc = {
        trackingNumber,
        customerUid: caller.uid,
        businessId: business.id,
        sender: { name: business.tradingName, phone: business.contact.phone, ...(business.contact.email ? { email: business.contact.email } : {}) },
        recipient: row.recipient!,
        pickup: batch.pickup,
        destination: row.destination!,
        packages: row.packages!,
        deliveryType: row.quote!.deliveryType,
        urgency: row.urgency!,
        specialHandling: row.specialHandling!,
        instructions: row.instructions ?? null,
        paymentPreference: batch.paymentPreference,
        price: row.quote!,
        quoteId: batch.id,
        pickupAreaId: batch.pickupAreaId,
        destinationAreaId: row.destinationAreaId ?? null,
        status,
        paymentStatus,
        guestAccessHash: null,
        deliveryId: null,
        source: 'bulk',
        clientReference: row.reference,
        bulkBatchId: batch.id,
        invoiceId: null,
      };
      outcome = await deps.store.createBooking(
        doc,
        null,
        { actorUid: caller.uid, actorRole: caller.role ?? 'guest', action: 'booking.create_bulk', targetType: 'deliveryRequest', targetId: trackingNumber, after: { batchId: batch.id, row: row.index, totalPesewas: row.quote!.totalPesewas } },
        {
          batchRow: { batchId: batch.id, index: row.index },
          events: [{ trackingNumber, deliveryId: null, type: 'booking_created', publicMessage: 'Booking received', actorUid: caller.uid, actorRole: caller.role ?? 'guest', occurredAt: deps.now() }],
          // Recipients get the delivery-code SMS when the parcel goes out; no per-row SMS at booking.
        },
      );
    }
    if (outcome === 'created') created.push({ index: row.index, trackingNumber });
    else if (outcome === 'row_already_created') continue;
    else failed.push({ index: row.index, message: outcome === 'credit_refused' ? 'Credit limit reached' : 'Could not create booking' });
  }
  created.sort((a, b) => a.index - b.index);
  return { batchId: batch.id, created, failed };
}

