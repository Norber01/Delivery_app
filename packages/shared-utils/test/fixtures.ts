import type { PackageInfo, PricingRuleSet, ServiceArea } from '@courier/shared-types';

export const rules: PricingRuleSet = {
  version: 3,
  currency: 'GHS',
  volumetricDivisor: 5000,
  vehicles: {
    motorbike: { enabled: true, maxWeightKg: 20, maxDimensionCm: 60 },
    car: { enabled: true, maxWeightKg: 100, maxDimensionCm: 120 },
    van: { enabled: true, maxWeightKg: 1000, maxDimensionCm: 250 },
    truck: { enabled: false, maxWeightKg: 5000, maxDimensionCm: 600 },
  },
  intraCity: {
    rates: {
      motorbike: { basePesewas: 2500, includedKm: 5, perKmPesewas: 300 },
      car: { basePesewas: 4500, includedKm: 5, perKmPesewas: 500 },
      van: { basePesewas: 12000, includedKm: 10, perKmPesewas: 800 },
    },
  },
  longDistance: {
    enabled: true,
    maxDistanceKm: 800,
    minimumPesewas: 15000,
    rates: {
      motorbike: { basePesewas: 5000, perKmPesewas: 250 },
      car: { basePesewas: 8000, perKmPesewas: 400 },
      van: { basePesewas: 20000, perKmPesewas: 700 },
    },
  },
  intercity: {
    routes: [
      {
        originAreaId: 'accra',
        destinationAreaId: 'kumasi',
        bidirectional: true,
        basePesewas: 6000,
        firstMilePesewas: 1500,
        lastMilePesewas: 1500,
        includedWeightKg: 5,
        perExtraKgPesewas: 200,
        serviceLevel: 'Next day',
      },
    ],
  },
  weight: {
    includedKg: 5,
    bands: [
      { upToKg: 20, perKgPesewas: 100 },
      { upToKg: null, perKgPesewas: 50 },
    ],
  },
  urgency: {
    express: { percent: 30, minimumPesewas: 1000 },
    same_day: { percent: 50, minimumPesewas: 2000 },
  },
  specialHandling: {
    fragile: 500,
    perishable: 800,
    high_value: 1000,
    documents: 0,
    liquid: 500,
    highValuePercent: 1,
    highValueMinimumPesewas: 500,
  },
  bulkDiscounts: [
    { minPackages: 10, percent: 5 },
    { minPackages: 50, percent: 10 },
  ],
  maxDiscountPercent: 20,
  minimumChargePesewas: 2000,
  taxes: [],
  distance: { allowEstimateFallback: true, estimateRoadFactor: 1.35 },
};

export const areas: ServiceArea[] = [
  {
    id: 'accra',
    name: 'Greater Accra',
    city: 'Accra',
    region: 'Greater Accra',
    center: { lat: 5.6037, lng: -0.187 },
    radiusKm: 35,
    active: true,
  },
  {
    id: 'kumasi',
    name: 'Kumasi Metropolitan',
    city: 'Kumasi',
    region: 'Ashanti',
    center: { lat: 6.6885, lng: -1.6244 },
    radiusKm: 25,
    active: true,
  },
  {
    id: 'tamale',
    name: 'Tamale',
    city: 'Tamale',
    region: 'Northern',
    center: { lat: 9.4075, lng: -0.8533 },
    radiusKm: 20,
    active: false,
  },
];

export const small: PackageInfo = {
  description: 'Shoes',
  weightKg: 2,
  lengthCm: 35,
  widthCm: 25,
  heightCm: 15,
  quantity: 1,
};

export const LOCATIONS = {
  osu: { lat: 5.556, lng: -0.1823 },
  madina: { lat: 5.6681, lng: -0.1653 },
  kumasiCentral: { lat: 6.6966, lng: -1.6233 },
  capeCoast: { lat: 5.1053, lng: -1.2466 },
  tamale: { lat: 9.4034, lng: -0.8424 },
};
