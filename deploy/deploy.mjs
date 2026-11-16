/**
 * One-tap setup and deploy, run by .github/workflows/deploy.yml. Safe to run again at any time:
 * every step checks what already exists and only creates or changes what is missing.
 *
 *   1. Checks the GitHub settings (secrets/variables) and explains anything missing.
 *   2. Google/Firebase: turns on the APIs, creates Firestore and the Realtime Database, sign-in
 *      methods + two-step verification, the web and Android app registrations, the reCAPTCHA key
 *      and App Check, function secrets (random ones are generated), TTL clean-up and backups.
 *   3. Deploys security rules, indexes and Cloud Functions.
 *   4. Cloudflare: evidence bucket (R2), edge Worker, website and ops app (Pages).
 *   5. Writes the addresses and remaining manual steps to the run summary.
 *
 * Env: DEPLOY_ENV (staging|production), DEPLOY_PART (everything|backend|websites), secrets and
 * variables listed in deploy/preflight.mjs.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preflight } from './preflight.mjs';
import { cf, env, errText, gcp, run, step, stop, StopError, summary, waitOp } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const REGION = 'europe-west1'; // packages/constants FIREBASE_REGION; Firestore + RTDB live here too
const PART = env.DEPLOY_PART || 'everything';
const PROD = env.DEPLOY_ENV === 'production';
const doBackend = PART === 'everything' || PART === 'backend';
const doSites = PART === 'everything' || PART === 'websites';

const cfg = preflight();
const P = cfg.projectId;
const FB = 'https://firebase.googleapis.com/v1beta1';
const A = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const pnpmExec = (args, opts) => run('pnpm', ['exec', ...args], { cwd: ROOT, ...opts });
const firebase = (args, opts) => pnpmExec(['firebase', ...args, '--project', P, '--non-interactive'], opts);
const wrangler = (args, opts) => run('pnpm', ['--filter', '@courier/api-edge', 'exec', 'wrangler', ...args], { cwd: ROOT, ...opts });
const host = (url) => new URL(url).host;
const warnings = [];
const warn = (m) => {
  warnings.push(m);
  console.log(`::warning::${m}`);
};

summary(`## ${PROD ? 'Production' : 'Staging'} deploy — project \`${P}\` (${PART})\n`);

async function main() {
  // ---- Google / Firebase ---------------------------------------------------------------------
  const project = await step('Connect to the Firebase project', async () => {
    const r = await gcp('GET', `${FB}/projects/${P}`);
    if (r.status === 403 || r.status === 404)
      stop('Cannot open the Firebase project', [
        `The key in **GCP_SA_KEY** belongs to project \`${P}\`, but it has no access to a Firebase project with that id (${r.status}).`,
        'Check you created the key in the same project as your Firebase project, and gave the service account the **Owner** role (see the setup guide, step 3).',
      ]);
    if (r.status !== 200) throw new Error(errText(r));
    return r.body;
  });

  await step('Turn on the Google services the platform uses', async () => {
    const services = [
      'cloudresourcemanager', 'serviceusage', 'iam', 'firestore', 'firebasedatabase', 'firebaserules', 'identitytoolkit',
      'cloudfunctions', 'cloudbuild', 'artifactregistry', 'run', 'eventarc', 'pubsub', 'cloudscheduler', 'secretmanager',
      'firebaseappcheck', 'recaptchaenterprise', 'firebaseinstallations', 'storage', 'logging',
    ].map((s) => `${s}.googleapis.com`);
    const r = await gcp('POST', `https://serviceusage.googleapis.com/v1/projects/${P}/services:batchEnable`, { serviceIds: services });
    if (r.status !== 200) {
      if (/billing/i.test(JSON.stringify(r.body)))
        stop('The project is not on the Blaze (pay-as-you-go) plan', [
          'Cloud Functions need a billing account. In the Firebase console open the project → ⚙️ → **Usage and billing** → **Modify plan** → **Blaze**, then run this again.',
          'Set a budget alert at the same time (Google Cloud console → Billing → Budgets & alerts).',
        ]);
      throw new Error(errText(r));
    }
    await waitOp('https://serviceusage.googleapis.com/v1', r.body);
  });

  await step('Firestore database', async () => {
    const base = `https://firestore.googleapis.com/v1/projects/${P}/databases`;
    const pitr = PROD ? 'POINT_IN_TIME_RECOVERY_ENABLED' : 'POINT_IN_TIME_RECOVERY_DISABLED';
    let r = await gcp('GET', `${base}/(default)`);
    if (r.status === 404) {
      r = await gcp('POST', `${base}?databaseId=(default)`, { type: 'FIRESTORE_NATIVE', locationId: REGION, pointInTimeRecoveryEnablement: pitr });
      if (r.status !== 200) throw new Error(errText(r));
      await waitOp('https://firestore.googleapis.com/v1', r.body);
    } else if (r.status === 200) {
      if (r.body.type !== 'FIRESTORE_NATIVE') stop('Firestore is in Datastore mode', ['This platform needs Firestore in **Native mode**. Use a new Firebase project.']);
      if (r.body.locationId !== REGION && r.body.locationId !== 'eur3') warn(`Firestore is in ${r.body.locationId}, functions run in ${REGION}: it works, but every request crosses regions (slower, a little more cost).`);
      if (r.body.pointInTimeRecoveryEnablement !== pitr) {
        const u = await gcp('PATCH', `${base}/(default)?updateMask=pointInTimeRecoveryEnablement`, { pointInTimeRecoveryEnablement: pitr });
        if (u.status !== 200) warn(`Could not change point-in-time recovery: ${errText(u)}`);
      }
    } else throw new Error(errText(r));
  });

  const databaseUrl = await step('Realtime Database (live driver positions)', async () => {
    const base = `https://firebasedatabase.googleapis.com/v1beta/projects/${project.projectNumber}/locations`;
    const list = await gcp('GET', `${base}/-/instances`);
    if (list.status !== 200) throw new Error(errText(list));
    const existing = (list.body.instances ?? []).find((i) => i.type === 'DEFAULT_DATABASE');
    if (existing) return existing.databaseUrl;
    const r = await gcp('POST', `${base}/${REGION}/instances?databaseId=${P}-default-rtdb`, { type: 'DEFAULT_DATABASE' });
    if (r.status !== 200) throw new Error(errText(r));
    return r.body.databaseUrl;
  });

  const webApp = await step('Register the web app with Firebase', async () => {
    const list = await gcp('GET', `${FB}/projects/${P}/webApps`);
    if (list.status !== 200) throw new Error(errText(list));
    let app = (list.body.apps ?? []).find((a) => a.state !== 'DELETED');
    if (!app) {
      const r = await gcp('POST', `${FB}/projects/${P}/webApps`, { displayName: 'Courier web' });
      if (r.status !== 200) throw new Error(errText(r));
      app = (await waitOp(FB, r.body)).response;
    }
    const c = await gcp('GET', `${FB}/projects/${P}/webApps/${app.appId}/config`);
    if (c.status !== 200) throw new Error(errText(c));
    return c.body;
  });

  await step(`Register the Android driver app (${cfg.androidPackage})`, async () => {
    const list = await gcp('GET', `${FB}/projects/${P}/androidApps`);
    if (list.status !== 200) throw new Error(errText(list));
    if ((list.body.apps ?? []).some((a) => a.packageName === cfg.androidPackage && a.state !== 'DELETED')) return;
    const r = await gcp('POST', `${FB}/projects/${P}/androidApps`, { displayName: 'Courier driver', packageName: cfg.androidPackage });
    if (r.status !== 200) throw new Error(errText(r));
    await waitOp(FB, r.body);
  });

  // ---- Cloudflare names and addresses (needed before functions and sign-in settings) ----------
  const urls = await step('Cloudflare: work out the website and Worker addresses', async () => {
    const me = await cf('GET', `${A}/workers/subdomain`);
    if (me.status === 403 || me.status === 401 || me.body.errors?.some((e) => e.code === 10000))
      stop('Cloudflare refused the API token', [
        'Check **CLOUDFLARE_API_TOKEN** and **CLOUDFLARE_ACCOUNT_ID** (setup guide, step 5). The token needs: Workers Scripts Edit, Workers R2 Storage Edit, Cloudflare Pages Edit, Account Settings Read.',
      ]);
    let sub = me.body.result?.subdomain;
    if (!sub) {
      const made = await cf('PUT', `${A}/workers/subdomain`, { subdomain: P });
      if (!made.body.success) throw new Error(`Could not create a workers.dev subdomain: ${errText(made)}. Open Workers & Pages once in the Cloudflare dashboard, then retry.`);
      sub = made.body.result.subdomain;
    }
    const pagesHost = async (name) => {
      let r = await cf('GET', `${A}/pages/projects/${name}`);
      if (r.status === 404) {
        r = await cf('POST', `${A}/pages/projects`, { name, production_branch: 'main' });
        if (!r.body.success) throw new Error(`Could not create Pages project ${name}: ${errText(r)}`);
      } else if (!r.body.success) throw new Error(errText(r));
      return r.body.result.subdomain;
    };
    const worker = `${P}-edge`;
    const webHost = await pagesHost(`${P}-web`);
    const opsHost = await pagesHost(`${P}-ops`);
    return {
      worker,
      webProject: `${P}-web`,
      opsProject: `${P}-ops`,
      web: cfg.webUrl || `https://${webHost}`,
      ops: cfg.opsUrl || `https://${opsHost}`,
      edge: cfg.edgeUrl || `https://${worker}.${sub}.workers.dev`,
    };
  });

  await step('Sign-in methods: email/password, phone, two-step verification for staff', async () => {
    const base = `https://identitytoolkit.googleapis.com`;
    const init = await gcp('POST', `${base}/v2/projects/${P}/identityPlatform:initializeAuth`, {});
    if (init.status !== 200 && !/already|ALREADY/.test(JSON.stringify(init.body))) console.log('initializeAuth:', errText(init));
    const cur = await gcp('GET', `${base}/admin/v2/projects/${P}/config`);
    if (cur.status !== 200) throw new Error(errText(cur));
    const domains = new Set([...(cur.body.authorizedDomains ?? []), host(urls.web), host(urls.ops)]);
    const patch = {
      signIn: { email: { enabled: true, passwordRequired: true }, phoneNumber: { enabled: true } },
      mfa: { state: 'ENABLED', enabledProviders: ['PHONE_SMS'], providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 5 } }] },
      authorizedDomains: [...domains],
    };
    const r = await gcp('PATCH', `${base}/admin/v2/projects/${P}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired,signIn.phoneNumber.enabled,mfa,authorizedDomains`, patch);
    if (r.status !== 200) {
      if (/BILLING|billing/.test(JSON.stringify(r.body))) stop('Two-step verification needs the Blaze plan', ['Upgrade the project to Blaze, then run this again.']);
      throw new Error(errText(r));
    }
  });

  const siteKey = await step('Bot protection: reCAPTCHA key and App Check for the websites', async () => {
    const base = `https://recaptchaenterprise.googleapis.com/v1/projects/${P}/keys`;
    const domains = [...new Set([host(urls.web), host(urls.ops)])];
    const list = await gcp('GET', base);
    if (list.status !== 200) throw new Error(errText(list));
    let key = (list.body.keys ?? []).find((k) => k.displayName === 'courier-web');
    if (!key) {
      const r = await gcp('POST', base, { displayName: 'courier-web', webSettings: { allowedDomains: domains, integrationType: 'SCORE', allowAmpTraffic: false } });
      if (r.status !== 200) throw new Error(errText(r));
      key = r.body;
    } else if (domains.some((d) => !(key.webSettings?.allowedDomains ?? []).includes(d))) {
      const allowed = [...new Set([...(key.webSettings?.allowedDomains ?? []), ...domains])];
      const r = await gcp('PATCH', `https://recaptchaenterprise.googleapis.com/v1/${key.name}?updateMask=webSettings.allowedDomains`, { webSettings: { ...key.webSettings, allowedDomains: allowed } });
      if (r.status !== 200) throw new Error(errText(r));
    }
    const id = key.name.split('/').pop();
    const ac = await gcp('PATCH', `https://firebaseappcheck.googleapis.com/v1/projects/${project.projectNumber}/apps/${webApp.appId}/recaptchaEnterpriseConfig?updateMask=siteKey`, { siteKey: id, tokenTtl: '3600s' });
    if (ac.status !== 200) throw new Error(`App Check: ${errText(ac)}`);
    return id;
  });

  // ---- Secrets ---------------------------------------------------------------------------------
  const uploadSecret = await step('Function secrets (random ones are generated and kept)', async () => {
    const sm = `https://secretmanager.googleapis.com/v1/projects/${P}/secrets`;
    const get = async (name) => {
      const r = await gcp('GET', `${sm}/${name}/versions/latest:access`);
      return r.status === 200 ? Buffer.from(r.body.payload.data, 'base64').toString('utf8') : null;
    };
    const put = async (name, value) => {
      const meta = await gcp('GET', `${sm}/${name}`);
      if (meta.status === 404) {
        const c = await gcp('POST', `${sm}?secretId=${name}`, { replication: { automatic: {} }, labels: { 'firebase-managed': 'true' } });
        if (c.status !== 200) throw new Error(errText(c));
      }
      const v = await gcp('POST', `${sm}/${name}:addVersion`, { payload: { data: Buffer.from(value).toString('base64') } });
      if (v.status !== 200) throw new Error(errText(v));
    };
    const wanted = {
      MAPBOX_SERVER_TOKEN: env.MAPBOX_SERVER_TOKEN,
      PAYSTACK_SECRET_KEY: env.PAYSTACK_SECRET_KEY || 'unset',
      HUBTEL_SMS_CLIENT_ID: env.HUBTEL_SMS_CLIENT_ID || 'unset',
      HUBTEL_SMS_CLIENT_SECRET: env.HUBTEL_SMS_CLIENT_SECRET || 'unset',
    };
    const changed = [];
    for (const [name, value] of Object.entries(wanted)) {
      if ((await get(name)) !== value) {
        await put(name, value);
        changed.push(name);
      }
    }
    for (const name of ['IP_HASH_SALT', 'UPLOAD_SIGNING_SECRET']) {
      if ((await get(name)) === null) {
        await put(name, randomBytes(32).toString('hex'));
        changed.push(name);
      }
    }
    console.log('Updated:', changed.join(', ') || 'none');
    return get('UPLOAD_SIGNING_SECRET');
  });

  if (doBackend) {
    await step('Function settings', async () => {
      const lines = {
        PUBLIC_SITE_URL: urls.web,
        COMPANY_NAME: cfg.companyName,
        PAYMENT_FALLBACK_EMAIL_DOMAIN: cfg.paymentEmailDomain || host(urls.web),
        SMS_SENDER_ID: cfg.smsSenderId,
        EDGE_WORKER_URL: urls.edge,
      };
      writeFileSync(join(ROOT, 'functions', `.env.${P}`), Object.entries(lines).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');
    });

    await step('Security rules and database indexes', async () => {
      firebase(['deploy', '--only', 'firestore,database']);
    });

    await step('Cloud Functions (takes 5–15 minutes)', async () => {
      const attempt = () => firebase(['deploy', '--only', 'functions', '--force'], { allowFail: true });
      let r = attempt();
      if (!r.ok) {
        // First deploys on a new project often fail while Google finishes setting up permissions.
        console.log('First attempt failed; waiting 90 s for Google to finish setting up permissions, then retrying.');
        await new Promise((res) => setTimeout(res, 90_000));
        r = attempt();
      }
      if (!r.ok) throw new Error(`firebase deploy failed: ${(r.err || r.out).trim().split('\n').slice(-4).join(' ')}`);
    });

    await step('Clean-up of short-lived data and backups', async () => {
      const db = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)`;
      for (const group of ['quotes', 'rateLimits', 'uploads', 'bulkBatches']) {
        const f = await gcp('GET', `${db}/collectionGroups/${group}/fields/expiresAt`);
        if (f.status === 200 && f.body.ttlConfig) continue;
        const r = await gcp('PATCH', `${db}/collectionGroups/${group}/fields/expiresAt?updateMask=ttlConfig`, { ttlConfig: {} });
        if (r.status !== 200) warn(`TTL for ${group}: ${errText(r)}`);
      }
      if (PROD) {
        const list = await gcp('GET', `${db}/backupSchedules`);
        if (list.status === 200 && !(list.body.backupSchedules ?? []).length) {
          const r = await gcp('POST', `${db}/backupSchedules`, { retention: `${30 * 86400}s`, dailyRecurrence: {} });
          if (r.status !== 200) warn(`Daily backups: ${errText(r)}`);
        }
      }
    });

    await step('Remove old secret versions (saves cost)', async () => {
      const sm = `https://secretmanager.googleapis.com/v1/projects/${P}/secrets`;
      for (const name of ['MAPBOX_SERVER_TOKEN', 'PAYSTACK_SECRET_KEY', 'HUBTEL_SMS_CLIENT_ID', 'HUBTEL_SMS_CLIENT_SECRET', 'IP_HASH_SALT', 'UPLOAD_SIGNING_SECRET']) {
        const r = await gcp('GET', `${sm}/${name}/versions?filter=${encodeURIComponent('state:ENABLED')}`);
        const versions = (r.body?.versions ?? []).sort((a, b) => Number(b.name.split('/').pop()) - Number(a.name.split('/').pop()));
        for (const v of versions.slice(1)) await gcp('POST', `https://secretmanager.googleapis.com/v1/${v.name}:destroy`, {});
      }
    });

    await step('Evidence storage (Cloudflare R2) and edge Worker', async () => {
      const bucket = `${P}-evidence`;
      let b = await cf('GET', `${A}/r2/buckets/${bucket}`);
      if (b.status === 404 || b.body.errors?.some((e) => e.code === 10006)) {
        b = await cf('POST', `${A}/r2/buckets`, { name: bucket, locationHint: 'weur' });
        if (!b.body.success) {
          if (b.body.errors?.some((e) => e.code === 10042))
            stop('Cloudflare R2 is not enabled on your account', ['In the Cloudflare dashboard open **R2 Object Storage** and click **Purchase R2 / Enable** (the free tier is enough), then run this again.']);
          throw new Error(`R2 bucket: ${errText(b)}`);
        }
      }
      const life = await cf('PUT', `${A}/r2/buckets/${bucket}/lifecycle`, {
        rules: [{ id: 'delete-after-24-months', enabled: true, conditions: { prefix: '' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 730 * 86400 } } }],
      });
      if (!life.body.success) warn(`Could not set the 24-month deletion rule on ${bucket}: add it in R2 → bucket → Settings → Object lifecycle rules.`);

      const ns = 1000 + (parseInt(createHash('sha256').update(P).digest('hex').slice(0, 8), 16) % 8000);
      const toml = [
        `name = "${urls.worker}"`,
        'main = "src/index.ts"',
        'compatibility_date = "2025-10-01"',
        'workers_dev = true',
        '[vars]',
        `ALLOWED_ORIGINS = "${[...new Set([urls.web, urls.ops])].join(',')}"`,
        '[[ratelimits]]',
        'name = "GEOCODE_LIMITER"',
        `namespace_id = "${ns}"`,
        'simple = { limit = 60, period = 60 }',
        '[[r2_buckets]]',
        'binding = "EVIDENCE"',
        `bucket_name = "${bucket}"`,
      ].join('\n');
      writeFileSync(join(ROOT, 'workers/api-edge/wrangler.deploy.toml'), toml + '\n');
      wrangler(['deploy', '-c', 'wrangler.deploy.toml']);
      const secretsFile = join(ROOT, 'workers/api-edge/.deploy-secrets.json');
      writeFileSync(secretsFile, JSON.stringify({ MAPBOX_TOKEN: env.MAPBOX_SERVER_TOKEN, UPLOAD_SIGNING_SECRET: uploadSecret }));
      try {
        wrangler(['secret', 'bulk', '.deploy-secrets.json', '-c', 'wrangler.deploy.toml']);
      } finally {
        rmSync(secretsFile, { force: true });
      }
      let ok = false;
      for (let i = 0; i < 12 && !ok; i++) {
        ok = await fetch(`${urls.edge}/health`).then((r) => r.ok).catch(() => false);
        if (!ok) await new Promise((r) => setTimeout(r, 5000));
      }
      if (!ok) warn(`The Worker at ${urls.edge} did not answer yet (new workers.dev addresses can take a few minutes).`);
    });
  }

  if (doSites) {
    const vite = {
      VITE_FIREBASE_API_KEY: webApp.apiKey,
      VITE_FIREBASE_AUTH_DOMAIN: webApp.authDomain,
      VITE_FIREBASE_PROJECT_ID: P,
      VITE_FIREBASE_APP_ID: webApp.appId,
      VITE_FIREBASE_DATABASE_URL: databaseUrl,
      VITE_RECAPTCHA_ENTERPRISE_SITE_KEY: siteKey,
      VITE_EDGE_API_URL: urls.edge,
      VITE_COMPANY_NAME: cfg.companyName,
      VITE_SUPPORT_PHONE: cfg.supportPhone,
      VITE_MAPBOX_PUBLIC_TOKEN: env.MAPBOX_PUBLIC_TOKEN || '',
      VITE_USE_EMULATORS: 'false',
    };
    const envFile = Object.entries(vite).map(([k, v]) => `${k}=${JSON.stringify(String(v ?? ''))}`).join('\n') + '\n';
    const edgeOrigin = new URL(urls.edge).origin;

    await step(`Website → ${urls.web}`, async () => {
      writeFileSync(join(ROOT, 'apps/web/.env.production.local'), envFile);
      run('pnpm', ['--filter', '@courier/web', 'build'], { cwd: ROOT });
      const h = join(ROOT, 'apps/web/dist/_headers');
      writeFileSync(h, readFileSync(h, 'utf8').replaceAll('https://api.example.com.gh', edgeOrigin));
      wrangler(['pages', 'deploy', join(ROOT, 'apps/web/dist'), '--project-name', urls.webProject, '--branch', 'main', '--commit-dirty=true']);
    });

    await step(`Operations app → ${urls.ops}`, async () => {
      writeFileSync(join(ROOT, 'apps/admin-tools/.env.production.local'), envFile);
      run('pnpm', ['--filter', '@courier/admin-tools', 'build'], { cwd: ROOT });
      const h = join(ROOT, 'apps/admin-tools/dist/_headers');
      let s = readFileSync(h, 'utf8');
      if (!edgeOrigin.endsWith('.workers.dev')) s = s.replace('connect-src ', `connect-src ${edgeOrigin} `).replace('img-src ', `img-src ${edgeOrigin} `);
      writeFileSync(h, s);
      wrangler(['pages', 'deploy', join(ROOT, 'apps/admin-tools/dist'), '--project-name', urls.opsProject, '--branch', 'main', '--commit-dirty=true']);
    });
  }

  // ---- What the person needs to know -------------------------------------------------------------
  const hook = `https://${REGION}-${P}.cloudfunctions.net/paystackWebhook`;
  summary(`
### Your addresses

| | |
|---|---|
| Website | ${urls.web} |
| Operations app (staff) | ${urls.ops} |
| Edge API | ${urls.edge} |
| Paystack webhook URL | \`${hook}\` |
`);
  const todo = [];
  if (!cfg.paystack) todo.push('Online payments are **off** until you add **PAYSTACK_SECRET_KEY** (customers can still choose “pay the driver”).');
  else todo.push(`In the Paystack dashboard → Settings → API Keys & Webhooks, set the webhook URL to \`${hook}\`.`);
  if (!cfg.sms) todo.push('SMS is **off** until you add **HUBTEL_SMS_CLIENT_ID** and **HUBTEL_SMS_CLIENT_SECRET**. Drivers cannot complete deliveries with a delivery code without SMS.');
  todo.push('First time only: run **Admin tasks → seed-config** (prices and service areas), then sign up on the website with your email and run **Admin tasks → make-super-admin**.');
  todo.push('After you have used the website for a day, turn on App Check enforcement: Firebase console → App Check → APIs → Firestore and Realtime Database → **Enforce** (the functions already enforce it).');
  summary(`### Still to do\n\n${todo.map((t) => `- ${t}`).join('\n')}\n`);
  if (warnings.length) summary(`### Warnings\n\n${warnings.map((w) => `- ⚠️ ${w}`).join('\n')}\n`);
}

main().catch((e) => {
  if (!(e instanceof StopError)) {
    console.error(e);
    summary(`\n**The deploy stopped.** Open the failed step above for details. It is safe to run the workflow again once fixed.`);
  }
  process.exit(1);
});
