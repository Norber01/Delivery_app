/**
 * Browser test of the built card-free demo (as served by GitHub Pages):
 * book on the website → sign in as the manager → assign a pickup rider (delivery riders refused) →
 * pickup rider collects cash → warehouse scans it in → assign a delivery rider → warehouse gives it
 * to them → they deliver with the texted code → tracking shows Delivered → reports pass → Excel
 * backup opens with the order and both riders → deep links survive a reload → pages fit a phone.
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

  // 2. Sign in as the manager from the demo bar → ops app opens on "Today".
  await web.click('#cdemo button:has-text("Sign in as")');
  await web.click('#cdemo button:has-text("Kofi Asamoah")');
  await web.waitForURL(/\/ops\//);
  await web.waitForSelector('h1:has-text("Today")');
  check((await web.locator('[aria-label="Riders on shift"]').innerText()).includes('Kwame Mensah'), 'manager overview lists riders on shift');
  await web.screenshot({ path: `${SP}/demo-3-overview.png` });
  const ops = web;
  const nav = (label) => ops.locator('aside nav a', { hasText: label }).click();
  const assign = async (rider) => {
    await nav('Orders');
    await ops.waitForSelector(`button:has-text("${tn}")`, { timeout: 20000 });
    await ops.click(`button:has-text("${tn}")`);
    await ops.waitForSelector(`#driver-select option[value="${rider}"]`, { state: 'attached' });
    await ops.selectOption('#driver-select', rider);
    await ops.getByRole('button', { name: 'Assign', exact: true }).click();
    await ops.waitForSelector('text=Done —');
  };
  const scan = async (tab) => {
    await nav('Warehouse');
    await ops.getByRole('tab', { name: tab }).click();
    await ops.locator('form input.font-mono').fill(tn);
    await ops.locator('form button:has-text("Scan")').click();
    await ops.waitForSelector(`[aria-label="Scan results"] li:has-text("${tn}")`);
    const line = await ops.locator('[aria-label="Scan results"] li').first().innerText();
    check(line.startsWith('✓'), `warehouse: ${line}`);
  };
  const rider = async (uid, fn) => {
    await nav('Rider phone');
    await ops.waitForURL(/driver-demo/);
    await ops.getByLabel('Driver', { exact: true }).selectOption(uid);
    const job = ops.locator(`article[aria-label="Job ${tn}"]`);
    await job.waitFor();
    await fn(job);
  };

  // Pickup rider: a delivery rider is refused, then Kwame (pickup) takes it.
  await nav('Orders');
  await ops.waitForSelector(`button:has-text("${tn}")`, { timeout: 20000 });
  await ops.click(`button:has-text("${tn}")`);
  await ops.waitForSelector('#driver-select option[value="d_esi"]', { state: 'attached' });
  check(await ops.locator('#driver-select option[value="d_esi"]').isDisabled(), 'delivery riders cannot be chosen for a pickup');
  check((await ops.locator('label[for="driver-select"]').innerText()).includes('pickup rider'), 'panel asks for a pickup rider');
  await ops.screenshot({ path: `${SP}/demo-4-orders.png` });
  await assign('d_kwame');
  log('pickup rider assigned');
  await rider('d_kwame', async (job) => {
    await job.locator('button:has-text("Start")').click();
    await job.locator('button:has-text("Scan label")').click();
    await job.locator('text=Warehouse staff scan it in').waitFor();
  });
  await ops.screenshot({ path: `${SP}/demo-5-pickup-rider.png` });
  await scan('Receive parcel');
  await nav('Warehouse');
  check((await ops.locator('[aria-label="Needs a delivery rider"]').innerText()).includes(tn), 'warehouse shows it waiting for a delivery rider');
  await ops.screenshot({ path: `${SP}/demo-6-warehouse.png` });

  // Delivery rider.
  await nav('Orders');
  await ops.click(`button:has-text("${tn}")`);
  await ops.waitForSelector('#driver-select option[value="d_kwame"]', { state: 'attached' });
  check(await ops.locator('#driver-select option[value="d_kwame"]').isDisabled(), 'pickup riders cannot be chosen for the delivery');
  await assign('d_esi');
  await scan('Give to rider');
  let code = null;
  await rider('d_esi', async (job) => {
    await job.getByLabel('Delivery code').waitFor();
    code = /it is (\d{6})/.exec(await job.innerText())?.[1];
    check(!!code, `the texted delivery code is shown to the presenter (${code})`);
    await ops.screenshot({ path: `${SP}/demo-7-delivery-rider.png` });
    await job.getByLabel('Delivery code').fill(code);
    await job.locator('button:has-text("Complete delivery")').click();
    await job.waitFor({ state: 'detached' });
  });
  log('delivered');

  // 4. Customer tracking (website, another tab) shows Delivered.
  const track = await ctx.newPage();
  await track.goto(`${BASE}track/${tn}`);
  await track.waitForSelector('text=Delivered', { timeout: 20000 });
  check(true, 'public tracking shows Delivered');
  await track.screenshot({ path: `${SP}/demo-5-tracking.png` });

  // 5. Analytics with the reconciliation checks.
  await ops.locator('aside nav a', { hasText: 'Reports' }).click();
  await ops.click('button:has-text("Show report")');
  await ops.waitForSelector('text=Reconciliation', { timeout: 20000 });
  const checks = await ops.locator('.card:has-text("Checks") p.text-xl').innerText();
  check(/^(\d+)\/\1 pass$/.test(checks), `analytics: ${checks}`);
  await ops.screenshot({ path: `${SP}/demo-8-analytics.png`, fullPage: true });

  // 5b. Excel backup: a real .xlsx with the order, its two riders and the customer.
  await ops.locator('aside nav a', { hasText: 'Excel backup' }).click();
  const [download] = await Promise.all([ops.waitForEvent('download'), ops.click('button:has-text("Download Excel file")')]);
  const xlsx = `${SP}/demo-backup.xlsx`;
  await download.saveAs(xlsx);
  check((await ops.locator('text=Downloaded:').innerText()).includes('orders'), 'backup downloaded');
  const { execFileSync } = require('node:child_process');
  const py = `import openpyxl,sys\nwb=openpyxl.load_workbook(sys.argv[1])\nws=wb['Orders']\nh=[c.value for c in ws[1]]\nrow=[r for r in ws.iter_rows(min_row=2,values_only=True) if r[0]==sys.argv[2]][0]\nd=dict(zip(h,row))\nprint(len(wb.sheetnames), d['Status'], d['Pickup rider'], d['Delivery rider'], d['Sender'])`;
  try {
    const out = execFileSync('python3', ['-c', py, xlsx, tn]).toString().trim();
    check(out === '9 Delivered Kwame Mensah Esi Owusu Ama Mensah', `Excel opens with the right data (${out})`);
  } catch (e) {
    if (/No module named/.test(String(e.stderr ?? ''))) log('openpyxl not installed: skipped opening the Excel file');
    else throw e;
  }

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
