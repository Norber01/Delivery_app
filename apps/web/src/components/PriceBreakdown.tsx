import type { PriceQuote } from '@courier/shared-types';
import { formatGhs } from '@courier/shared-utils';

const TYPE_LABEL: Record<PriceQuote['deliveryType'], string> = {
  intra_city: 'Same-city delivery',
  intercity: 'Intercity delivery (via our hubs)',
  long_distance: 'Long-distance delivery',
};

export function PriceBreakdown({ quote, route }: { quote: PriceQuote; route?: string }) {
  return (
    <div className="card space-y-4">
      <div>
        <p className="text-sm text-slate-500">{route}</p>
        <h3 className="text-lg font-semibold">{TYPE_LABEL[quote.deliveryType]}</h3>
        <p className="text-sm text-slate-600">
          {quote.vehicleClass && <>Vehicle: {quote.vehicleClass} · </>}
          {quote.distanceKm !== null && <>{quote.distanceKm} km · </>}
          Chargeable weight {quote.chargeableWeightKg} kg · {quote.totalQuantity} item{quote.totalQuantity === 1 ? '' : 's'}
          {quote.intercityServiceLevel && <> · {quote.intercityServiceLevel}</>}
        </p>
        {quote.distanceSource === 'estimated' && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Distance is estimated because our routing service was unavailable. This is the price you will pay.
          </p>
        )}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {quote.lines.map((l) => (
            <tr key={l.code} className="border-b border-slate-100 last:border-0">
              <td className="py-2 text-slate-700">{l.label}</td>
              <td className={`py-2 text-right tabular-nums ${l.amountPesewas < 0 ? 'text-brand-700' : ''}`}>{formatGhs(l.amountPesewas)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-3 font-semibold">Total</td>
            <td className="pt-3 text-right text-lg font-bold tabular-nums">{formatGhs(quote.totalPesewas)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="text-xs text-slate-500">Price rules version {quote.pricingVersion}. This price is locked once you confirm your booking.</p>
    </div>
  );
}
