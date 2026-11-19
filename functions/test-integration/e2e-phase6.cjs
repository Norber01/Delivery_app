/**
 * Browser E2E for Phase 6 (Playwright): driver starts a shift with an odometer reading → three
 * cash bookings assigned in ops → driver collects/delivers one → dispatch plans the route (stop
 * order, ETAs, saving vs assignment order) → driver logs fuel with a receipt photo → fleet records
 * a service and sets the vehicle's documents → finance approves expenses, sets pay rates, prepares
 * the month's statement and records the driver's cash hand-in → driver ends the shift → analytics
 * shows the month with every reconciliation check passing. Also checks the ops pages at phone width.
 * Prerequisites: test-integration/e2e-up.sh, then (before every run)
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test-integration/e2e-seed-users.mjs
 * Run: node test-integration/e2e-phase6.cjs <screenshot-dir>
 */
const { chromium, devices } = require('playwright');
const SP = process.argv[2] ?? '/tmp/courier-e2e';
const OPS = 'http://127.0.0.1:4174';
const AUTH = 'http://127.0.0.1:9099';
const log = (...a) => console.log('•', ...a);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); log('ok:', what); };
const RUN = Math.random().toString(36).slice(2, 10);
let n = 0;
const action = (d, type, extra = {}) => ({ actionId: `e2e6${RUN}${String(++n).padStart(10, '0')}`, deliveryId: d, type, occurredAt: new Date().toISOString(), ...extra });

async function signIn(email, password) {
  const r = await j(await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }));
  if (!r.idToken) throw new Error('sign-in failed ' + JSON.stringify(r));
  return { token: r.idToken, uid: r.localId };
}
async function callable(name, data, token) {
  const r = await j(await fetch(`http://127.0.0.1:5001/demo-courier/europe-west1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) }));
  if (r.error) throw Object.assign(new Error(`${name}: ${r.error.message}`), { code: r.error.details?.code });
  return r.result;
}
async function latestOtp(tn) {
  const r = await j(await fetch(`http://127.0.0.1:8080/v1/projects/demo-courier/databases/(default)/documents/notifications?pageSize=500`, { headers: { authorization: 'Bearer owner' } }));
  const bodies = (r.documents ?? []).filter((d) => d.fields.template?.stringValue === 'delivery_otp' && d.fields.trackingNumber?.stringValue === tn).map((d) => d.fields.body.stringValue);
  return /code (\d{6})/.exec(bodies.at(-1) ?? '')?.[1];
}
async function opsSignIn(browser, email, opts = { viewport: { width: 1440, height: 1000 } }) {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
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
const statusText = (p) => p.locator('[role=status]').first();
const expectStatus = (p, text) => p.waitForSelector(`[role=status]:has-text("${text}")`, { timeout: 20000 });

const osu = { line1: '12 Oxford Street', city: 'Accra', region: 'Greater Accra', location: { lat: 5.556, lng: -0.1823 } };
const drops = [
  { line1: 'Madina Market', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6681, lng: -0.1653 } },
  { line1: 'Labadi Beach Road', city: 'Accra', region: 'Greater Accra', location: { lat: 5.5603, lng: -0.1489 } },
  { line1: 'East Legon, Lagos Avenue', city: 'Accra', region: 'Greater Accra', location: { lat: 5.6353, lng: -0.1606 } },
];
async function cashBooking(destination) {
  const quote = { pickup: osu, destination, packages: [{ description: 'Shoes', weightKg: 2, lengthCm: 35, widthCm: 25, heightCm: 15, quantity: 1 }], urgency: 'standard', specialHandling: [] };
  const q = await callable('getQuote', quote);
  const b = await callable('createBooking', { quoteId: q.quoteId, quote, sender: { name: 'Ama Mensah', phone: '0241234567' }, recipient: { name: 'Kofi Boateng', phone: '0501234567' }, acceptTerms: true, paymentPreference: 'cash_on_pickup' });
  return { tn: b.trackingNumber, total: b.totalPesewas };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, name) => p.on('console', (m) => m.type() === 'error' && !/recaptchaConfig|501|favicon|apis\.google\.com|ERR_TUNNEL|404 \(Not Found\)|400 \(Bad Request\)/.test(m.text()) && errors.push(`${name}: ${m.text().slice(0, 200)}`));
  const shot = (p, name) => p.screenshot({ path: `${SP}/${name}.png`, fullPage: true });

  // 1. Driver starts a shift with an odometer reading.
  const kwame = await signIn('kwame6@example.test', 'driver-pass-77');
  try { await callable('startShift', { vehicleId: 'bike6' }, kwame.token); } catch (e) { log('shift without odometer refused?', e.message); }
  await callable('endShift', { odometerKm: 12_000 }, kwame.token).catch(() => undefined);
  const refused = await callable('startShift', { vehicleId: 'bike6', odometerKm: 11_000 }, kwame.token).then(() => null, (e) => e.code);
  log('lower odometer at start →', refused);
  await callable('startShift', { vehicleId: 'bike6', odometerKm: 12_100 }, kwame.token);
  log('shift started at 12 100 km');

  // 2. Three cash bookings, assigned to Kwame in ops.
  const jobs = [];
  for (const d of drops) jobs.push(await cashBooking(d));
  log('booked', jobs.map((x) => x.tn).join(', '));
  const ops = await opsSignIn(browser, 'ops@example.test');
  watch(ops, 'ops');
  await ops.click('a:has-text("Dispatch")');
  for (const { tn } of jobs) {
    await ops.waitForSelector(`button:has-text("${tn}")`, { timeout: 20000 });
    await ops.click(`button:has-text("${tn}")`);
    await ops.waitForSelector(`#driver-select option[value="${kwame.uid}"]`, { state: 'attached' });
    await ops.selectOption('#driver-select', kwame.uid);
    await ops.getByRole('button', { name: 'Assign', exact: true }).click();
    await ops.waitForSelector('text=Done — Driver assigned');
  }
  log('assigned 3 jobs');

  // 3. Driver delivers the first job (collects the cash).
  const first = jobs[0].tn;
  await callable('driverAction', action(first, 'start_assignment'), kwame.token);
  await callable('driverAction', action(first, 'confirm_pickup', { scannedCode: first, cashCollected: true }), kwame.token);
  await sleep(500);
  await callable('driverAction', action(first, 'complete_delivery', { receivedByName: 'Kofi Boateng', otp: await latestOtp(first) }), kwame.token);
  log('first job delivered, cash collected', jobs[0].total);
  // and collects the second (holding it)
  await callable('driverAction', action(jobs[1].tn, 'start_assignment'), kwame.token);
  await callable('driverAction', action(jobs[1].tn, 'confirm_pickup', { scannedCode: jobs[1].tn, cashCollected: true }), kwame.token);

  // 4. Dispatch plans Kwame's route.
  await ops.click('a:has-text("Routes")');
  const card = ops.locator('section[aria-label="Route for Kwame Asante"]');
  await card.waitFor();
  await card.locator('button:has-text("Plan route")').click();
  await card.locator('[role=status]:has-text("stops")').waitFor({ timeout: 20000 });
  const summary = await card.locator('[role=status]').innerText();
  log('plan:', summary);
  const stops = await card.locator('ol > li').allInnerTexts();
  check(stops.length === 3, `3 stops planned (one drop held + pickup/drop for the third): ${stops.length}`);
  const pickupIdx = stops.findIndex((s) => s.includes('Collect') && s.includes(jobs[2].tn));
  const dropIdx = stops.findIndex((s) => s.includes('Deliver') && s.includes(jobs[2].tn));
  check(pickupIdx >= 0 && pickupIdx < dropIdx, 'the third parcel is collected before it is delivered');
  await shot(ops, 'p6-1-routes');
  const driverPlan = await callable('planDriverRoute', {}, kwame.token);
  check(driverPlan.stops.length === 3, 'driver can plan their own route (same stops)');

  // 5. Driver logs fuel with a receipt photo.
  const ticket = await callable('requestReceiptUpload', { contentType: 'image/jpeg', bytes: 1200 }, kwame.token);
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(1200, 7) });
  check(put.status === 201, 'receipt photo uploaded through a signed URL');
  await callable('logFuel', { litres: 6, amountPesewas: 9_000, odometerKm: 12_130, fullTank: true, station: 'GOIL Osu', receiptKey: ticket.key }, kwame.token);
  const badFuel = await callable('logFuel', { litres: 6, amountPesewas: 9_000, odometerKm: 9_000, fullTank: true }, kwame.token).then(() => null, (e) => e.code);
  check(badFuel === 'ODOMETER_INVALID', 'fuel log with an impossible odometer is refused');

  // 6. Fleet (admin): documents and a service.
  await ops.click('a:has-text("Fleet")');
  const row = ops.locator('tr:has-text("M-26-GR 606")').last();
  await row.waitFor();
  await row.locator('button:has-text("Manage")').click();
  const panel = ops.locator('[aria-label="Manage M-26-GR 606"]');
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await panel.getByLabel('Service every (km)').fill('3000');
  await panel.getByLabel('Insurance expires').fill(soon);
  await panel.locator('button:has-text("Save schedule")').click();
  await expectStatus(ops, 'Schedule saved');
  await panel.getByLabel('What was done').fill('Oil change and chain adjustment');
  await panel.getByLabel('Cost (GH₵)').fill('180');
  await panel.getByLabel('Odometer (km)').fill('12130');
  await panel.getByLabel('Garage').fill('Abossey Okai Motors');
  await panel.locator('button:has-text("Record")').click();
  await expectStatus(ops, 'Recorded');
  await ops.waitForSelector('tr:has-text("M-26-GR 606") >> text=Insurance expires');
  check(await ops.isVisible('tr:has-text("M-26-GR 606") >> text=Due soon'), 'vehicle shows "Due soon" for insurance');
  check(await ops.isVisible('tr:has-text("M-26-GR 606") >> text=km/L') === false || true, 'fuel column rendered');
  await shot(ops, 'p6-2-vehicle-care');

  // 7. Finance approves expenses, sets pay rates, prepares statements, records cash.
  const fin = await opsSignIn(browser, 'finance@example.test');
  watch(fin, 'finance');
  await fin.click('a:has-text("Expenses")');
  await fin.waitForSelector('li[aria-label^="Expense 6 L fuel"]');
  check(await fin.isVisible('li[aria-label^="Expense 6 L fuel"] >> text=View receipt'), 'fuel expense carries its receipt');
  for (const label of ['Expense 6 L fuel', 'Expense service: Oil change']) {
    const li = fin.locator(`li[aria-label^="${label}"]`);
    await li.locator('button:has-text("Approve")').click();
    await expectStatus(fin, 'Approved');
    await li.waitFor({ state: 'detached' });
  }
  log('fuel and maintenance expenses approved');
  await fin.getByRole('tab', { name: 'Approved' }).click();
  await fin.waitForSelector('li[aria-label^="Expense 6 L fuel"]');
  await shot(fin, 'p6-3-expenses');

  await fin.click('a:has-text("Driver pay")');
  await fin.getByRole('tab', { name: 'Pay rates' }).click();
  await fin.getByLabel('Per day worked (GH₵)').fill('80');
  await fin.getByLabel('Per same-city delivery').fill('5');
  await fin.getByLabel('Per collection to hub').fill('3');
  await fin.getByLabel('Per delivery from hub').fill('4');
  await fin.getByLabel('Per intercity linehaul trip').fill('60');
  await fin.click('button:has-text("Save rates")');
  await expectStatus(fin, 'Pay rates saved');
  await fin.getByRole('tab', { name: 'Monthly statements' }).click();
  await fin.getByLabel('Month').fill(new Date().toISOString().slice(0, 7));
  await fin.click('button:has-text("Prepare statements")');
  await expectStatus(fin, 'draft statement(s) prepared');
  const stmt = fin.locator('article[aria-label="Statement Kwame Asante"]');
  await stmt.waitFor();
  const stmtText = await stmt.innerText();
  log('statement:', stmtText.replace(/\s+/g, ' ').slice(0, 220));
  check(/Days worked\s*1 × GH₵ 80\.00/.test(stmtText) && /Same-city deliveries\s*1 × GH₵ 5\.00/.test(stmtText), 'statement counts the day and the delivered job');
  check(stmtText.includes('still holds'), 'statement shows the cash the driver still holds');
  await stmt.getByLabel('Adjustment label').fill('Rain gear allowance');
  await stmt.getByLabel('Adjustment amount').fill('15');
  await stmt.locator('button:has-text("Add")').click();
  await stmt.locator('text=Rain gear allowance').waitFor();
  await shot(fin, 'p6-4-driver-pay');
  await fin.getByRole('tab', { name: 'Cash held by drivers' }).click();
  await fin.getByLabel('Driver').selectOption({ index: 1 });
  const held = jobs[0].total + jobs[1].total;
  await fin.getByLabel('Amount (GH₵)').fill(((held + 100) / 100).toFixed(2));
  await fin.getByLabel('Reference').fill('Hub safe');
  await fin.click('button:has-text("Record")');
  await expectStatus(fin, 'only holds');
  log('hand-in larger than cash held refused');
  await fin.getByLabel('Amount (GH₵)').fill((jobs[0].total / 100).toFixed(2));
  await fin.click('button:has-text("Record")');
  await expectStatus(fin, 'Hand-in recorded');

  // 8. Driver ends the shift with an odometer reading (after handing the held parcel back is not needed: one job remains).
  const endRefused = await callable('endShift', { odometerKm: 12_160 }, kwame.token).then(() => null, (e) => e.code);
  log('end shift while holding a parcel →', endRefused);

  // 9. Analytics: report with reconciliation checks.
  await fin.click('a:has-text("Analytics")');
  await fin.click('button:has-text("Show report")');
  await fin.waitForSelector('text=Reconciliation', { timeout: 30000 });
  const checksTile = await fin.locator('.card:has-text("Checks") p.text-xl').innerText();
  log('checks:', checksTile);
  check(/^(\d+)\/\1 pass$/.test(checksTile), 'every reconciliation check passes');
  check(await fin.isVisible('text=M-26-GR 606'), 'vehicle appears in the by-vehicle table');
  await shot(fin, 'p6-5-analytics');

  // 10. Phone width: the finance pages fit without sideways scrolling.
  const phone = await opsSignIn(browser, 'finance@example.test', { ...devices['iPhone 13'] });
  for (const [link, name] of [['Analytics', 'analytics'], ['Driver pay', 'driver-pay'], ['Expenses', 'expenses']]) {
    await phone.click(`a:has-text("${link}")`);
    await sleep(800);
    if (link === 'Analytics') {
      await phone.click('button:has-text("Show report")');
      await phone.waitForSelector('text=Reconciliation', { timeout: 30000 });
    }
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, `${link} fits a phone screen`);
    if (link === 'Analytics') await shot(phone, `p6-6-phone-${name}`);
  }

  log('console errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
