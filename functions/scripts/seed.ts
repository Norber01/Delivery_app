/**
 * Seeds service areas and publishes a pricing rule set.
 *
 *   # emulator
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm --filter @courier/functions seed --project demo-courier
 *   # real project (uses Application Default Credentials; run by an authorised operator)
 *   pnpm --filter @courier/functions seed --project <project-id> --pricing path/to/pricing.json --areas path/to/areas.json
 *
 * Pricing is validated with the same schema as `publishPricingRules` and published as a new,
 * audited version. Service areas are upserted.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { issuesToFieldErrors, pricingRuleSetSchema, serviceAreaSchema } from '@courier/validation';
import { z } from 'zod';
import { FirestoreStore } from '../src/store/firestoreStore.js';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    pricing: { type: 'string', default: new URL('../../firebase/seed/pricing-rules.sample.json', import.meta.url).pathname },
    areas: { type: 'string', default: new URL('../../firebase/seed/service-areas.sample.json', import.meta.url).pathname },
    'skip-pricing': { type: 'boolean', default: false },
  },
});
if (!values.project) throw new Error('--project is required');

const db = getFirestore(initializeApp({ projectId: values.project }));
db.settings({ ignoreUndefinedProperties: true });

const areas = z.array(serviceAreaSchema).parse(JSON.parse(await readFile(values.areas!, 'utf8')));
const batch = db.batch();
for (const a of areas) {
  const { id, ...rest } = a;
  batch.set(db.collection('serviceAreas').doc(id), { ...rest, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
await batch.commit();
console.log(`Upserted ${areas.length} service areas`);

if (!values['skip-pricing']) {
  const raw = JSON.parse(await readFile(values.pricing!, 'utf8'));
  const parsed = pricingRuleSetSchema.safeParse({ ...raw, version: 1 });
  if (!parsed.success) {
    console.error(issuesToFieldErrors(parsed.error));
    process.exit(1);
  }
  const { version: _v, ...rules } = parsed.data;
  const version = await new FirestoreStore(db).publishPricingRules(rules, {
    actorUid: null,
    actorRole: 'system',
    action: 'pricing.publish',
    targetType: 'pricingRules',
    after: { source: values.pricing },
  });
  console.log(`Published pricing rules version ${version}`);
}
