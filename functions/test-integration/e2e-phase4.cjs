/**
 * Browser E2E for Phase 4 (Playwright): intercity booking → first-mile dispatch → Accra hub receive
 * (hub operator scoped to ACC-01, SMS MFA) → manifest create/scan-load/seal/depart (blocked until the
 * linehaul driver is on shift) → public tracking in transit (no vehicle position) → Kumasi hub arrival,
 * unload scan, close → last-mile dispatch in Kumasi → hub hand-over → OTP delivery.
 * Prerequisites as e2e-phase3.cjs, plus `pnpm --filter @courier/functions seed` (network) and staff
 * hub.accra@ / hub.kumasi@ (hub_operator with hubIds), drivers kwame/trucker/kofi and vehicles.
 * Run: node test-integration/e2e-phase4.cjs <screenshot-dir>
 */
const { chromium } = require('playwright');
const SP = process.argv[2];
const WEB = 'http://127.0.0.1:4173';
const OPS = 'http://127.0.0.1:4174';
const AUTH = 'http://127.0.0.1:9099';
const log = (...a) => console.log('•', ...a);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(email, password) {
  const r = await j(await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }));
  return { token: r.idToken, uid: r.localId };
}
async function callable(name, data, token) {
  const r = await j(await fetch(`http://127.0.0.1:5001/demo-courier/europe-west1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) }));
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.details?.code });
  return r.result;
}
let n = 0;
const RUN = Math.random().toString(36).slice(2, 10);
const action = (d, type, extra = {}) => ({ actionId: `e2e4${RUN}${String(++n).padStart(10, '0')}`, deliveryId: d, type, occurredAt: new Date().toISOString(), ...extra });
async function latestOtp(tn) {
  const r = await j(await fetch(`http://127.0.0.1:8080/v1/projects/demo-courier/databases/(default)/documents/notifications?pageSize=300`, { headers: { authorization: 'Bearer owner' } }));
  const bodies = (r.documents ?? []).filter((d) => d.fields.template?.stringValue === 'delivery_otp' && d.fields.trackingNumber?.stringValue === tn).map((d) => d.fields.body.stringValue);
  return /code (\d{6})/.exec(bodies.at(-1) ?? '')?.[1];
}

async function opsSignIn(browser, email) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto(OPS);
  await p.getByLabel('Work email').fill(email);
  await p.getByLabel('Password').fill('ops-password-1');
  await p.click('button:has-text("Continue")');
  await p.waitForSelector('text=Enter the code we sent');
  let code;
  for (let i = 0; i < 20 && !code; i++) {
    const c = await j(await fetch(`${AUTH}/emulator/v1/projects/demo-courier/verificationCodes`));
    code = c.verificationCodes?.filter((v) => v.code).at(-1)?.code;
    if (!code) await sleep(300);
  }
  await p.getByLabel('Verification code').fill(code);
  await p.click('button:has-text("Verify")');
  await p.waitForSelector('header >> text=Sign out');
  return p;
}
async function scan(page, label, code) {
  await page.getByLabel(label).first().fill(code);
  await page.getByLabel(label).first().press('Enter');
  await sleep(700);
}
const lastResult = (page, scope = page) => scope.locator('li.text-brand-700, li.text-red-700').first().innerText();

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, name) => p.on('console', (m) => m.type() === 'error' && !/recaptchaConfig|501/.test(m.text()) && errors.push(`${name}: ${m.text().slice(0, 200)}`));

  // 1. Customer books Accra → Kumasi (cash on pickup)
  const web = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(web, 'web');
  await web.goto(`${WEB}/book`);
  for (const [f, q, l] of [['Pickup', 'oxford', 'Oxford Street, Osu, Accra'], ['Destination', 'adum', 'Adum, Kumasi']]) {
    await web.locator(`#${f}-search`).fill(q);
    await web.locator(`button:has-text("${l}")`).click();
  }
  await web.click('button:has-text("Continue")');
  await web.getByLabel('What is it?').fill('Phone accessories');
  for (const [l, v] of [['Weight (kg)', '3'], ['Length (cm)', '30'], ['Width (cm)', '20'], ['Height (cm)', '10'], ['Quantity', '1']]) await web.getByLabel(l).fill(v);
  await web.click('button:has-text("Get price")');
  await web.waitForSelector('text=Intercity delivery');
  await web.click('button:has-text("Continue to book")');
  await web.getByLabel('Full name').nth(0).fill('Ama Mensah');
  await web.getByLabel('Mobile number').nth(0).fill('0241234567');
  await web.getByLabel('Full name').nth(1).fill('Yaw Boateng');
  await web.getByLabel('Mobile number').nth(1).fill('0201234567');
  await web.locator('input[type=checkbox]').last().check();
  await web.click('button:has-text("Confirm booking")');
  await web.waitForSelector('text=Booking confirmed');
  const tn = (await web.locator('.font-mono').first().innerText()).trim();
  log('intercity booking', tn);

  // Drivers start shifts (app requests)
  const kwame = await signIn('kwame@example.test', 'driver-pass-77');
  const trucker = await signIn('trucker@example.test', 'driver-pass-77');
  const kofi = await signIn('kofi@example.test', 'driver-pass-77');
  await callable('startShift', { vehicleId: 'bike1' }, kwame.token);

  // 2. Dispatch (admin) assigns the first mile
  const ops = await opsSignIn(browser, 'ops@example.test');
  watch(ops, 'ops');
  await ops.click('a:has-text("Dispatch")');
  await ops.waitForSelector(`button:has-text("${tn}")`);
  await ops.click(`button:has-text("${tn}")`);
  log('dispatch shows:', await ops.locator('p.bg-violet-50').first().innerText());
  log('first-mile options:', (await ops.locator('#driver-select option').allInnerTexts()).slice(1).join(' | '));
  await ops.selectOption('#driver-select', { label: (await ops.locator('#driver-select option').allInnerTexts()).find((o) => o.startsWith('Kwame')) });
  await ops.getByRole('button', { name: 'Assign', exact: true }).click();
  await ops.waitForSelector('text=Done — Driver assigned');
  await callable('driverAction', action(tn, 'start_assignment'), kwame.token);
  const picked = await callable('driverAction', action(tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true }), kwame.token);
  log('first mile pickup →', picked.status);

  // 3. Accra hub operator: sees only Accra, receives the parcel
  const hubA = await opsSignIn(browser, 'hub.accra@example.test');
  watch(hubA, 'hubA');
  await hubA.waitForSelector('h1:has-text("Hub")');
  log('Accra operator hub choices:', await hubA.locator('select[aria-label="Hub"] option').allInnerTexts());
  await hubA.waitForSelector(`text=${tn}`); // listed under "Expected from pickup drivers"
  await scan(hubA, 'Scan parcel to receive', tn.toLowerCase());
  log('receive scan:', await lastResult(hubA));
  await scan(hubA, 'Scan parcel to receive', tn);
  log('repeat scan:', await lastResult(hubA));
  try { await callable('endShift', {}, kwame.token); log('first-mile driver shift ended'); } catch (e) { log('end shift failed', e.code); }

  // 4. Manifest: create, load by scan, seal, depart (blocked until the linehaul driver is on shift)
  await hubA.click('button:has-text("+ New manifest")');
  await hubA.getByLabel('Route').selectOption({ label: 'ACC-KSI' });
  await hubA.getByLabel('Departure').fill('2026-11-16T18:00');
  await hubA.getByLabel('Vehicle (van/truck)').selectOption({ index: 1 });
  await hubA.getByLabel('Linehaul driver').selectOption({ label: 'Kojo Asante' });
  await hubA.click('button:has-text("Create manifest")');
  await hubA.waitForSelector('article[aria-label^="Manifest ACC-KSI"]');
  const manifest = hubA.locator('article[aria-label^="Manifest ACC-KSI"]');
  await scan(manifest, 'Scan parcel to load', tn);
  log('load scan:', await lastResult(hubA, manifest));
  await manifest.locator('button:has-text("Seal")').click();
  await manifest.locator('button:has-text("Depart")').waitFor();
  await manifest.locator('button:has-text("Depart")').click();
  await sleep(700);
  log('depart without driver on shift:', await lastResult(hubA, manifest));
  await callable('startShift', { vehicleId: 'truck1' }, trucker.token);
  await manifest.locator('button:has-text("Depart")').click();
  await hubA.waitForSelector('article[aria-label^="Manifest ACC-KSI"]', { state: 'detached' });
  log('manifest departed');
  await hubA.screenshot({ path: `${SP}/p4-1-hub-accra.png`, fullPage: true });

  // 5. Customer tracking during linehaul: hub wording, no vehicle position
  const pub = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(pub, 'public');
  await pub.goto(`${WEB}/track/${tn}`);
  await pub.waitForSelector('h2:has-text("In transit to Kumasi")');
  log('public in transit:', (await pub.locator('section.card p.text-slate-600').first().innerText()).slice(0, 110), '| driver marker:', await pub.locator('[data-marker="driver"]').count());
  await pub.screenshot({ path: `${SP}/p4-2-tracking-in-transit.png`, fullPage: true });

  // 6. Kumasi hub: arrival, unload scan, close
  const hubK = await opsSignIn(browser, 'hub.kumasi@example.test');
  watch(hubK, 'hubK');
  await hubK.waitForSelector('article[aria-label^="Inbound ACC-KSI"]');
  const inbound = hubK.locator('article[aria-label^="Inbound ACC-KSI"]');
  await scan(hubK, 'Scan parcel to receive', tn);
  log('unload before arrival:', await lastResult(hubK));
  await inbound.locator('button:has-text("Vehicle arrived")').click();
  await inbound.locator('button:has-text("Close manifest")').waitFor();
  await scan(hubK, 'Scan parcel to receive', tn);
  log('unload scan:', await lastResult(hubK));
  await inbound.locator('text=Unloaded 1 / 1').waitFor();
  await inbound.locator('button:has-text("Close manifest")').click();
  await hubK.waitForSelector('article[aria-label^="Inbound ACC-KSI"]', { state: 'detached' });
  log('inbound manifest closed');
  log('trucker end shift:', JSON.stringify(await callable('endShift', {}, trucker.token)));

  // 7. Last mile: dispatch assigns a Kumasi driver; Kumasi hub hands over
  await hubK.waitForSelector('text=Needs a driver (dispatch)');
  await scan(hubK, 'Scan parcel to receive', tn);
  log('rescan while on hand:', await lastResult(hubK));
  await callable('startShift', { vehicleId: 'bike9' }, kofi.token);
  await ops.reload();
  await ops.waitForSelector(`button:has-text("${tn}")`);
  await ops.click(`button:has-text("${tn}")`);
  await ops.waitForSelector('#driver-select');
  log('last-mile options:', (await ops.locator('#driver-select option').allInnerTexts()).slice(1).join(' | '));
  await ops.selectOption('#driver-select', { label: (await ops.locator('#driver-select option').allInnerTexts()).find((o) => o.startsWith('Kofi')) });
  await ops.getByRole('button', { name: 'Assign', exact: true }).click();
  await ops.waitForSelector('text=Done');
  await ops.screenshot({ path: `${SP}/p4-3-dispatch-last-mile.png`, fullPage: true });
  await hubK.waitForSelector('text=scan to hand over');
  await hubK.click('button:has-text("Hand to driver")');
  await scan(hubK, 'Scan parcel to hand over', tn);
  log('handover scan:', await lastResult(hubK));
  await hubK.screenshot({ path: `${SP}/p4-4-hub-kumasi.png`, fullPage: true });

  // 8. Delivery with the code; customer sees Delivered
  const otp = await latestOtp(tn);
  log('delivered:', (await callable('driverAction', action(tn, 'complete_delivery', { receivedByName: 'Yaw Boateng', otp }), kofi.token)).status);
  await pub.reload();
  await pub.waitForSelector('h2:has-text("Delivered")');
  log('public timeline:', (await pub.locator('ol li p.font-medium').allInnerTexts()).reverse().join(' → '));
  await pub.screenshot({ path: `${SP}/p4-5-tracking-delivered.png`, fullPage: true });

  log('console errors:', errors);
  await browser.close();
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
