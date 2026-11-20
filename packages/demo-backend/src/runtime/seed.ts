/**
 * Sample data for the demo, created by running the real services (bookings, dispatch, driver
 * actions, business accounts, invoices, fleet, pay) with the clock set to past dates, so every
 * figure is consistent and the finance report's checks pass.
 */
import type { Address } from '@courier/shared-types';
import { ensureDeliveryForBooking } from '../../../../functions/src/ops/opsService.js';
import { hubSchema, pricingRuleSetSchema, routeSchema, serviceAreaSchema } from '@courier/validation';
import { z } from 'zod';
import areasJson from '../../../../firebase/seed/service-areas.sample.json';
import networkJson from '../../../../firebase/seed/network.sample.json';
import pricingJson from '../../../../firebase/seed/pricing-rules.sample.json';
import { getAccount, saveAccount, theDb, withClock, type DemoAccount } from './core.js';
import { storeFile } from './evidence.js';
import { place } from './places.js';
import { callAs, DEMO_PASSWORD, services } from './wiring.js';

export interface DemoPerson {
  uid: string;
  email: string;
  name: string;
  role: string;
  what: string;
  phone?: string;
  extra?: Record<string, unknown>;
}

/** The accounts listed on the demo's sign-in helper. */
export const PEOPLE: DemoPerson[] = [
  { uid: 'd_owner', email: 'owner@demo.gh', name: 'Akosua Owusu', role: 'super_admin', what: 'Company owner — everything in the ops app' },
  { uid: 'd_manager', email: 'manager@demo.gh', name: 'Kofi Asamoah', role: 'manager', what: 'Manager — sees everything: today, orders, warehouse, riders, money, Excel backup' },
  { uid: 'd_dispatch', email: 'dispatch@demo.gh', name: 'Yaw Darko', role: 'dispatcher', what: 'Dispatcher — assigns pickup and delivery riders' },
  { uid: 'd_hub_acc', email: 'warehouse@demo.gh', name: 'Kwabena Boateng', role: 'hub_operator', what: 'Warehouse staff — Accra warehouse (scan in / give to rider)', extra: { hubIds: ['acc-01'] } },
  { uid: 'd_finance', email: 'finance@demo.gh', name: 'Efua Asante', role: 'finance', what: 'Finance — invoices, expenses, rider pay, reports' },
  { uid: 'd_fleet', email: 'fleet@demo.gh', name: 'Nana Agyei', role: 'fleet_manager', what: 'Fleet manager — riders, vehicles, maintenance' },
  { uid: 'd_ama', email: 'ama@demo.gh', name: 'Ama Mensah', role: 'customer', what: 'Customer — books and tracks parcels', phone: '+233241234567' },
  { uid: 'd_adwoa', email: 'adwoa@demo.gh', name: 'Adwoa Frimpong', role: 'customer', what: 'Business owner — Adwoa Styles (bulk upload, invoices)', phone: '+233244556677' },
];
export const DRIVERS = [
  { uid: 'd_kwame', email: 'kwame@demo.gh', name: 'Kwame Mensah', phone: '+233244111222', employeeNumber: 'RDR-001', area: 'accra', riderType: 'pickup' as const },
  { uid: 'd_kojo', email: 'kojo@demo.gh', name: 'Kojo Asante', phone: '+233244555666', employeeNumber: 'RDR-002', area: 'accra', riderType: 'pickup' as const },
  { uid: 'd_esi', email: 'esi@demo.gh', name: 'Esi Owusu', phone: '+233244333444', employeeNumber: 'RDR-003', area: 'accra', riderType: 'delivery' as const },
  { uid: 'd_abena', email: 'abena@demo.gh', name: 'Abena Ofori', phone: '+233244999000', employeeNumber: 'RDR-004', area: 'accra', riderType: 'delivery' as const },
  { uid: 'd_yaw', email: 'yaw@demo.gh', name: 'Yaw Kyei', phone: '+233244777888', employeeNumber: 'RDR-005', area: 'kumasi', riderType: 'pickup' as const },
];
const SENDERS = [
  ['Kofi Boateng', '0501234567'],
  ['Akua Amoah', '0244987654'],
  ['Musa Ibrahim', '0277123456'],
  ['Grace Tetteh', '0209876543'],
  ['Selorm Agbeko', '0551237890'],
] as const;

const OTP = '246810';
const day = (d: Date, h: number, m = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m));
const addr = (label: string, line1?: string): Address => {
  const p = place(label);
  return { line1: line1 ?? p.label.split(',')[0]!, city: p.city!, region: p.region as Address['region'], location: p.location };
};
const ACCRA = ['Madina Market, Madina, Accra', 'East Legon, Lagos Avenue, Accra', 'Labadi Beach Road, La, Accra', 'Achimota Mall, Achimota, Accra', 'Kaneshie Market, Kaneshie, Accra', 'Dansoman Roundabout, Dansoman, Accra', 'University of Ghana, Legon', 'Accra Mall, Spintex Road, Accra', 'Makola Market, Accra Central', 'Kotoka International Airport, Accra'];
const PACKAGES = [
  [{ description: 'Shoes', weightKg: 2, lengthCm: 35, widthCm: 25, heightCm: 15, quantity: 1 }],
  [{ description: 'Documents', weightKg: 0.5, lengthCm: 32, widthCm: 24, heightCm: 2, quantity: 1 }],
  [{ description: 'Phone accessories', weightKg: 1, lengthCm: 25, widthCm: 20, heightCm: 10, quantity: 2 }],
  [{ description: 'Kente cloth', weightKg: 1.5, lengthCm: 40, widthCm: 30, heightCm: 8, quantity: 1 }],
];

let seq = 0;
const actionId = () => `demo${String(++seq).padStart(16, '0')}`;

async function act(uid: string, at: Date, deliveryId: string, type: string, extra: Record<string, unknown> = {}) {
  return withClock(at, () => callAs(uid, 'driverAction', { actionId: actionId(), deliveryId, type, occurredAt: at.toISOString(), ...extra }));
}

async function book(at: Date, caller: string | null, from: Address, to: Address, opts: { pref?: string; urgency?: string; i?: number; sender?: readonly [string, string] } = {}) {
  const i = opts.i ?? seq;
  const quote = { pickup: from, destination: to, packages: PACKAGES[i % PACKAGES.length], urgency: opts.urgency ?? 'standard', specialHandling: [] };
  const sender = opts.sender ?? SENDERS[i % SENDERS.length]!;
  const recipient = SENDERS[(i + 2) % SENDERS.length]!;
  return withClock(at, async () => {
    const q = await callAs<{ quoteId: string }>(caller, 'getQuote', quote);
    const b = await callAs<{ trackingNumber: string; totalPesewas: number }>(caller, 'createBooking', {
      quoteId: q.quoteId,
      quote,
      sender: { name: sender[0], phone: sender[1] },
      recipient: { name: recipient[0], phone: recipient[1] },
      acceptTerms: true,
      paymentPreference: opts.pref ?? 'cash_on_pickup',
    });
    const record = services().store;
    const booking = await record.getBooking(b.trackingNumber);
    if (booking) await ensureDeliveryForBooking({ ops: services().opsStore, now: () => at }, booking);
    return b;
  });
}

const assign = (at: Date, tn: string, rider: string) => withClock(at, () => callAs('d_dispatch', 'dispatchAction', { type: 'assign', deliveryId: tn, driverUid: rider }));
const scan = (at: Date, tn: string, type: 'receive' | 'handover') => withClock(at, () => callAs('d_hub_acc', 'hubScan', { hubId: 'acc-01', type, trackingNumber: tn }));

/** Pickup rider brings it to the warehouse; delivery rider takes it to the recipient. */
async function deliver(pickupRider: string, deliveryRider: string, tn: string, start: Date) {
  const t = (min: number) => new Date(start.getTime() + min * 60_000);
  await assign(t(0), tn, pickupRider);
  await act(pickupRider, t(1), tn, 'start_assignment');
  await act(pickupRider, t(20), tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true });
  await scan(t(45), tn, 'receive');
  await assign(t(50), tn, deliveryRider);
  await scan(t(60), tn, 'handover');
  await act(deliveryRider, t(95), tn, 'complete_delivery', { receivedByName: 'Recipient', otp: OTP });
}

function account(p: { uid: string; email: string; name: string; phone?: string }, claims: Record<string, unknown>): DemoAccount {
  const a: DemoAccount = { uid: p.uid, email: p.email, phone: p.phone ?? null, password: DEMO_PASSWORD, displayName: p.name, emailVerified: true, claims };
  saveAccount(a);
  theDb().commit([{ type: 'set', path: `users/${p.uid}`, data: { uid: p.uid, role: claims.role ?? null, businessId: claims.businessId ?? null, email: p.email, name: p.name, ...(claims.hubIds ? { hubIds: claims.hubIds } : {}) }, merge: true }]);
  return a;
}

export async function seed(now = new Date()) {
  const s = services();
  const db = theDb();
  const realOtp = s.opsDeps.newOtp;
  s.opsDeps.newOtp = () => OTP;
  try {
    // ---- Network, prices, accounts ----------------------------------------------------------
    const areas = z.array(serviceAreaSchema).parse(areasJson);
    const hubs = z.array(hubSchema).parse((networkJson as { hubs: unknown[] }).hubs);
    const routes = z.array(routeSchema).parse((networkJson as { routes: unknown[] }).routes);
    db.commit([
      ...areas.map(({ id, ...rest }) => ({ type: 'set' as const, path: `serviceAreas/${id}`, data: rest })),
      ...hubs.map((h) => ({ type: 'set' as const, path: `hubs/${h.id}`, data: { ...h, phone: h.phone ?? null } })),
      ...routes.map((r) => {
        const o = hubs.find((h) => h.id === r.originHubId)!;
        const d = hubs.find((h) => h.id === r.destinationHubId)!;
        return { type: 'set' as const, path: `routes/${r.id}`, data: { ...r, originAreaId: o.serviceAreaId, destinationAreaId: d.serviceAreaId } };
      }),
    ]);
    const { version: _v, ...rules } = pricingRuleSetSchema.parse({ ...(pricingJson as object), version: 1 });
    await withClock(new Date(now.getTime() - 60 * 86_400_000), () => s.store.publishPricingRules(rules, { actorUid: null, actorRole: 'system', action: 'pricing.publish', targetType: 'pricingRules' }));

    for (const p of PEOPLE) account(p, { role: p.role, ...(p.extra ?? {}) });
    for (const d of DRIVERS) {
      account(d, { role: 'driver' });
      await s.opsStore.createDriver({ uid: d.uid, name: d.name, phone: d.phone, email: d.email, employeeNumber: d.employeeNumber, homeServiceAreaId: d.area, riderType: d.riderType, status: 'active', currentShift: null });
    }
    const vehicles = [
      { id: 'bike-01', registrationNumber: 'M-24-GR 1101', vehicleClass: 'motorbike', capacityKg: 25, homeServiceAreaId: 'accra' },
      { id: 'bike-02', registrationNumber: 'M-24-GR 1102', vehicleClass: 'motorbike', capacityKg: 25, homeServiceAreaId: 'accra' },
      { id: 'bike-03', registrationNumber: 'M-24-GR 1103', vehicleClass: 'motorbike', capacityKg: 25, homeServiceAreaId: 'accra' },
      { id: 'van-01', registrationNumber: 'GR 4521-24', vehicleClass: 'van', capacityKg: 900, homeServiceAreaId: 'accra' },
      { id: 'bike-ks1', registrationNumber: 'M-24-AS 2201', vehicleClass: 'motorbike', capacityKg: 25, homeServiceAreaId: 'kumasi' },
    ];
    for (const v of vehicles) await callAs('d_owner', 'upsertVehicle', { ...v, status: 'available' });
    await callAs('d_finance', 'setDriverPayRules', { dailyRatePesewas: 8_000, perJobPesewas: { direct: 500, first_mile: 300, last_mile: 400 }, perLinehaulTripPesewas: 6_000 });
    const lastServiceAt = new Date(now.getTime() - 70 * 86_400_000).toISOString();
    for (const [id, insuranceDays] of [['bike-01', 200], ['bike-02', 9], ['van-01', 120]] as const) {
      await callAs('d_fleet', 'setVehicleSchedule', { vehicleId: id, serviceIntervalKm: 3000, serviceIntervalDays: 90, insuranceExpiry: new Date(now.getTime() + insuranceDays * 86_400_000).toISOString(), roadworthyExpiry: new Date(now.getTime() + 150 * 86_400_000).toISOString() });
    }
    db.commit([{ type: 'update', path: 'vehicles/bike-01', data: { lastServiceAt, lastServiceKm: 10_000 } }, { type: 'update', path: 'vehicles/bike-02', data: { lastServiceAt, lastServiceKm: 8_200 } }]);

    // ---- Business account ----------------------------------------------------------------------
    const bizStart = new Date(now.getTime() - 50 * 86_400_000);
    await withClock(bizStart, async () => {
      await callAs('d_adwoa', 'completeSignUp', { displayName: 'Adwoa Frimpong' });
      const ticket = await callAs<{ key: string }>('d_adwoa', 'requestBusinessDocumentUpload', { contentType: 'application/pdf', bytes: 2000 });
      await storeFile(ticket.key, new Blob(['%PDF-1.4\n% Demo certificate of incorporation\n%%EOF\n'], { type: 'application/pdf' }));
      const office = addr('Accra Mall, Spintex Road, Accra', 'Adwoa Styles, Accra Mall shop 14');
      await callAs('d_adwoa', 'registerBusiness', {
        legalName: 'Adwoa Styles Enterprise Ltd',
        tradingName: 'Adwoa Styles',
        registrationNumber: 'CS123456789',
        tin: 'C0012345678',
        contact: { name: 'Adwoa Frimpong', phone: '0244556677', email: 'adwoa@demo.gh' },
        pickupAddress: office,
        billingAddress: office,
        documentKeys: [ticket.key],
      });
    });
    const bizId = getAccount('d_adwoa')!.claims.businessId as string;
    await withClock(new Date(bizStart.getTime() + 86_400_000), async () => {
      await callAs('d_owner', 'reviewBusiness', { businessId: bizId, decision: 'verified' });
      await callAs('d_finance', 'setCreditTerms', { businessId: bizId, limitPesewas: 500_000, termDays: 30 });
    });

    // ---- Six weeks of deliveries (a pickup rider and a delivery rider), fuel, expenses -------------
    const days: Date[] = [];
    for (let k = 40; k >= 2; k -= 3) days.push(new Date(now.getTime() - k * 86_400_000));
    let odo: Record<string, number> = { d_kwame: 12_400, d_esi: 9_100 };
    const bikeOf: Record<string, string> = { d_kwame: 'bike-01', d_esi: 'bike-02' };
    const RIDERS = ['d_kwame', 'd_esi'];
    let n = 0;
    for (const d of days) {
      for (const r of RIDERS) await withClock(day(d, 7, 30), () => callAs(r, 'startShift', { vehicleId: bikeOf[r], odometerKm: odo[r] }));
      const jobs = 4 + (n % 3);
      for (let j = 0; j < jobs; j++) {
        n++;
        const business = n % 4 === 0;
        const from = business ? addr('Accra Mall, Spintex Road, Accra', 'Adwoa Styles, Accra Mall shop 14') : addr(ACCRA[n % ACCRA.length]!);
        let toLabel = ACCRA[(n + 3) % ACCRA.length]!;
        if (business && toLabel.startsWith('Accra Mall')) toLabel = ACCRA[(n + 4) % ACCRA.length]!;
        const to = addr(toLabel);
        const caller = business ? 'd_adwoa' : n % 3 === 0 ? 'd_ama' : null;
        const b = await book(day(d, 8, j * 10), caller, from, to, { pref: business ? 'business_invoice' : 'cash_on_pickup', i: n, ...(caller === 'd_ama' ? { sender: ['Ama Mensah', '0241234567'] as const } : {}) });
        await deliver('d_kwame', 'd_esi', b.trackingNumber, day(d, 8, 40 + j * 75));
      }
      for (const r of RIDERS) {
        const km = 35 + ((n * 7) % 30);
        if (n % 3 === 0) await withClock(day(d, 16), () => callAs(r, 'logFuel', { litres: 6, amountPesewas: 9_000, odometerKm: odo[r]! + Math.round(km / 2), fullTank: true, station: 'GOIL Osu' }));
        odo = { ...odo, [r]: odo[r]! + km };
        await withClock(day(d, 18, 30), () => callAs(r, 'endShift', { odometerKm: odo[r] }));
      }
    }
    // Approve the fuel expenses; a service and a hub cost.
    await withClock(new Date(now.getTime() - 20 * 86_400_000), async () => {
      await callAs('d_fleet', 'recordMaintenance', { vehicleId: 'van-01', type: 'service', description: 'Full service and brake pads', costPesewas: 85_000, odometerKm: 30_500, performedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString(), vendor: 'Abossey Okai Motors' });
      await callAs('d_finance', 'submitExpense', { category: 'hub', hubId: 'acc-01', description: 'Generator diesel', amountPesewas: 24_000, incurredAt: new Date(now.getTime() - 20 * 86_400_000).toISOString() });
    });
    for (const [id, e] of db.list('expenses')) {
      if (e.status === 'submitted' && e.submittedBy !== 'd_owner') await withClock(new Date(Math.min(now.getTime() - 3600_000, Date.parse(String(e.incurredAt)) + 86_400_000)), () => callAs('d_owner', 'reviewExpense', { expenseId: id, decision: 'approved' }));
    }

    // ---- Month end: invoice the business, pay drivers, cash handed in -----------------------------
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9));
    await withClock(monthStart, async () => {
      const inv = await callAs<{ invoices: { id: string; totalPesewas: number }[] }>('d_finance', 'generateInvoices', { period: prev });
      const first = inv.invoices[0];
      if (first) await callAs('d_finance', 'recordInvoicePayment', { invoiceId: first.id, amountPesewas: Math.round(first.totalPesewas / 2), method: 'mobile_money', reference: 'MOMO-778812' });
      await callAs('d_finance', 'generateDriverPay', { period: prev });
    });
    await withClock(new Date(monthStart.getTime() + 2 * 86_400_000), async () => {
      for (const d of RIDERS) {
        const id = `${prev}_${d}`;
        if (!db.get(`driverPayments/${id}`)) continue;
        await callAs('d_finance', 'approveDriverPay', { statementId: id });
        await callAs('d_finance', 'markDriverPaid', { statementId: id, method: 'mobile_money', reference: `MOMO-PAY-${d.slice(2).toUpperCase()}` });
      }
      for (const d of RIDERS) {
        const cash = db.get(`driverCash/${d}`) as { collectedPesewas?: number; remittedPesewas?: number } | undefined;
        const held = (cash?.collectedPesewas ?? 0) - (cash?.remittedPesewas ?? 0);
        if (held > 2000) await callAs('d_finance', 'recordCashRemittance', { driverUid: d, amountPesewas: held - 2000, method: 'cash', reference: 'Accra warehouse safe' });
      }
    });

    // ---- Today: riders on the road, an order at every stage ------------------------------------------
    const t = (min: number) => new Date(now.getTime() - min * 60_000);
    await withClock(t(150), () => callAs('d_kwame', 'startShift', { vehicleId: 'bike-01', odometerKm: odo.d_kwame }));
    await withClock(t(145), () => callAs('d_kojo', 'startShift', { vehicleId: 'van-01', odometerKm: 31_020 }));
    await withClock(t(140), () => callAs('d_esi', 'startShift', { vehicleId: 'bike-02', odometerKm: odo.d_esi }));
    await withClock(t(135), () => callAs('d_abena', 'startShift', { vehicleId: 'bike-03', odometerKm: 4_250 }));
    // Delivered this morning.
    const early = await book(t(135), null, addr('Kaneshie Market, Kaneshie, Accra'), addr('Labadi Beach Road, La, Accra'), { i: 7 });
    await deliver('d_kwame', 'd_abena', early.trackingNumber, t(130));
    // Out for delivery with Abena.
    const outNow = await book(t(125), 'd_ama', addr('Oxford Street, Osu, Accra'), addr('East Legon, Lagos Avenue, Accra'), { i: 1, sender: ['Ama Mensah', '0241234567'] });
    await assign(t(120), outNow.trackingNumber, 'd_kwame');
    await act('d_kwame', t(118), outNow.trackingNumber, 'start_assignment');
    await act('d_kwame', t(95), outNow.trackingNumber, 'confirm_pickup', { scannedCode: outNow.trackingNumber, cashCollected: true });
    await scan(t(70), outNow.trackingNumber, 'receive');
    await assign(t(40), outNow.trackingNumber, 'd_abena');
    await scan(t(30), outNow.trackingNumber, 'handover');
    // At the warehouse: one waiting for a delivery rider, one with Esi assigned (ready to hand over).
    const waiting = await book(t(110), null, addr('Dansoman Roundabout, Dansoman, Accra'), addr('Madina Market, Madina, Accra'), { i: 8 });
    await assign(t(105), waiting.trackingNumber, 'd_kojo');
    await act('d_kojo', t(100), waiting.trackingNumber, 'start_assignment');
    await act('d_kojo', t(75), waiting.trackingNumber, 'confirm_pickup', { scannedCode: waiting.trackingNumber, cashCollected: true });
    await scan(t(45), waiting.trackingNumber, 'receive');
    const ready = await book(t(100), 'd_adwoa', addr('Accra Mall, Spintex Road, Accra', 'Adwoa Styles, Accra Mall shop 14'), addr('University of Ghana, Legon'), { pref: 'business_invoice', i: 3 });
    await assign(t(95), ready.trackingNumber, 'd_kojo');
    await act('d_kojo', t(93), ready.trackingNumber, 'start_assignment');
    await act('d_kojo', t(70), ready.trackingNumber, 'confirm_pickup', { scannedCode: ready.trackingNumber });
    await scan(t(40), ready.trackingNumber, 'receive');
    await assign(t(10), ready.trackingNumber, 'd_esi');
    // Picked up, on the way to the warehouse with Kwame.
    const coming = await book(t(60), null, addr('Makola Market, Accra Central'), addr('Dansoman Roundabout, Dansoman, Accra'), { i: 2 });
    await assign(t(50), coming.trackingNumber, 'd_kwame');
    await act('d_kwame', t(48), coming.trackingNumber, 'start_assignment');
    await act('d_kwame', t(20), coming.trackingNumber, 'confirm_pickup', { scannedCode: coming.trackingNumber, cashCollected: true });
    // Kwame's next pickup (assigned, not started).
    const next = await book(t(35), 'd_ama', addr('Labadi Beach Road, La, Accra'), addr('Achimota Mall, Achimota, Accra'), { i: 5, sender: ['Ama Mensah', '0241234567'] });
    await assign(t(25), next.trackingNumber, 'd_kwame');
    // New orders waiting for a pickup rider.
    await book(t(15), null, addr('Achimota Mall, Achimota, Accra'), addr('Kotoka International Airport, Accra'), { urgency: 'express', i: 4 });
    await book(t(8), null, addr('University of Ghana, Legon'), addr('Makola Market, Accra Central'), { i: 9 });
    await withClock(t(5), () => callAs('d_dispatch', 'planDriverRoute', { driverUid: 'd_kwame' }));
  } finally {
    s.opsDeps.newOtp = realOtp;
  }
}
