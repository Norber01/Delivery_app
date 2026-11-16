/**
 * Driver app build helpers for .github/workflows/driver-app.yml.
 *
 *   node deploy/driver-app.mjs prepare   Firebase config, app version, package name (+ App Check token)
 *   node deploy/driver-app.mjs signing   decrypt the signing key, or create it on the first build
 *
 * DISTRIBUTION=phones: an APK installed directly on drivers' phones. Play Integrity cannot vouch
 *   for such installs, so the build carries its own App Check debug token, registered here and
 *   revocable in the Firebase console (App Check → Apps → Manage debug tokens).
 * DISTRIBUTION=google-play: an app bundle (.aab) for Google Play (internal testing is enough);
 *   App Check uses Play Integrity.
 * Without GCP_SA_KEY the build is a TEST build with placeholder settings (it proves the app
 * compiles; it cannot connect to anything).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, gcp, run, stop, StopError, summary, waitOp } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'apps/driver-app');
const FB = 'https://firebase.googleapis.com/v1beta1';
const TMP = env.RUNNER_TEMP || '/tmp';
const KEY_ENC = join(APP, 'signing/upload-key.jks.enc');
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
 * The signing key never leaves GitHub unencrypted: it is generated on the first build, encrypted
 * with DRIVER_SIGNING_PASSWORD (AES-256, PBKDF2) and committed; later builds decrypt it. Every
 * update must be signed with the same key, so keep the password in a password manager.
 */
async function signing() {
  const pw = env.DRIVER_SIGNING_PASSWORD || '';
  if (!pw) {
    out('signed', 'false');
    summary('⚠️ **DRIVER_SIGNING_PASSWORD** is not set, so the app is signed with a throw-away test key. Add the secret before giving the app to drivers (phones cannot update between differently signed builds).');
    return;
  }
  if (pw.length < 20) stop('DRIVER_SIGNING_PASSWORD is too short', ['Use at least 20 characters (a passphrase of 4–5 random words is fine) and keep it in a password manager.']);
  const ks = join(TMP, 'upload.jks');
  if (existsSync(KEY_ENC)) {
    const r = run('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', KEY_ENC, '-out', ks, '-pass', 'env:DRIVER_SIGNING_PASSWORD'], { allowFail: true, quiet: true });
    if (!r.ok) stop('Wrong DRIVER_SIGNING_PASSWORD', ['The signing key in the repository was created with a different password. Enter the original password; if it is lost, delete `apps/driver-app/signing/upload-key.jks.enc` and drivers must uninstall the old app once.']);
  } else {
    run('keytool', ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-alias', 'upload', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-storepass:env', 'DRIVER_SIGNING_PASSWORD', '-keypass:env', 'DRIVER_SIGNING_PASSWORD', '-dname', `CN=${(env.COMPANY_NAME || 'Courier').replace(/[,=+<>#;"\\]/g, ' ')} driver app`], { quiet: true });
    mkdirSync(join(APP, 'signing'), { recursive: true });
    run('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', ks, '-out', KEY_ENC, '-pass', 'env:DRIVER_SIGNING_PASSWORD'], { quiet: true });
    run('git', ['config', 'user.name', 'github-actions[bot]']);
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    run('git', ['add', KEY_ENC]);
    run('git', ['commit', '-m', 'Add the encrypted driver app signing key (created by the build workflow)']);
    const push = run('git', ['push', 'origin', `HEAD:${env.GITHUB_REF_NAME}`], { allowFail: true });
    if (!push.ok) summary('⚠️ Could not save the new signing key to the repository (branch protected?). This build is fine, but the next one would get a different key — allow GitHub Actions to push, or ask for help.');
    else summary('🔑 Created the app signing key and saved it (encrypted) in `apps/driver-app/signing/`.');
  }
  const info = run('keytool', ['-list', '-v', '-keystore', ks, '-storepass:env', 'DRIVER_SIGNING_PASSWORD'], { quiet: true });
  const sha = /SHA256:\s*([0-9A-F:]+)/.exec(info)?.[1] ?? '';
  out('signed', 'true');
  out('keystore', ks);
  summary(`Signing certificate SHA-256: \`${sha}\``);
  let project = null;
  try {
    project = JSON.parse(env.GCP_SA_KEY || '').project_id;
  } catch {
    /* test build */
  }
  if (project && env.ANDROID_APP_ID) await addSha(project, env.ANDROID_APP_ID, sha);
}

const cmd = process.argv[2];
(cmd === 'prepare' ? prepare() : cmd === 'signing' ? signing() : Promise.reject(new Error(`unknown command ${cmd}`))).catch((e) => {
  if (!(e instanceof StopError)) {
    console.error(e);
    summary(`❌ ${String(e.message ?? e).slice(0, 400)}`);
  }
  process.exit(1);
});
