/**
 * Browser E2E for Phase 3 (Playwright): booking → label → staff MFA sign-in → fleet setup →
 * driver (simulated with the driver app's exact requests, incl. RTDB REST writes under the real
 * rules) → dispatch assignment → live public tracking → OTP delivery → POD in ops.
 * Prerequisites: Firestore :8080 and RTDB :9000 emulators with firebase/*.rules loaded, Auth
 * emulator :9099 with a staff user enrolled in SMS MFA, e2e-shim.ts running, web on :4173 and
 * admin-tools on :4174 (vite preview, VITE_USE_EMULATORS=true). See docs/11-deployment.md.
 * Run: node test-integration/e2e-phase3.cjs <screenshot-dir>
 */
const { chromium } = require('playwright');
const SP = process.argv[2];
const WEB = 'http://127.0.0.1:4173';
const OPS = 'http://127.0.0.1:4174';
const AUTH = 'http://127.0.0.1:9099';
const log = (...a) => console.log('•', ...a);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// ---- "Driver app" requests (same shapes as apps/driver-app) ----
async function signIn(email, password) {
  const r = await j(await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }));
  if (!r.idToken) throw new Error('sign-in failed ' + JSON.stringify(r));
  return { token: r.idToken, uid: r.localId };
}
async function callable(name, data, token) {
  const r = await j(await fetch(`http://127.0.0.1:5001/demo-courier/europe-west1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) }));
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.details?.code });
  return r.result;
}
let n = 0;
const action = (d, type, extra = {}) => ({ actionId: `e2eaction${String(++n).padStart(12, '0')}`, deliveryId: d, type, occurredAt: new Date().toISOString(), ...extra });
async function writeLocation(uid, token, shiftId, lat, lng) {
  const r = await fetch(`http://127.0.0.1:9000/driverLocations/${uid}.json?ns=demo-courier&auth=${token}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat, lng, accuracyM: 9, speedKph: 28, recordedAt: Date.now(), serverAt: { '.sv': 'timestamp' }, shiftId }) });
  return r.status;
}
async function latestOtp(tn) {
  const r = await j(await fetch(`http://127.0.0.1:8080/v1/projects/demo-courier/databases/(default)/documents/notifications?pageSize=300`, { headers: { authorization: 'Bearer owner' } }));
  const bodies = (r.documents ?? []).filter((d) => d.fields.template?.stringValue === 'delivery_otp' && d.fields.trackingNumber?.stringValue === tn).map((d) => d.fields.body.stringValue);
  return /code (\d{6})/.exec(bodies.at(-1) ?? '')?.[1];
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, name) => p.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 200)}`));

  // 1. Customer books a cash delivery
  const web = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(web, 'web');
  await web.goto(`${WEB}/book`);
  for (const [f, q, l] of [['Pickup', 'oxford', 'Oxford Street, Osu, Accra'], ['Destination', 'madina', 'Madina Market, Madina, Accra']]) {
    await web.locator(`#${f}-search`).fill(q);
    await web.locator(`button:has-text("${l}")`).click();
  }
  await web.click('button:has-text("Continue")');
  await web.getByLabel('What is it?').fill('Shoes');
  for (const [l, v] of [['Weight (kg)', '2'], ['Length (cm)', '35'], ['Width (cm)', '25'], ['Height (cm)', '15'], ['Quantity', '1']]) await web.getByLabel(l).fill(v);
  await web.click('button:has-text("Get price")');
  await web.click('button:has-text("Continue to book")');
  await web.getByLabel('Full name').nth(0).fill('Ama Mensah');
  await web.getByLabel('Mobile number').nth(0).fill('0241234567');
  await web.getByLabel('Full name').nth(1).fill('Kofi Boateng');
  await web.getByLabel('Mobile number').nth(1).fill('0501234567');
  await web.locator('input[type=checkbox]').last().check();
  await web.click('button:has-text("Confirm booking")');
  await web.waitForSelector('text=Booking confirmed');
  const tn = (await web.locator('.font-mono').first().innerText()).trim();
  log('booked (cash)', tn);
  await web.click('a:has-text("Print package label")');
  await web.waitForSelector('[aria-label="Shipping label"] svg');
  log('label shows QR + recipient:', await web.locator('[aria-label="Shipping label"]').innerText().then((t) => t.includes('Kofi Boateng')));
  await web.screenshot({ path: `${SP}/p3-1-label.png`, fullPage: true });

  // 2. Staff without a second factor is sent to enrolment
  const ops0 = await browser.newPage();
  await ops0.goto(OPS);
  await ops0.getByLabel('Work email').fill('newops@example.test');
  await ops0.getByLabel('Password').fill('ops-password-2');
  await ops0.click('button:has-text("Continue")');
  await ops0.waitForSelector('text=Set up two-step verification');
  log('staff without MFA must enrol first');

  // 3. Admin signs in with password + SMS second factor
  const ops = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  watch(ops, 'ops');
  await ops.goto(OPS);
  await ops.getByLabel('Work email').fill('ops@example.test');
  await ops.getByLabel('Password').fill('ops-password-1');
  await ops.click('button:has-text("Continue")');
  await ops.waitForSelector('text=Enter the code we sent');
  let smsCode;
  for (let i = 0; i < 20 && !smsCode; i++) {
    const codes = await j(await fetch(`${AUTH}/emulator/v1/projects/demo-courier/verificationCodes`));
    smsCode = codes.verificationCodes?.at(-1)?.code;
    if (!smsCode) await new Promise((r) => setTimeout(r, 300));
  }
  if (!smsCode) {
    await ops.screenshot({ path: `${SP}/p3-debug-mfa.png` });
    throw new Error('no SMS code issued by the auth emulator: ' + (await ops.locator('[role=alert]').allInnerTexts()).join(' '));
  }
  await ops.getByLabel('Verification code').fill(smsCode);
  await ops.click('button:has-text("Verify")');
  await ops.waitForSelector('h1:has-text("Dispatch")');
  log('ops signed in with SMS second factor');

  // 4. Fleet: add a vehicle and a driver (driver receives a set-password link)
  await ops.click('a:has-text("Fleet")');
  await ops.getByLabel('Registration').fill('m-22-gr 1234');
  await ops.getByLabel('Capacity (kg)').fill('20');
  await ops.click('button:has-text("Save vehicle")');
  await ops.waitForSelector('td:has-text("M-22-GR 1234")');
  await ops.getByLabel('Full name').fill('Kwame Owusu');
  await ops.getByLabel('Mobile number').fill('0207654321');
  await ops.getByLabel('Email (sign-in)').fill('kwame@example.test');
  await ops.getByLabel('Employee number').fill('DRV-001');
  await ops.click('button:has-text("Create driver")');
  await ops.waitForSelector('text=one-time link');
  const link = await ops.locator('p:has-text("one-time link") span.font-mono').innerText();
  await ops.screenshot({ path: `${SP}/p3-2-fleet.png`, fullPage: true });
  const oob = new URL(link).searchParams.get('oobCode');
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oobCode: oob, newPassword: 'driver-pass-77' }) });
  log('driver set own password from the link');

  // 5. Driver signs in and starts a shift (RTDB write authorised only after this)
  const drv = await signIn('kwame@example.test', 'driver-pass-77');
  const vehicles = await j(await fetch(`http://127.0.0.1:8080/v1/projects/demo-courier/databases/(default)/documents/vehicles`, { headers: { authorization: 'Bearer owner' } }));
  const vehicleId = vehicles.documents[0].name.split('/').pop();
  log('location write before shift →', await writeLocation(drv.uid, drv.token, 'none', 5.57, -0.18), '(expect 401)');
  const shift = await callable('startShift', { vehicleId }, drv.token);
  log('location write on shift →', await writeLocation(drv.uid, drv.token, shift.id, 5.575, -0.178));

  // 6. Dispatcher assigns from the board
  await ops.click('a:has-text("Dispatch")');
  await ops.waitForSelector(`button:has-text("${tn}")`);
  await ops.click(`button:has-text("${tn}")`);
  await ops.waitForSelector('#driver-select');
  const opt = await ops.locator('#driver-select option').nth(1).innerText();
  log('driver option:', opt);
  await ops.selectOption('#driver-select', { label: opt });
  await ops.click('button:has-text("Assign")');
  await ops.waitForSelector('text=Done — Driver assigned');
  await ops.screenshot({ path: `${SP}/p3-3-dispatch.png`, fullPage: true });
  log('assigned from dispatch board; map markers:', await ops.locator('[data-marker]').count());

  // 7. Driver: start, scan label (wrong code first), collect cash
  await callable('driverAction', action(tn, 'start_assignment'), drv.token);
  try { await callable('driverAction', action(tn, 'confirm_pickup', { scannedCode: 'GH000000000000', cashCollected: true }), drv.token); } catch (e) { log('wrong label rejected:', e.code); }
  const pickup = await callable('driverAction', action(tn, 'confirm_pickup', { scannedCode: tn, cashCollected: true }), drv.token);
  log('after scan:', pickup.status);
  await writeLocation(drv.uid, drv.token, shift.id, 5.62, -0.172);

  // 8. Customer (public tracking, fresh browser): out for delivery, live driver on the map, no personal data
  const pub = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  watch(pub, 'public');
  await pub.goto(`${WEB}/track/${tn}`);
  await pub.waitForSelector('text=Out for delivery');
  await pub.waitForSelector('[data-marker="driver"]');
  const body = await pub.locator('main').innerText();
  log('public live tracking:', (await pub.locator('section.card p.font-semibold').first().innerText()), '| leaks PII?', /Ama|Kofi|024|050|Oxford/.test(body));
  await pub.screenshot({ path: `${SP}/p3-4-live-tracking.png`, fullPage: true });

  // 9. Driver completes with the recipient's code (wrong code first)
  try { await callable('driverAction', action(tn, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp: '000000' }), drv.token); } catch (e) { log('wrong code:', e.message); }
  const otp = await latestOtp(tn);
  const done = await callable('driverAction', action(tn, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp, location: { lat: 5.6681, lng: -0.1653 } }), drv.token);
  log('delivered:', done.status);
  log('end shift:', JSON.stringify(await callable('endShift', {}, drv.token)));

  // 10. Ops sees proof of delivery and the full timeline
  await ops.fill('input[aria-label="Open by tracking number"]', tn);
  await ops.click('button:has-text("Open")');
  await ops.waitForSelector('text=Proof of delivery');
  log('POD:', (await ops.locator('h3:has-text("Proof of delivery") + p').innerText()).replace(/\s+/g, ' '));
  await ops.screenshot({ path: `${SP}/p3-5-pod.png`, fullPage: true });

  await pub.reload();
  await pub.waitForSelector('h2:has-text("Delivered")');
  log('customer sees Delivered; live location gone:', (await pub.locator('[data-marker="driver"]').count()) === 0);

  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await m.goto(`${WEB}/track/${tn}`);
  await m.waitForTimeout(1200);
  log('mobile overflow on tracking:', await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  log('console errors:', errors.filter((e) => !/App Check|recaptcha|mapbox/i.test(e)));
  await browser.close();
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
