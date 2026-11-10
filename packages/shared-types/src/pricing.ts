import type { DeliveryType, SpecialHandling, Urgency, VehicleClass } from '@courier/constants';

export interface VehicleClassLimits {
  enabled: boolean;
  maxWeightKg: number;
  /** Largest single package dimension the vehicle can carry. */
  maxDimensionCm: number;
}

export interface DistanceRate {
  basePesewas: number;
  perKmPesewas: number;
}

export interface IntraCityRate extends DistanceRate {
  /** Kilometres covered by the base (fixed) price. */
  includedKm: number;
}

export interface WeightBand {
  /** Upper bound (inclusive) of this band in kg; null = open-ended final band. */
  upToKg: number | null;
  perKgPesewas: number;
}

export interface IntercityRoutePrice {
  /** Service area IDs. */
  originAreaId: string;
  destinationAreaId: string;
  /** If true the price also applies in the reverse direction. */
  bidirectional: boolean;
  basePesewas: number;
  firstMilePesewas: number;
  lastMilePesewas: number;
  includedWeightKg: number;
  perExtraKgPesewas: number;
  /** Shown to customers, e.g. "Next-day, departs 18:00". */
  serviceLevel?: string;
}

export interface UrgencyRule {
  percent: number;
  minimumPesewas: number;
}

export interface TaxRule {
  code: string;
  label: string;
  percent: number;
}

export interface PricingRuleSet {
  version: number;
  currency: 'GHS';
  volumetricDivisor: number;
  vehicles: Record<VehicleClass, VehicleClassLimits>;
  intraCity: {
    rates: Partial<Record<VehicleClass, IntraCityRate>>;
  };
  longDistance: {
    enabled: boolean;
    maxDistanceKm: number;
    minimumPesewas: number;
    rates: Partial<Record<VehicleClass, DistanceRate>>;
  };
  intercity: {
    routes: IntercityRoutePrice[];
  };
  weight: {
    includedKg: number;
    bands: WeightBand[];
  };
  urgency: Record<Exclude<Urgency, 'standard'>, UrgencyRule>;
  specialHandling: Record<SpecialHandling, number> & {
    highValuePercent: number;
    highValueMinimumPesewas: number;
  };
  bulkDiscounts: { minPackages: number; percent: number }[];
  maxDiscountPercent: number;
  minimumChargePesewas: number;
  taxes: TaxRule[];
  distance: {
    allowEstimateFallback: boolean;
    estimateRoadFactor: number;
  };
}

export interface ContractTerms {
  contractId: string;
  discountPercent: number;
  /** Override route base prices, keyed by `${originAreaId}->${destinationAreaId}`. */
  routeBaseOverrides?: Record<string, number>;
}

export type DistanceSource = 'route' | 'estimated' | 'fixed_route';

export interface PriceLine {
  code: string;
  label: string;
  amountPesewas: number;
}

export interface PriceQuote {
  pricingVersion: number;
  currency: 'GHS';
  deliveryType: DeliveryType;
  vehicleClass: VehicleClass | null;
  distanceKm: number | null;
  distanceSource: DistanceSource;
  chargeableWeightKg: number;
  totalQuantity: number;
  urgency: Urgency;
  specialHandling: SpecialHandling[];
  intercityServiceLevel?: string;
  lines: PriceLine[];
  subtotalPesewas: number;
  discountPesewas: number;
  taxPesewas: number;
  totalPesewas: number;
}
