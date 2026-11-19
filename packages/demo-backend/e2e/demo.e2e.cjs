/**
 * Browser test of the built card-free demo (as served by GitHub Pages):
 * book on the website → sign in as the owner from the demo bar → assign in Dispatch → play the
 * driver on "Driver phone" (collect cash, deliver with the texted code) → customer tracking shows
 * Delivered → analytics checks pass → deep links survive a reload → pages fit a phone.
 * Run: serve demo-dist under /<base>/ with a 404.html fallback, then
 *   node packages/demo-backend/e2e/demo.e2e.cjs http://127.0.0.1:4300/Delivery_app/ [screenshot-dir]
 */
const { chromium, devices } = require('playwright');
const BASE = process.argv[2] ?? 'http://127.0.0.1:4300/Delivery_app/';
const SP = process.argv[3] ?? '/tmp';
const log = (...a) => console.log('•', ...a);
const check = (c, what) => { if (!c) throw new Error(`CHECK FAILED: ${what}`); log('ok:', what); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  ctx.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text()) && errors.push(m.text().slice(0, 200)));
  });
  const web = await ctx.newPage();
  await web.goto(BASE);
  await web.waitForSelector('#cdemo');
  check((await web.locator('#cdemo').innerText()).includes('DEMO'), 'demo bar shown');
  await web.screenshot({ path: `${SP}/demo-1-home.png` });

  // 1. Book as a guest (address search runs on the built-in place list; only pay-the-driver offered).
  await web.goto(`${BASE}book`);
  for (const [f, q, l] of [['Pickup', 'oxford', 'Oxford Street, Osu, Accra'], ['Destination', 'madina', 'Madina Market, Madina, Accra']]) {
    await web.locator(`[id="${f}-search"]`).fill(q);
    await web.locator(`button:has-text("${l}")`).click();
  }
  await web.click('button:has-text("Continue")');
  await web.getByLabel('What is it?').fill('Phone accessories');
  for (const [l, v] of [['Weight (kg)', '2'], ['Length (cm)', '30'], ['Width (cm)', '20'], ['Height (cm)', '10'], ['Quantity', '1']]) await web.getByLabel(l).fill(v);
  await web.click('button:has-text("Get price")');
  await web.waitForSelector('text=Continue to book');
  await web.click('button:has-text("Continue to book")');
  check((await web.locator('input[name="payment"]').count()) === 1, 'only "pay the driver" is offered (no online payment in the demo)');
  await web.getByLabel('Full name').nth(0).fill('Ama Mensah');
  await web.getByLabel('Mobile number').nth(0).fill('0241234567');
  await web.getByLabel('Full name').nth(1).fill('Kofi Boateng');
  await web.getByLabel('Mobile number').nth(1).fill('0501234567');
  await web.locator('input[type=checkbox]').last().check();
  await web.click('button:has-text("Confirm booking")');
  await web.waitForSelector('text=Booking confirmed');
  const tn = (await web.locator('.font-mono').first().innerText()).trim();
  log('booked', tn);
  await web.screenshot({ path: `${SP}/demo-2-booked.png` });

  // 2. Sign in as the owner from the demo bar → ops app.
  await web.click('#cdemo button:has-text("Sign in as")');
  await web.click('#cdemo button:has-text("Akosua Owusu")');
  await web.waitForURL(/\/ops\//);
  await web.waitForSelector('header >> text=Sign out');
  const ops = web;
  await ops.click('a:has-text("Dispatch")');
  await ops.waitForSelector(`button:has-text("${tn}")`, { timeout: 20000 });
  await ops.click(`button:has-text("${tn}")`);
  await ops.waitForSelector('#driver-select option[value="d_kwame"]', { state: 'attached' });
  await ops.selectOption('#driver-select', 'd_kwame');
  await ops.getByRole('button', { name: 'Assign', exact: true }).click();
  await ops.waitForSelector('text=Done — Driver assigned');
  await ops.screenshot({ path: `${SP}/demo-3-dispatch.png` });
  log('assigned to Kwame');

  // 3. Play the driver.
  await ops.click('a:has-text("Driver phone")');
  await ops.waitForURL(/driver-demo/);
  await ops.getByLabel('Driver', { exact: true }).selectOption('d_kwame');
  const job = ops.locator(`article[aria-label="Job ${tn}"]`);
  await job.waitFor();
  await job.locator('button:has-text("Start")').click();
  await job.locator('button:has-text("Scan label")').click();
  await job.getByLabel('Delivery code').waitFor();
  const hint = await job.innerText();
  const code = /it is (\d{6})/.exec(hint)?.[1];
  check(!!code, `the texted delivery code is shown to the presenter (${code})`);
  await ops.screenshot({ path: `${SP}/demo-4-driver.png` });
  await job.getByLabel('Delivery code').fill(code);
  await job.locator('button:has-text("Complete delivery")').click();
  await job.waitFor({ state: 'detached' });
  log('delivered');

  // 4. Customer tracking (website, another tab) shows Delivered.
  const track = await ctx.newPage();
  await track.goto(`${BASE}track/${tn}`);
  await track.waitForSelector('text=Delivered', { timeout: 20000 });
  check(true, 'public tracking shows Delivered');
  await track.screenshot({ path: `${SP}/demo-5-tracking.png` });

  // 5. Analytics with the reconciliation checks.
  await ops.click('a:has-text("Analytics")');
  await ops.click('button:has-text("Show report")');
  await ops.waitForSelector('text=Reconciliation', { timeout: 20000 });
  const checks = await ops.locator('.card:has-text("Checks") p.text-xl').innerText();
  check(/^(\d+)\/\1 pass$/.test(checks), `analytics: ${checks}`);
  await ops.screenshot({ path: `${SP}/demo-6-analytics.png`, fullPage: true });

  // 6. Deep link survives a reload (GitHub Pages 404 → app).
  const deep = await ctx.newPage();
  await deep.goto(`${BASE}ops/routes`);
  await deep.waitForSelector('h1:has-text("Routes")', { timeout: 20000 });
  check(deep.url().endsWith('/ops/routes'), 'deep link /ops/routes opens the Routes page');
  await deep.goto(`${BASE}track/${tn}`);
  await deep.waitForSelector('text=Delivered');
  check(true, 'deep link to the tracking page works');

  // 7. Customer account (sign in as Ama from the bar).
  await deep.click('#cdemo button:has-text("Sign in as")');
  await deep.click('#cdemo button:has-text("Ama Mensah")');
  await deep.waitForURL(/\/account/);
  await deep.waitForSelector('a[href*="/track/"]', { timeout: 20000 });
  check((await deep.locator('a[href*="/track/"]').count()) > 0, 'customer sees their bookings');

  // 8. Phone width.
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await phone.newPage();
  await m.goto(BASE);
  await m.waitForSelector('#cdemo');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'website fits a phone with the demo bar');
  await m.screenshot({ path: `${SP}/demo-7-phone.png` });

  log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error('DEMO E2E FAILED', e);
  process.exit(1);
});
