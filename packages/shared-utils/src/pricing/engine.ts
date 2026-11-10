import { VEHICLE_CLASSES } from '@courier/constants';
import type { DeliveryType, SpecialHandling, Urgency, VehicleClass } from '@courier/constants';
import type {
  ContractTerms,
  DistanceSource,
  IntercityRoutePrice,
  PackageInfo,
  PriceLine,
  PriceQuote,
  PricingRuleSet,
} from '@courier/shared-types';
import { percentOf } from '../money.js';
import { PricingError } from './errors.js';

export interface PricingInput {
  deliveryType: DeliveryType;
  /** Road distance in km; required for intra_city and long_distance. */
  distanceKm: number | null;
  distanceSource: DistanceSource;
  /** Required for intercity. */
  route?: IntercityRoutePrice | null;
  packages: readonly PackageInfo[];
  urgency: Urgency;
  specialHandling: readonly SpecialHandling[];
  contract?: ContractTerms | null;
}

const VEHICLE_LABEL: Record<VehicleClass, string> = {
  motorbike: 'Motorbike',
  car: 'Car',
  van: 'Van',
  truck: 'Truck',
};

const HANDLING_LABEL: Record<SpecialHandling, string> = {
  fragile: 'Fragile handling',
  perishable: 'Perishable handling',
  high_value: 'High-value handling',
  documents: 'Document handling',
  liquid: 'Liquid handling',
};

const ceil1 = (n: number) => Math.ceil(n * 10 - 1e-9) / 10;

/** max(actual, volumetric) per item × quantity, summed, rounded up to 0.1 kg. */
export function chargeableWeightKg(packages: readonly PackageInfo[], volumetricDivisor: number): number {
  const total = packages.reduce((sum, p) => {
    const volumetric = (p.lengthCm * p.widthCm * p.heightCm) / volumetricDivisor;
    return sum + Math.max(p.weightKg, volumetric) * p.quantity;
  }, 0);
  return ceil1(total);
}

export function largestDimensionCm(packages: readonly PackageInfo[]): number {
  return Math.max(...packages.map((p) => Math.max(p.lengthCm, p.widthCm, p.heightCm)));
}

/** Smallest enabled vehicle class that fits the load and has a rate for this delivery type. */
export function selectVehicleClass(
  rules: PricingRuleSet,
  deliveryType: Exclude<DeliveryType, 'intercity'>,
  weightKg: number,
  maxDimCm: number,
): VehicleClass {
  const rates = deliveryType === 'intra_city' ? rules.intraCity.rates : rules.longDistance.rates;
  for (const c of VEHICLE_CLASSES) {
    const v = rules.vehicles[c];
    if (v.enabled && rates[c] && v.maxWeightKg >= weightKg && v.maxDimensionCm >= maxDimCm) return c;
  }
  throw new PricingError(
    'NO_SUITABLE_VEHICLE',
    'This shipment is too heavy or too large for online booking. Please contact our sales team.',
  );
}

/** Banded weight charge for kg above `includedKg`. Bands use absolute upper bounds. */
export function weightCharge(rules: PricingRuleSet, weightKg: number): number {
  let remainingFrom = rules.weight.includedKg;
  let total = 0;
  for (const band of rules.weight.bands) {
    if (weightKg <= remainingFrom) break;
    const upper = band.upToKg ?? Infinity;
    const kgInBand = Math.min(weightKg, upper) - remainingFrom;
    if (kgInBand > 0) total += Math.round(kgInBand * band.perKgPesewas);
    remainingFrom = upper;
  }
  return total;
}

function pushLine(lines: PriceLine[], code: string, label: string, amountPesewas: number, keepZero = false) {
  if (amountPesewas !== 0 || keepZero) lines.push({ code, label, amountPesewas });
}

/**
 * Authoritative price calculation. Pure and deterministic: the same rules and input
 * always produce the same quote. See docs/04-booking-and-pricing.md §4.2.
 */
export function priceShipment(rules: PricingRuleSet, input: PricingInput): PriceQuote {
  if (input.packages.length === 0) throw new PricingError('VALIDATION_FAILED', 'At least one package is required.');
  const weightKg = chargeableWeightKg(input.packages, rules.volumetricDivisor);
  const totalQuantity = input.packages.reduce((s, p) => s + p.quantity, 0);
  const maxDim = largestDimensionCm(input.packages);
  const lines: PriceLine[] = [];
  let vehicleClass: VehicleClass | null = null;
  let distanceKm: number | null = null;
  let serviceLevel: string | undefined;

  if (input.urgency === 'same_day' && input.deliveryType !== 'intra_city') {
    throw new PricingError('SAME_DAY_NOT_AVAILABLE', 'Same-day delivery is only available within a city.');
  }

  // 1–4. Transport and weight charges.
  if (input.deliveryType === 'intercity') {
    const route = input.route;
    if (!route) throw new PricingError('DESTINATION_NOT_SERVICED', 'No intercity route for this destination.');
    const largestEnabled = VEHICLE_CLASSES.filter((c) => rules.vehicles[c].enabled).at(-1);
    if (!largestEnabled || rules.vehicles[largestEnabled].maxDimensionCm < maxDim) {
      throw new PricingError('NO_SUITABLE_VEHICLE', 'An item is too large for our intercity service.');
    }
    const key = `${route.originAreaId}->${route.destinationAreaId}`;
    const override = input.contract?.routeBaseOverrides?.[key];
    pushLine(lines, 'TRANSPORT', 'Intercity transport', override ?? route.basePesewas, true);
    pushLine(lines, 'FIRST_MILE', 'Collection to origin hub', route.firstMilePesewas);
    pushLine(lines, 'LAST_MILE', 'Delivery from destination hub', route.lastMilePesewas);
    const extraKg = Math.max(0, weightKg - route.includedWeightKg);
    pushLine(lines, 'WEIGHT', `Weight above ${route.includedWeightKg} kg`, Math.round(extraKg * route.perExtraKgPesewas));
    serviceLevel = route.serviceLevel;
  } else {
    if (input.distanceKm === null || !Number.isFinite(input.distanceKm) || input.distanceKm < 0) {
      throw new PricingError('DISTANCE_UNAVAILABLE', 'Distance is required for this delivery type.');
    }
    distanceKm = ceil1(input.distanceKm);
    vehicleClass = selectVehicleClass(rules, input.deliveryType, weightKg, maxDim);
    if (input.deliveryType === 'intra_city') {
      const rate = rules.intraCity.rates[vehicleClass]!;
      pushLine(
        lines,
        'TRANSPORT',
        `${VEHICLE_LABEL[vehicleClass]} delivery (first ${rate.includedKm} km)`,
        rate.basePesewas,
        true,
      );
      const extraKm = Math.max(0, distanceKm - rate.includedKm);
      pushLine(lines, 'DISTANCE', `Additional distance (${ceil1(extraKm)} km)`, Math.round(extraKm * rate.perKmPesewas));
    } else {
      if (distanceKm > rules.longDistance.maxDistanceKm) {
        throw new PricingError('DISTANCE_LIMIT_EXCEEDED', 'This distance exceeds our long-distance service limit.');
      }
      const rate = rules.longDistance.rates[vehicleClass]!;
      const transport = Math.max(
        rules.longDistance.minimumPesewas,
        rate.basePesewas + Math.round(distanceKm * rate.perKmPesewas),
      );
      pushLine(lines, 'TRANSPORT', `${VEHICLE_LABEL[vehicleClass]} long-distance (${distanceKm} km)`, transport, true);
    }
    pushLine(lines, 'WEIGHT', `Weight above ${rules.weight.includedKg} kg`, weightCharge(rules, weightKg));
  }

  const baseCharges = lines.reduce((s, l) => s + l.amountPesewas, 0);

  // 5. Urgency.
  if (input.urgency !== 'standard') {
    const rule = rules.urgency[input.urgency];
    const fee = Math.max(rule.minimumPesewas, percentOf(baseCharges, rule.percent));
    pushLine(lines, `URGENCY_${input.urgency.toUpperCase()}`, input.urgency === 'express' ? 'Express service' : 'Same-day service', fee);
  }

  // 6. Special handling.
  const handling = [...new Set(input.specialHandling)].sort();
  for (const h of handling) {
    pushLine(lines, `HANDLING_${h.toUpperCase()}`, HANDLING_LABEL[h], rules.specialHandling[h]);
    if (h === 'high_value') {
      const declared = input.packages.reduce((s, p) => s + (p.declaredValuePesewas ?? 0) * p.quantity, 0);
      const cover = Math.max(
        rules.specialHandling.highValueMinimumPesewas,
        percentOf(declared, rules.specialHandling.highValuePercent),
      );
      pushLine(lines, 'HIGH_VALUE_COVER', 'High-value cover', cover);
    }
  }

  // 7. Discounts (on transport + weight only), combined percentage capped.
  const bulkPercent = rules.bulkDiscounts
    .filter((t) => t.minPackages <= totalQuantity)
    .reduce((m, t) => Math.max(m, t.percent), 0);
  const cap = rules.maxDiscountPercent;
  const appliedBulk = Math.min(bulkPercent, cap);
  const appliedContract = Math.min(input.contract?.discountPercent ?? 0, cap - appliedBulk);
  pushLine(lines, 'DISCOUNT_BULK', `Bulk discount (${appliedBulk}%)`, -percentOf(baseCharges, appliedBulk));
  pushLine(lines, 'DISCOUNT_CONTRACT', `Business contract discount (${appliedContract}%)`, -percentOf(baseCharges, appliedContract));

  // 8. Minimum charge.
  const afterDiscount = lines.reduce((s, l) => s + l.amountPesewas, 0);
  pushLine(lines, 'MINIMUM_CHARGE', 'Minimum charge adjustment', Math.max(0, rules.minimumChargePesewas - afterDiscount));

  const subtotalPesewas = lines.filter((l) => l.amountPesewas > 0).reduce((s, l) => s + l.amountPesewas, 0);
  const discountPesewas = Math.abs(lines.filter((l) => l.amountPesewas < 0).reduce((s, l) => s + l.amountPesewas, 0));
  const taxable = subtotalPesewas - discountPesewas;

  // 9. Taxes.
  let taxPesewas = 0;
  for (const tax of rules.taxes) {
    const amount = percentOf(taxable, tax.percent);
    taxPesewas += amount;
    pushLine(lines, `TAX_${tax.code}`, `${tax.label} (${tax.percent}%)`, amount);
  }

  const totalPesewas = taxable + taxPesewas;
  // Invariant: total equals the sum of every line.
  const sum = lines.reduce((s, l) => s + l.amountPesewas, 0);
  if (sum !== totalPesewas || !Number.isSafeInteger(totalPesewas) || totalPesewas < 0) {
    throw new Error(`Pricing invariant violated: lines=${sum} total=${totalPesewas}`);
  }

  return {
    pricingVersion: rules.version,
    currency: 'GHS',
    deliveryType: input.deliveryType,
    vehicleClass,
    distanceKm,
    distanceSource: input.deliveryType === 'intercity' ? 'fixed_route' : input.distanceSource,
    chargeableWeightKg: weightKg,
    totalQuantity,
    urgency: input.urgency,
    specialHandling: handling,
    ...(serviceLevel ? { intercityServiceLevel: serviceLevel } : {}),
    lines,
    subtotalPesewas,
    discountPesewas,
    taxPesewas,
    totalPesewas,
  };
}
