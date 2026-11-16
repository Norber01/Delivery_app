// Checks the GitHub settings before anything is changed and explains what is missing.
import { readFileSync } from 'node:fs';
import { env, stop, summary } from './lib.mjs';

const where = (name, kind) =>
  `**${name}** — GitHub → your repository → Settings → Environments → *${env.DEPLOY_ENV}* → ${kind === 'secret' ? 'Environment secrets' : 'Environment variables'} → Add`;

const origin = (name) => {
  const v = (env[name] || '').trim().replace(/\/$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.pathname !== '/') throw new Error();
    return u.origin;
  } catch {
    stop(`${name} is not a web address`, [`Use the form https://www.example.com.gh (no path). Fix it at ${where(name, 'variable')}, or delete it to use the free Cloudflare address.`]);
  }
};

export function preflight() {
  const missing = [];
  let projectId = '';
  if (!env.GCP_SA_KEY) missing.push(`${where('GCP_SA_KEY', 'secret')}: paste the whole service-account key file (setup guide, step 3).`);
  else {
    try {
      const k = JSON.parse(env.GCP_SA_KEY);
      if (k.type !== 'service_account' || !k.project_id || !k.private_key) throw new Error();
      projectId = k.project_id;
    } catch {
      stop('GCP_SA_KEY is not a valid key file', [
        'It must be the complete JSON file downloaded from Google Cloud (it starts with `{` and contains `"type": "service_account"`).',
        `Paste it again at ${where('GCP_SA_KEY', 'secret')}.`,
      ]);
    }
  }
  for (const s of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'MAPBOX_SERVER_TOKEN']) if (!env[s]) missing.push(`${where(s, 'secret')} (setup guide).`);
  for (const v of ['COMPANY_NAME', 'SUPPORT_PHONE']) if (!env[v]) missing.push(`${where(v, 'variable')} — e.g. ${v === 'COMPANY_NAME' ? 'Swift Courier GH' : '+233 30 123 4567'}.`);
  if (env.MAPBOX_SERVER_TOKEN && !env.MAPBOX_SERVER_TOKEN.startsWith('sk.') && !env.MAPBOX_SERVER_TOKEN.startsWith('pk.'))
    missing.push('**MAPBOX_SERVER_TOKEN** does not look like a Mapbox token (they start with `sk.` or `pk.`).');
  if (env.PAYSTACK_SECRET_KEY && !/^sk_(test|live)_/.test(env.PAYSTACK_SECRET_KEY)) missing.push('**PAYSTACK_SECRET_KEY** must start with `sk_test_` or `sk_live_` (the *secret* key, not the public one).');
  if (env.DEPLOY_ENV === 'production' && env.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')) missing.push('Production is using a Paystack **test** key. Use the `sk_live_` key for the production environment.');
  if (missing.length) stop('Some settings are missing', missing);

  const sms = Boolean(env.HUBTEL_SMS_CLIENT_ID && env.HUBTEL_SMS_CLIENT_SECRET);
  const appJson = JSON.parse(readFileSync(new URL('../apps/driver-app/app.json', import.meta.url), 'utf8'));
  const cfg = {
    projectId,
    companyName: env.COMPANY_NAME.trim(),
    supportPhone: env.SUPPORT_PHONE.trim(),
    smsSenderId: (env.SMS_SENDER_ID || env.COMPANY_NAME).replace(/[^A-Za-z0-9]/g, '').slice(0, 11) || 'Courier',
    paymentEmailDomain: (env.PAYMENT_EMAIL_DOMAIN || '').trim(),
    androidPackage: (env.ANDROID_PACKAGE || appJson.expo.android.package).trim(),
    webUrl: origin('WEB_URL'),
    opsUrl: origin('OPS_URL'),
    edgeUrl: origin('EDGE_URL'),
    paystack: Boolean(env.PAYSTACK_SECRET_KEY),
    sms,
  };
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(cfg.androidPackage)) stop('ANDROID_PACKAGE is not valid', ['Use lowercase words separated by dots, e.g. `gh.swiftcourier.driver`.']);
  summary(`Settings check: ✅ project \`${projectId}\` · payments ${cfg.paystack ? 'on' : 'off'} · SMS ${sms ? 'on' : 'off'} · maps on website ${env.MAPBOX_PUBLIC_TOKEN ? 'on' : 'basic'}\n`);
  return cfg;
}

// `node deploy/preflight.mjs`: the workflow's first step (no cloud access needed).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    preflight();
  } catch {
    process.exit(1); // the explanation is already in the run summary
  }
}
