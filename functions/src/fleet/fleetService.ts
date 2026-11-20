import type { Role } from '@courier/constants';
import type { DriverDoc, DriverPayRules, DriverPayStatement, ExpenseDoc, FuelLog, MaintenanceRecord, PayLine, ShiftRecord, UploadTicket, VehicleDoc } from '@courier/shared-types';
import { evidenceUrl, formatGhs, maintenanceStatus } from '@courier/shared-utils';
import {
  approvePaySchema,
  cashRemittanceSchema,
  expenseSchema,
  fuelLogSchema,
  generatePaySchema,
  maintenanceSchema,
  markPaidSchema,
  payAdjustmentSchema,
  payRulesSchema,
  receiptUploadSchema,
  reviewExpenseSchema,
  vehicleScheduleSchema,
} from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/hash.js';
import type { EvidenceStore } from '../ops/types.js';
import { audit, isRefusal, parse, periodRange, refuse } from './common.js';
import type { FleetStore } from './types.js';

export interface FleetDeps {
  fleet: FleetStore;
  evidence: EvidenceStore;
  uploads: { workerUrl: string; secret: string };
  now: () => Date;
  newId: () => string;
}

export const FLEET_ROLES: Role[] = ['fleet_manager', 'manager', 'admin', 'super_admin'];
export const FINANCE_ROLES: Role[] = ['finance', 'manager', 'admin', 'super_admin'];
/** A reading this far above the last one is almost certainly a typing mistake. */
export const MAX_ODOMETER_JUMP_KM = 3000;

// ---- Shifts and odometer (called from startShift / endShift) -----------------------------------

/**
 * Before a shift starts (nothing is written here): legal documents must be valid, and an odometer
 * reading must be plausible. The reading is recorded once the shift has actually started.
 */
export async function checkVehicleForShift(deps: Pick<FleetDeps, 'fleet' | 'now'>, vehicleId: string, odometerKm: number | undefined) {
  const v = await deps.fleet.getVehicle(vehicleId);
  if (!v) return;
  const m = maintenanceStatus(v, deps.now());
  if (m.documentsExpired) {
    throw new AppError('VEHICLE_DOCUMENTS_EXPIRED', `This vehicle cannot be driven: ${m.reasons.filter((r) => r.includes('expired')).join(', ')}. Tell your fleet manager.`);
  }
  if (odometerKm !== undefined) {
    const problem = odometerProblem(v.odometerKm ?? null, odometerKm);
    if (problem) throw new AppError('ODOMETER_INVALID', problem);
  }
}

/** Why a reading cannot be right, or null. Readings never go down and cannot jump implausibly. */
export function odometerProblem(previous: number | null, km: number): string | null {
  if (previous === null) return null;
  if (km < previous) return `The odometer reading cannot be lower than the last one (${previous} km). Check the number.`;
  if (km - previous > MAX_ODOMETER_JUMP_KM) return `That is ${km - previous} km more than the last reading (${previous} km). Check the number.`;
  return null;
}

async function recordOdometer(deps: Pick<FleetDeps, 'fleet'>, vehicleId: string, km: number) {
  const r = await deps.fleet.recordOdometer(vehicleId, km, MAX_ODOMETER_JUMP_KM);
  if (isRefusal(r)) refuse({ ...r, code: 'ODOMETER_INVALID' });
}

export async function shiftStarted(deps: Pick<FleetDeps, 'fleet'>, driverUid: string, shift: NonNullable<DriverDoc['currentShift']>, odometerKm: number | undefined) {
  if (odometerKm !== undefined) await deps.fleet.recordOdometer(shift.vehicleId, odometerKm, MAX_ODOMETER_JUMP_KM);
  await deps.fleet.recordShiftStart({ id: shift.id, driverUid, vehicleId: shift.vehicleId, startedAt: shift.startedAt, endedAt: null, startOdometerKm: odometerKm ?? null, endOdometerKm: null });
}

export async function shiftEnding(deps: Pick<FleetDeps, 'fleet'>, shift: NonNullable<DriverDoc['currentShift']>, odometerKm: number | undefined) {
  if (odometerKm !== undefined) await recordOdometer(deps, shift.vehicleId, odometerKm);
}

export async function shiftEnded(deps: Pick<FleetDeps, 'fleet' | 'now'>, shiftId: string, odometerKm: number | undefined) {
  await deps.fleet.recordShiftEnd(shiftId, deps.now().toISOString(), odometerKm ?? null);
}

// ---- Vehicle schedule and maintenance --------------------------------------------------------------

export async function setVehicleSchedule(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FLEET_ROLES);
  const input = parse(vehicleScheduleSchema, raw);
  const v = await deps.fleet.getVehicle(input.vehicleId);
  if (!v) throw new AppError('NOT_FOUND', 'Vehicle not found.', 'not-found');
  const patch: Partial<VehicleDoc> = {
    serviceIntervalKm: input.serviceIntervalKm,
    serviceIntervalDays: input.serviceIntervalDays,
    insuranceExpiry: input.insuranceExpiry,
    roadworthyExpiry: input.roadworthyExpiry,
  };
  await deps.fleet.updateVehicle(v.id, patch, audit(caller, 'vehicle.schedule', 'vehicle', v.id, { after: patch }));
  return { vehicleId: v.id };
}

async function checkReceipt(deps: FleetDeps, caller: Caller & { uid: string }, key: string | undefined) {
  if (!key) return null;
  const t = await deps.fleet.getUploadTicket(key);
  if (!t || t.driverUid !== caller.uid || !(await deps.evidence.exists(key))) {
    throw new AppError('UPLOAD_NOT_FOUND', 'The receipt photo has not finished uploading. Try again.');
  }
  return key;
}

export async function recordMaintenance(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FLEET_ROLES);
  const input = parse(maintenanceSchema, raw);
  const v = await deps.fleet.getVehicle(input.vehicleId);
  if (!v) throw new AppError('NOT_FOUND', 'Vehicle not found.', 'not-found');
  const receiptKey = await checkReceipt(deps, caller, input.receiptKey);
  if (input.odometerKm !== null) await recordOdometer(deps, v.id, input.odometerKm);
  const id = `mnt_${deps.newId()}`;
  const expense: ExpenseDoc | null =
    input.costPesewas > 0
      ? {
          id: `exp_${deps.newId()}`,
          category: 'maintenance',
          description: `${input.type}: ${input.description} (${v.registrationNumber})`,
          amountPesewas: input.costPesewas,
          vehicleId: v.id,
          hubId: null,
          driverUid: null,
          receiptKey,
          incurredAt: input.performedAt,
          status: 'submitted',
          submittedBy: caller.uid,
          reviewedBy: null,
          reviewNote: null,
          sourceId: id,
        }
      : null;
  const record: MaintenanceRecord = {
    id,
    vehicleId: v.id,
    type: input.type,
    description: input.description,
    costPesewas: input.costPesewas,
    odometerKm: input.odometerKm,
    performedAt: input.performedAt,
    vendor: input.vendor ?? null,
    receiptKey,
    expenseId: expense?.id ?? null,
    recordedBy: caller.uid,
  };
  // A service resets the service clock (distance and date).
  const patch = input.type === 'service' ? { lastServiceAt: input.performedAt, lastServiceKm: input.odometerKm ?? v.odometerKm ?? null } : null;
  await deps.fleet.addMaintenance(record, expense, patch, audit(caller, 'vehicle.maintenance', 'vehicle', v.id, { after: { id, type: input.type, costPesewas: input.costPesewas } }));
  return { id, expenseId: expense?.id ?? null };
}

// ---- Receipts and fuel ------------------------------------------------------------------------------

/** Signed upload URL for a receipt photo (drivers: fuel; fleet/finance/hub staff: other expenses). */
export async function requestReceiptUpload(deps: FleetDeps, caller: Caller, raw: unknown): Promise<UploadTicket> {
  requireRole(caller, ['driver', 'fleet_manager', 'finance', 'hub_operator', 'manager', 'admin', 'super_admin']);
  const input = parse(receiptUploadSchema, raw);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[input.contentType];
  const key = `receipt/${caller.uid}/${randomId(20)}.${ext}`;
  const expires = Math.floor(deps.now().getTime() / 1000) + 15 * 60;
  await deps.fleet.createUploadTicket({ key, deliveryId: `receipt:${caller.uid}`, driverUid: caller.uid, contentType: input.contentType, maxBytes: input.bytes, expiresAt: new Date(expires * 1000) });
  return {
    key,
    uploadUrl: await evidenceUrl(deps.uploads.workerUrl, deps.uploads.secret, { method: 'PUT', key, expires, contentType: input.contentType, maxBytes: input.bytes }),
    expiresAt: new Date(expires * 1000).toISOString(),
    maxBytes: input.bytes,
    contentType: input.contentType,
  };
}

/** A driver records a fill-up for the vehicle of their current shift. */
export async function logFuel(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, ['driver']);
  const input = parse(fuelLogSchema, raw, 'Check the fuel details.');
  const driver = await deps.fleet.getDriver(caller.uid);
  const shift = driver?.currentShift;
  if (!shift || Date.parse(shift.activeUntil) < deps.now().getTime()) throw new AppError('SHIFT_REQUIRED', 'Start your shift on the vehicle before recording fuel.');
  const vehicle = await deps.fleet.getVehicle(shift.vehicleId);
  if (!vehicle) throw new AppError('NOT_FOUND', 'Vehicle not found.', 'not-found');
  const receiptKey = await checkReceipt(deps, caller, input.receiptKey);
  const now = deps.now().toISOString();
  const log: FuelLog = {
    id: `fuel_${deps.newId()}`,
    vehicleId: vehicle.id,
    driverUid: caller.uid,
    litres: input.litres,
    amountPesewas: input.amountPesewas,
    odometerKm: input.odometerKm,
    fullTank: input.fullTank,
    station: input.station ?? null,
    receiptKey,
    expenseId: '',
    filledAt: now,
  };
  const expense: ExpenseDoc = {
    id: `exp_${deps.newId()}`,
    category: 'fuel',
    description: `${input.litres} L fuel — ${vehicle.registrationNumber}${input.station ? ` at ${input.station}` : ''}`,
    amountPesewas: input.amountPesewas,
    vehicleId: vehicle.id,
    hubId: null,
    driverUid: caller.uid,
    receiptKey,
    incurredAt: now,
    status: 'submitted',
    submittedBy: caller.uid,
    reviewedBy: null,
    reviewNote: null,
    sourceId: log.id,
  };
  log.expenseId = expense.id;
  const r = await deps.fleet.addFuelLog(log, expense, MAX_ODOMETER_JUMP_KM);
  if (isRefusal(r)) refuse({ ...r, code: 'ODOMETER_INVALID' });
  return { id: log.id };
}

// ---- Expenses ------------------------------------------------------------------------------------

export async function submitExpense(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, ['fleet_manager', 'finance', 'hub_operator', 'manager', 'admin', 'super_admin']);
  const input = parse(expenseSchema, raw);
  if (caller.role === 'hub_operator' && (input.category !== 'hub' || !caller.hubIds?.includes(input.hubId ?? ''))) {
    throw new AppError('PERMISSION_DENIED', 'Hub staff can only record expenses for their own hub.', 'permission-denied');
  }
  if (input.vehicleId && !(await deps.fleet.getVehicle(input.vehicleId))) throw new AppError('NOT_FOUND', 'Vehicle not found.', 'not-found');
  const e: ExpenseDoc = {
    id: `exp_${deps.newId()}`,
    category: input.category,
    description: input.description,
    amountPesewas: input.amountPesewas,
    vehicleId: input.vehicleId ?? null,
    hubId: input.hubId ?? null,
    driverUid: null,
    receiptKey: await checkReceipt(deps, caller, input.receiptKey),
    incurredAt: input.incurredAt,
    status: 'submitted',
    submittedBy: caller.uid,
    reviewedBy: null,
    reviewNote: null,
    sourceId: null,
  };
  await deps.fleet.createExpense(e, audit(caller, 'expense.submit', 'expense', e.id, { after: { category: e.category, amountPesewas: e.amountPesewas } }));
  return { id: e.id };
}

/** Finance approves or rejects. Nobody approves an expense they submitted themselves. */
export async function reviewExpense(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const input = parse(reviewExpenseSchema, raw);
  const r = await deps.fleet.updateExpense(
    input.expenseId,
    (e) => {
      if (e.status !== 'submitted') return { error: `This expense is already ${e.status}.` };
      if (e.submittedBy === caller.uid) return { error: 'Someone else must review an expense you submitted.' };
      return { status: input.decision, reviewedBy: caller.uid, reviewNote: input.note ?? null };
    },
    audit(caller, `expense.${input.decision}`, 'expense', input.expenseId, { after: { note: input.note ?? null } }),
  );
  if (!r) throw new AppError('NOT_FOUND', 'Expense not found.', 'not-found');
  if (isRefusal(r)) refuse(r);
  return { id: r.id, status: r.status };
}

// ---- Driver pay -------------------------------------------------------------------------------------

export async function setPayRules(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const input = parse(payRulesSchema, raw);
  const rules: DriverPayRules = { ...input, updatedBy: caller.uid, updatedAt: deps.now().toISOString() };
  await deps.fleet.setPayRules(rules, audit(caller, 'driverPay.rules', 'config', 'driverPay', { after: input }));
  return rules;
}

const JOB_LABEL = { direct: 'Same-city deliveries', first_mile: 'Collections to hub', last_mile: 'Deliveries from hub' } as const;

/** Pure calculation of one driver's statement lines (tested directly). */
export function payLines(
  rules: DriverPayRules,
  work: { days: number; jobs: Partial<Record<keyof typeof JOB_LABEL, number>>; linehaulTrips: number },
): PayLine[] {
  const line = (label: string, quantity: number, ratePesewas: number): PayLine => ({ label, quantity, ratePesewas, amountPesewas: quantity * ratePesewas });
  const lines = [line('Days worked', work.days, rules.dailyRatePesewas)];
  for (const k of Object.keys(JOB_LABEL) as (keyof typeof JOB_LABEL)[]) lines.push(line(JOB_LABEL[k], work.jobs[k] ?? 0, rules.perJobPesewas[k]));
  lines.push(line('Intercity linehaul trips', work.linehaulTrips, rules.perLinehaulTripPesewas));
  return lines.filter((l) => l.quantity > 0);
}

const gross = (s: Pick<DriverPayStatement, 'lines' | 'adjustments'>) => s.lines.reduce((n, l) => n + l.amountPesewas, 0) + s.adjustments.reduce((n, a) => n + a.amountPesewas, 0);

/**
 * Build (or rebuild) draft statements for a month from shifts, completed jobs and linehaul trips.
 * Approved or paid statements are never changed; adjustments on drafts are kept.
 */
export async function generateDriverPay(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const { period } = parse(generatePaySchema, raw);
  const rules = await deps.fleet.getPayRules();
  if (!rules) throw new AppError('VALIDATION_FAILED', 'Set the driver pay rates first.');
  const [start, end] = periodRange(period);
  if (start > deps.now()) throw new AppError('VALIDATION_FAILED', 'That month has not started.', 'invalid-argument');
  const [drivers, shifts, jobs, trips] = await Promise.all([
    deps.fleet.listDrivers(),
    deps.fleet.listShifts(start, end),
    deps.fleet.listCompletedJobs(start, end),
    deps.fleet.listLinehaulTrips(start, end),
  ]);
  const out = { saved: 0, skipped: 0, final: 0 };
  for (const d of drivers) {
    const mine = shifts.filter((s) => s.driverUid === d.uid);
    const days = new Set(mine.map((s) => s.startedAt.slice(0, 10))).size;
    const km = mine.reduce((n, s: ShiftRecord) => n + (s.endOdometerKm !== null && s.startOdometerKm !== null ? Math.max(0, s.endOdometerKm - s.startOdometerKm) : 0), 0);
    const jobCounts: Partial<Record<keyof typeof JOB_LABEL, number>> = {};
    for (const j of jobs) if (j.driverUid === d.uid && j.legType !== 'linehaul') jobCounts[j.legType] = (jobCounts[j.legType] ?? 0) + 1;
    const linehaulTrips = trips.filter((t) => t.driverUid === d.uid).length;
    const id = `${period}_${d.uid}`;
    const existing = await deps.fleet.getStatement(id);
    const lines = payLines(rules, { days, jobs: jobCounts, linehaulTrips });
    if (!lines.length && !existing) {
      out.skipped++;
      continue;
    }
    const cash = await deps.fleet.getCash(d.uid);
    const adjustments = existing?.adjustments ?? [];
    const stmt: DriverPayStatement = {
      id,
      period,
      driverUid: d.uid,
      driverName: d.name,
      lines,
      adjustments,
      grossPesewas: gross({ lines, adjustments }),
      cashOutstandingPesewas: cash.collectedPesewas - cash.remittedPesewas,
      daysWorked: days,
      kmDriven: km,
      status: 'draft',
      generatedAt: deps.now().toISOString(),
      approvedBy: null,
      paidAt: null,
      payout: null,
      expenseId: null,
    };
    const r = await deps.fleet.saveDraftStatement(stmt);
    out[r === 'saved' ? 'saved' : 'final']++;
  }
  return out;
}

export async function adjustDriverPay(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const input = parse(payAdjustmentSchema, raw);
  const r = await deps.fleet.updateStatement(
    input.statementId,
    (s) => {
      if (s.status !== 'draft') return { error: 'Only draft statements can be adjusted.', code: 'ALREADY_FINAL' };
      const adjustments = [...s.adjustments, { label: input.label, amountPesewas: input.amountPesewas, by: caller.uid, at: deps.now().toISOString() }];
      const g = gross({ lines: s.lines, adjustments });
      if (g < 0) return { error: 'Deductions cannot exceed the pay for the month.' };
      return { patch: { adjustments, grossPesewas: g } };
    },
    audit(caller, 'driverPay.adjust', 'driverPayment', input.statementId, { after: { label: input.label, amountPesewas: input.amountPesewas } }),
  );
  if (!r) throw new AppError('NOT_FOUND', 'Statement not found.', 'not-found');
  if (isRefusal(r)) refuse(r);
  return { id: r.id, grossPesewas: r.grossPesewas };
}

export async function approveDriverPay(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const { statementId } = parse(approvePaySchema, raw);
  const r = await deps.fleet.updateStatement(
    statementId,
    (s) => {
      if (s.status !== 'draft') return { error: `This statement is already ${s.status}.`, code: 'ALREADY_FINAL' };
      if (periodRange(s.period)[1] > deps.now()) return { error: 'Statements can be approved once the month has ended.' };
      return { patch: { status: 'approved', approvedBy: caller.uid } };
    },
    audit(caller, 'driverPay.approve', 'driverPayment', statementId),
  );
  if (!r) throw new AppError('NOT_FOUND', 'Statement not found.', 'not-found');
  if (isRefusal(r)) refuse(r);
  return { id: r.id, status: r.status };
}

/** Record the payout; creates the matching (approved) driver-payment expense in the same write. */
export async function markDriverPaid(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const input = parse(markPaidSchema, raw);
  const now = deps.now().toISOString();
  const r = await deps.fleet.updateStatement(
    input.statementId,
    (s) => {
      if (s.status !== 'approved') return { error: s.status === 'paid' ? 'This statement is already paid.' : 'Approve the statement first.', code: 'ALREADY_FINAL' };
      const expense: ExpenseDoc | undefined =
        s.grossPesewas > 0
          ? {
              id: `exp_${deps.newId()}`,
              category: 'driver_payment',
              description: `Driver pay ${s.period} — ${s.driverName}`,
              amountPesewas: s.grossPesewas,
              vehicleId: null,
              hubId: null,
              driverUid: s.driverUid,
              receiptKey: null,
              incurredAt: now,
              status: 'approved',
              submittedBy: caller.uid,
              reviewedBy: caller.uid,
              reviewNote: `Paid by ${input.method.replace('_', ' ')} (${input.reference})`,
              sourceId: s.id,
            }
          : undefined;
      return { patch: { status: 'paid', paidAt: now, payout: { method: input.method, reference: input.reference, by: caller.uid }, expenseId: expense?.id ?? null }, ...(expense ? { expense } : {}) };
    },
    audit(caller, 'driverPay.paid', 'driverPayment', input.statementId, { after: { method: input.method, reference: input.reference } }),
  );
  if (!r) throw new AppError('NOT_FOUND', 'Statement not found.', 'not-found');
  if (isRefusal(r)) refuse(r);
  return { id: r.id, status: r.status };
}

// ---- Cash handed in by drivers -------------------------------------------------------------------

export async function recordCashRemittance(deps: FleetDeps, caller: Caller, raw: unknown) {
  requireRole(caller, FINANCE_ROLES);
  const input = parse(cashRemittanceSchema, raw);
  if (!(await deps.fleet.getDriver(input.driverUid))) throw new AppError('NOT_FOUND', 'Driver not found.', 'not-found');
  const id = `rem_${deps.newId()}`;
  const r = await deps.fleet.recordRemittance(
    { id, driverUid: input.driverUid, amountPesewas: input.amountPesewas, method: input.method, reference: input.reference, receivedBy: caller.uid, receivedAt: deps.now().toISOString() },
    audit(caller, 'cash.remittance', 'driver', input.driverUid, { after: { id, amountPesewas: input.amountPesewas } }),
  );
  if (isRefusal(r)) refuse(r);
  return { id };
}

export const describeCashRefusal = (outstanding: number) => `This driver only holds ${formatGhs(outstanding)} in cash.`;
