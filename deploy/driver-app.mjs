/**
 * Driver app build helpers for .github/workflows/driver-app.yml.
 *
 *   node deploy/driver-app.mjs prepare   Firebase config, app version, package name (+ App Check token)
 *   node deploy/driver-app.mjs signing   fetch the signing key from Secret Manager (created on the first build)
 *
 * DISTRIBUTION=phones: an APK installed directly on drivers' phones. Play Integrity cannot vouch
 *   for such installs, so the build carries its own App Check debug token, registered here and
 *   revocable in the Firebase console (App Check → Apps → Manage debug tokens).
 * DISTRIBUTION=google-play: an app bundle (.aab) for Google Play (internal testing is enough);
 *   App Check uses Play Integrity.
 * Without GCP_SA_KEY the build is a TEST build with placeholder settings (it proves the app
 * compiles; it cannot connect to anything).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, gcp, run, stop, StopError, summary, waitOp } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'apps/driver-app');
const FB = 'https://firebase.googleapis.com/v1beta1';
const TMP = env.RUNNER_TEMP || '/tmp';
const PLAY = env.DISTRIBUTION === 'google-play';
const out = (k, v) => env.GITHUB_OUTPUT && writeFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`, { flag: 'a' });

async function prepare() {
  const appJsonPath = join(APP, 'app.json');
  const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
  const pkg = (env.ANDROID_PACKAGE || appJson.expo.android.package).trim();
  const versionCode = 100 + Number(env.GITHUB_RUN_NUMBER || 1);
  appJson.expo.android.package = pkg;
  appJson.expo.android.versionCode = versionCode;
  appJson.expo.name = env.COMPANY_NAME ? `${env.COMPANY_NAME.trim()} Driver`.slice(0, 30) : appJson.expo.name;
  writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2));

  const lines = {
    EXPO_PUBLIC_COMPANY_NAME: env.COMPANY_NAME || 'Courier',
    EXPO_PUBLIC_DISPATCH_PHONE: env.DISPATCH_PHONE || env.SUPPORT_PHONE || '',
  };
  let project = null;
  try {
    project = JSON.parse(env.GCP_SA_KEY || '').project_id;
  } catch {
    /* test build */
  }

  if (!project) {
    writeFileSync(
      join(APP, 'google-services.json'),
      JSON.stringify({
        project_info: { project_number: '000000000000', project_id: 'placeholder', storage_bucket: 'placeholder.appspot.com' },
        client: [{ client_info: { mobilesdk_app_id: '1:000000000000:android:0000000000000000', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'placeholder' }] }],
        configuration_version: '1',
      }),
    );
    Object.assign(lines, { EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'placeholder' });
    writeEnv(lines);
    out('kind', 'test');
    summary('⚠️ **Test build** — GCP_SA_KEY is not set for this environment, so the app has placeholder settings. It proves the app builds but cannot connect to anything.');
    return;
  }

  const fb = await gcp('GET', `${FB}/projects/${project}`);
  if (fb.status !== 200) stop('Cannot open the Firebase project', [`Run the **Deploy** workflow for ${env.DEPLOY_ENV} first.`]);
  const num = fb.body.projectNumber;
  const webApps = (await gcp('GET', `${FB}/projects/${project}/webApps`)).body.apps ?? [];
  if (!webApps.length) stop('The project is not set up yet', [`Run the **Deploy** workflow for ${env.DEPLOY_ENV} first.`]);
  const web = (await gcp('GET', `${FB}/projects/${project}/webApps/${webApps[0].appId}/config`)).body;
  let android = ((await gcp('GET', `${FB}/projects/${project}/androidApps`)).body.apps ?? []).find((a) => a.packageName === pkg && a.state !== 'DELETED');
  if (!android) {
    const r = await gcp('POST', `${FB}/projects/${project}/androidApps`, { displayName: 'Courier driver', packageName: pkg });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
    android = (await waitOp(FB, r.body)).response;
  }
  const gs = await gcp('GET', `${FB}/projects/${project}/androidApps/${android.appId}/config`);
  writeFileSync(join(APP, 'google-services.json'), Buffer.from(gs.body.configFileContents, 'base64'));
  const dbs = (await gcp('GET', `https://firebasedatabase.googleapis.com/v1beta/projects/${num}/locations/-/instances`)).body.instances ?? [];
  Object.assign(lines, {
    EXPO_PUBLIC_FIREBASE_API_KEY: web.apiKey,
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: web.authDomain,
    EXPO_PUBLIC_FIREBASE_PROJECT_ID: project,
    EXPO_PUBLIC_FIREBASE_APP_ID: web.appId,
    EXPO_PUBLIC_FIREBASE_DATABASE_URL: dbs.find((d) => d.type === 'DEFAULT_DATABASE')?.databaseUrl ?? '',
  });

  const ac = `https://firebaseappcheck.googleapis.com/v1/projects/${num}/apps/${android.appId}`;
  if (PLAY) {
    const r = await gcp('PATCH', `${ac}/playIntegrityConfig?updateMask=tokenTtl`, { tokenTtl: '3600s' });
    if (r.status !== 200) summary(`⚠️ Could not register Play Integrity for App Check: ${JSON.stringify(r.body).slice(0, 200)}`);
    if (env.PLAY_APP_SIGNING_SHA256) await addSha(project, android.appId, env.PLAY_APP_SIGNING_SHA256);
  } else {
    // Per-build token; keep the two newest so phones on the previous build keep working.
    const token = randomUUID();
    const r = await gcp('POST', `${ac}/debugTokens`, { displayName: `driver-apk-${String(env.GITHUB_RUN_NUMBER || 0).padStart(6, '0')}`, token });
    if (r.status !== 200) throw new Error(`App Check token: ${JSON.stringify(r.body).slice(0, 300)}`);
    lines.EXPO_PUBLIC_APPCHECK_DEBUG_TOKEN = token;
    const list = (await gcp('GET', `${ac}/debugTokens`)).body.debugTokens ?? [];
    const ours = list.filter((t) => t.displayName?.startsWith('driver-apk-')).sort((a, b) => b.displayName.localeCompare(a.displayName));
    for (const t of ours.slice(2)) await gcp('DELETE', `https://firebaseappcheck.googleapis.com/v1/${t.name}`);
  }
  writeEnv(lines);
  out('kind', 'real');
  out('project', project);
  out('android_app', android.appId);
  summary(`App configured for \`${project}\` (package \`${pkg}\`, version code ${versionCode}).`);
}

function writeEnv(lines) {
  writeFileSync(join(APP, '.env'), Object.entries(lines).map(([k, v]) => `${k}=${JSON.stringify(String(v ?? ''))}`).join('\n') + '\n');
}

async function addSha(project, appId, sha) {
  const hex = sha.replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return summary('⚠️ PLAY_APP_SIGNING_SHA256 is not a SHA-256 fingerprint.');
  const list = (await gcp('GET', `${FB}/projects/${project}/androidApps/${appId}/sha`)).body.certificates ?? [];
  if (list.some((c) => c.shaHash?.toLowerCase() === hex)) return;
  await gcp('POST', `${FB}/projects/${project}/androidApps/${appId}/sha`, { shaHash: hex, certType: 'SHA_256' });
}

/**
 * The upload/signing key lives in the project's Google Secret Manager (DRIVER_UPLOAD_KEYSTORE and
 * DRIVER_UPLOAD_KEY_PASSWORD), created on the first real build. It is never stored in the
 * repository or in build logs, and every later build reuses it so updates install over the
 * previous version. Test builds (no GCP_SA_KEY) use Android's throw-away debug key.
 */
async function signing() {
  let project = null;
  try {
    project = JSON.parse(env.GCP_SA_KEY || '').project_id;
  } catch {
    /* test build */
  }
  if (!project) {
    out('signed', 'false');
    return;
  }
  const sm = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`;
  const read = async (name) => {
    const r = await gcp('GET', `${sm}/${name}/versions/latest:access`);
    return r.status === 200 ? Buffer.from(r.body.payload.data, 'base64') : null;
  };
  const save = async (name, data) => {
    const c = await gcp('POST', `${sm}?secretId=${name}`, { replication: { automatic: {} }, labels: { purpose: 'driver-app-signing' } });
    if (c.status !== 200 && c.status !== 409) throw new Error(`Secret Manager: ${JSON.stringify(c.body).slice(0, 200)}`);
    const v = await gcp('POST', `${sm}/${name}:addVersion`, { payload: { data: data.toString('base64') } });
    if (v.status !== 200) throw new Error(`Secret Manager: ${JSON.stringify(v.body).slice(0, 200)}`);
  };
  const ks = join(TMP, 'upload.p12');
  let store = await read('DRIVER_UPLOAD_KEYSTORE');
  let password = (await read('DRIVER_UPLOAD_KEY_PASSWORD'))?.toString('utf8');
  if (!store || !password) {
    password = randomBytes(24).toString('base64url');
    run('keytool', ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-storepass:env', 'KS_PW', '-keypass:env', 'KS_PW', '-dname', `CN=${(env.COMPANY_NAME || 'Courier').replace(/[,=+<>#;"\\]/g, ' ')} driver app`], { quiet: true, env: { KS_PW: password } });
    store = readFileSync(ks);
    await save('DRIVER_UPLOAD_KEY_PASSWORD', Buffer.from(password));
    await save('DRIVER_UPLOAD_KEYSTORE', store);
    summary('🔑 Created the app signing key and stored it in your Google project (Secret Manager → DRIVER_UPLOAD_KEYSTORE). Do not delete it: every update must be signed with it.');
  } else writeFileSync(ks, store);
  console.log(`::add-mask::${password}`);
  if (env.GITHUB_ENV) writeFileSync(env.GITHUB_ENV, `KS_PW=${password}\n`, { flag: 'a' });
  const info = run('keytool', ['-list', '-v', '-keystore', ks, '-storepass:env', 'KS_PW'], { quiet: true, env: { KS_PW: password } });
  const sha = /SHA256:\s*([0-9A-F:]+)/.exec(info)?.[1] ?? '';
  out('signed', 'true');
  out('keystore', ks);
  summary(`Signing certificate SHA-256: \`${sha}\``);
  if (env.ANDROID_APP_ID) await addSha(project, env.ANDROID_APP_ID, sha);
}

const cmd = process.argv[2];
(cmd === 'prepare' ? prepare() : cmd === 'signing' ? signing() : Promise.reject(new Error(`unknown command ${cmd}`))).catch((e) => {
  if (!(e instanceof StopError)) {
    console.error(e);
    summary(`❌ ${String(e.message ?? e).slice(0, 400)}`);
  }
  process.exit(1);
});
