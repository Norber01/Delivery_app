import type { FinanceReport, MoneyByKey } from '@courier/shared-types';
import { fuelStats } from '@courier/shared-utils';
import { financeReportSchema } from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { parse, periodRange } from './common.js';
import { FINANCE_ROLES } from './fleetService.js';
import type { FleetStore, LedgerTotals, PeriodData } from './types.js';

/**
 * Monthly finance report.
 *
 * Revenue is the confirmed price of bookings made in the month (cancelled and unpaid-online
 * bookings excluded). Costs are approved expenses incurred in the month (fuel, maintenance, hub,
 * other and driver pay — driver pay becomes an expense when it is paid). Contribution = revenue −
 * costs, broken down three ways:
 *  - service area: bookings by pickup area; vehicle costs by the vehicle's home area, hub costs by
 *    the hub's area, driver pay by the driver's home area; anything else is "Company-wide";
 *  - intercity route: bookings on the route; linehaul vehicle costs shared by the vehicle's
 *    linehaul trips that month (an approximation: those vehicles may also do city work);
 *  - vehicle: each booking's price split equally between the vehicles that carried it; the
 *    vehicle's fuel and maintenance.
 * Checks cross-check independent records so the books can be trusted (see `checks`).
 */
export function buildFinanceReport(period: string, d: PeriodData, ledger: LedgerTotals, now: Date): FinanceReport {
  const [start, end] = periodRange(period);
  const inPeriod = (iso: string) => iso >= start.toISOString() && iso < end.toISOString();
  const deliveries = new Map(d.deliveries.map((x) => [x.id, x]));
  const counted = d.bookings.filter((b) => b.status === 'confirmed');
  const revenue = { bookedPesewas: 0, deliveries: counted.length, byType: {} as Record<string, number> };

  type Acc = { label: string; revenue: number; cost: number; deliveries: number };
  const area = new Map<string, Acc>();
  const route = new Map<string, Acc>();
  const vehicle = new Map<string, Acc>();
  const acc = (m: Map<string, Acc>, key: string, label: string) => {
    if (!m.has(key)) m.set(key, { label, revenue: 0, cost: 0, deliveries: 0 });
    return m.get(key)!;
  };
  const areaName = (id: string | null | undefined) => d.areas.find((a) => a.id === id)?.name ?? 'Company-wide';
  const vehicleName = (id: string) => d.vehicles.find((v) => v.id === id)?.registrationNumber ?? id;

  for (const b of counted) {
    const amount = b.price.totalPesewas;
    revenue.bookedPesewas += amount;
    revenue.byType[b.deliveryType] = (revenue.byType[b.deliveryType] ?? 0) + amount;
    const del = deliveries.get(b.trackingNumber);
    const areaId = del?.serviceAreaId ?? 'company';
    const a = acc(area, areaId, areaName(areaId));
    a.revenue += amount;
    a.deliveries++;
    if (del?.routeId) {
      const r = acc(route, del.routeId, d.routes.find((x) => x.id === del.routeId)?.code ?? del.routeId);
      r.revenue += amount;
      r.deliveries++;
    }
    const vehicles = [...new Set((del?.legs ?? []).map((l) => l.vehicleId).filter((v): v is string => !!v))];
    vehicles.forEach((v, i) => {
      const share = Math.floor(amount / vehicles.length) + (i < amount % vehicles.length ? 1 : 0);
      const x = acc(vehicle, v, vehicleName(v));
      x.revenue += share;
      x.deliveries++;
    });
  }

  // Costs (approved, incurred this month).
  const approved = d.expenses.filter((e) => e.status === 'approved' && inPeriod(e.incurredAt));
  const costs = { byCategory: {} as Record<string, number>, totalPesewas: 0, pendingApprovalPesewas: d.expenses.filter((e) => e.status === 'submitted' && inPeriod(e.incurredAt)).reduce((n, e) => n + e.amountPesewas, 0) };
  const linehaulByVehicle = new Map<string, Map<string, number>>();
  for (const m of d.manifests) {
    const per = linehaulByVehicle.get(m.vehicleId) ?? new Map<string, number>();
    per.set(m.routeId, (per.get(m.routeId) ?? 0) + 1);
    linehaulByVehicle.set(m.vehicleId, per);
  }
  for (const e of approved) {
    costs.byCategory[e.category] = (costs.byCategory[e.category] ?? 0) + e.amountPesewas;
    costs.totalPesewas += e.amountPesewas;
    let areaId: string | null = null;
    if (e.vehicleId) {
      const v = d.vehicles.find((x) => x.id === e.vehicleId);
      areaId = v?.homeServiceAreaId ?? null;
      acc(vehicle, e.vehicleId, vehicleName(e.vehicleId)).cost += e.amountPesewas;
      const trips = linehaulByVehicle.get(e.vehicleId);
      if (trips) {
        const total = [...trips.values()].reduce((n, k) => n + k, 0);
        let left = e.amountPesewas;
        [...trips.entries()].forEach(([routeId, k], i, all) => {
          const share = i === all.length - 1 ? left : Math.round((e.amountPesewas * k) / total);
          left -= share;
          acc(route, routeId, d.routes.find((x) => x.id === routeId)?.code ?? routeId).cost += share;
        });
      }
    } else if (e.hubId) areaId = d.hubs.find((h) => h.id === e.hubId)?.serviceAreaId ?? null;
    else if (e.driverUid) areaId = d.drivers.find((x) => x.uid === e.driverUid)?.homeServiceAreaId ?? null;
    acc(area, areaId ?? 'company', areaName(areaId)).cost += e.amountPesewas;
  }

  const rows = (m: Map<string, Acc>): MoneyByKey[] =>
    [...m.entries()]
      .map(([key, a]) => ({ key, label: a.label, revenuePesewas: a.revenue, costPesewas: a.cost, contributionPesewas: a.revenue - a.cost, deliveries: a.deliveries }))
      .sort((x, y) => y.revenuePesewas - x.revenuePesewas || x.label.localeCompare(y.label));

  const byVehicle = rows(vehicle).map((r) => {
    const km = d.shifts.filter((s) => s.vehicleId === r.key && s.startOdometerKm !== null && s.endOdometerKm !== null).reduce((n, s) => n + Math.max(0, s.endOdometerKm! - s.startOdometerKm!), 0);
    const fuel = fuelStats(d.fuelLogs.filter((f) => f.vehicleId === r.key));
    return { ...r, kmDriven: km, fuelLitres: fuel.litres, kmPerLitre: fuel.kmPerLitre, costPerKmPesewas: km > 0 ? Math.round(r.costPesewas / km) : null };
  });

  const collections = {
    onlinePesewas: d.payments.filter((p) => p.provider !== 'cash').reduce((n, p) => n + p.amountPesewas, 0),
    cashCollectedPesewas: d.payments.filter((p) => p.provider === 'cash').reduce((n, p) => n + p.amountPesewas, 0),
    invoicePaymentsPesewas: d.invoices.flatMap((i) => i.payments).filter((p) => inPeriod(p.at)).reduce((n, p) => n + p.amountPesewas, 0),
    refundsPesewas: d.refunds.reduce((n, r) => n + r.amountPesewas, 0),
    cashRemittedPesewas: d.remittances.reduce((n, r) => n + r.amountPesewas, 0),
  };

  const contribution = revenue.bookedPesewas - costs.totalPesewas;
  const byArea = rows(area);
  const delivered = counted.filter((b) => deliveries.get(b.trackingNumber)?.status === 'delivered');
  const settled = delivered.filter((b) => b.paymentStatus === 'paid' || b.paymentStatus === 'refunded' || b.paymentPreference === 'business_invoice');
  const paidStatements = d.statements.filter((s) => s.status === 'paid');
  const payExpenses = d.expenses.filter((e) => e.category === 'driver_payment' && paidStatements.some((s) => s.id === e.sourceId));
  const check = (name: string, expected: number, actual: number, note: string) => ({ name, ok: expected === actual, expectedPesewas: expected, actualPesewas: actual, note });
  const checks = [
    check('Cash collected by drivers matches cash payments', ledger.cashPaymentsPesewas, ledger.ledgerCollectedPesewas, 'All time: drivers’ cash ledgers vs cash payment records.'),
    check('Cash handed in matches remittance records', ledger.remittancesPesewas, ledger.ledgerRemittedPesewas, 'All time: drivers’ ledgers vs recorded hand-ins.'),
    check(
      'Invoice balances match recorded payments',
      d.invoices.reduce((n, i) => n + i.payments.reduce((m, p) => m + p.amountPesewas, 0), 0),
      d.invoices.reduce((n, i) => n + i.paidPesewas, 0),
      'Every invoice’s paid amount equals the sum of its payments.',
    ),
    check(
      'Delivered parcels were paid for or invoiced',
      delivered.reduce((n, b) => n + b.price.totalPesewas, 0),
      settled.reduce((n, b) => n + b.price.totalPesewas, 0),
      `${delivered.length - settled.length} delivered booking(s) this month without a payment or invoice.`,
    ),
    check('Driver pay paid out matches pay expenses', paidStatements.reduce((n, s) => n + s.grossPesewas, 0), payExpenses.reduce((n, e) => n + e.amountPesewas, 0), 'Statements paid this month vs driver-pay expenses.'),
    check('Area breakdown adds up to the total', contribution, byArea.reduce((n, a) => n + a.contributionPesewas, 0), 'Every booking and approved cost is assigned to exactly one area.'),
  ];

  return {
    period,
    computedAt: now.toISOString(),
    revenue,
    collections,
    costs,
    contributionPesewas: contribution,
    byArea,
    byRoute: rows(route),
    byVehicle,
    checks,
  };
}

/** Finance/admin: the month's report (recomputed when asked, or when older than 10 minutes). */
export async function getFinanceReport(deps: { fleet: FleetStore; now: () => Date }, caller: Caller, raw: unknown): Promise<FinanceReport> {
  requireRole(caller, FINANCE_ROLES);
  const { period, refresh } = parse(financeReportSchema, raw);
  const [start, end] = periodRange(period);
  const now = deps.now();
  if (start > now) throw new AppError('VALIDATION_FAILED', 'That month has not started.', 'invalid-argument');
  const cached = refresh ? null : await deps.fleet.getReport(period);
  if (cached && now.getTime() - Date.parse(cached.computedAt) < 10 * 60_000) return cached;
  const [data, ledger] = await Promise.all([deps.fleet.periodData(start, end), deps.fleet.ledgerTotals()]);
  const report = buildFinanceReport(period, data, ledger, now);
  await deps.fleet.saveReport(report);
  return report;
}
