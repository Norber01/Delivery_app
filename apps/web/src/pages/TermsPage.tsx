import { config } from '../lib/config';

/**
 * Summary of booking conditions. The binding terms of carriage must be drafted
 * and approved by the company's legal advisers before launch.
 */
export function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-12">
      <h1 className="text-3xl font-bold">Terms of carriage</h1>
      <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Draft summary pending legal review. The full terms of carriage will be published here before {config.companyName} accepts live bookings.
      </p>
      <ul className="list-disc space-y-3 pl-6 text-slate-700">
        <li>The price shown at confirmation is the price you pay, unless the package's actual weight or size differs from what was declared.</li>
        <li>Prohibited items include illegal goods, weapons, explosives, flammable materials and live animals.</li>
        <li>Declare high-value items. Cover for loss or damage is limited to the declared value where high-value handling was purchased.</li>
        <li>Packages must be adequately packed. Fragile, perishable and liquid items must be declared.</li>
        <li>Recipients may be asked for a one-time code or signature as proof of delivery.</li>
        <li>Personal data is processed in line with Ghana's Data Protection Act, 2012 (Act 843).</li>
      </ul>
    </div>
  );
}
