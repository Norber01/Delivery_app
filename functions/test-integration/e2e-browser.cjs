/**
 * Browser E2E for Phases 1–2 (Playwright). Prerequisites (see docs/11-deployment.md §11.2):
 *   - Firestore emulator :8080 with firebase/firestore.rules loaded, Auth emulator :9099
 *   - pricing seeded:  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm --filter @courier/functions seed --project demo-courier
 *   - harness:         FIRESTORE_EMULATOR_HOST=… FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npx tsx test-integration/e2e-shim.ts
 *   - web build served on :4173 with VITE_USE_EMULATORS=true VITE_EDGE_API_URL=http://127.0.0.1:8787 (vite preview)
 * Run: node test-integration/e2e-browser.cjs <screenshot-dir>
 */
const { chromium } = require('playwright');
const SP = process.argv[2];
const BASE = 'http://127.0.0.1:4173';
const log = (...a) => console.log('•', ...a);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // 1. Guest books with Mobile Money
  await page.goto(`${BASE}/book`);
  for (const [f, q, l] of [['Pickup', 'oxford', 'Oxford Street, Osu, Accra'], ['Destination', 'madina', 'Madina Market, Madina, Accra']]) {
    await page.locator(`#${f}-search`).fill(q);
    await page.locator(`button:has-text("${l}")`).click();
  }
  await page.click('button:has-text("Continue")');
  await page.getByLabel('What is it?').fill('Shoes');
  for (const [l, v] of [['Weight (kg)', '2'], ['Length (cm)', '35'], ['Width (cm)', '25'], ['Height (cm)', '15'], ['Quantity', '1']]) await page.getByLabel(l).fill(v);
  await page.click('button:has-text("Get price")');
  await page.click('button:has-text("Continue to book")');
  await page.getByLabel('Full name').nth(0).fill('Ama Mensah');
  await page.getByLabel('Mobile number').nth(0).fill('0241234567');
  await page.getByLabel('Full name').nth(1).fill('Kofi Boateng');
  await page.getByLabel('Mobile number').nth(1).fill('0501234567');
  await page.click('text=Mobile Money — pay online now');
  await page.locator('input[type=checkbox]').last().check();
  await page.click('button:has-text("Confirm booking")');
  await page.waitForSelector('text=Booking received — payment needed');
  const tn = await page.locator('.font-mono').first().innerText();
  const token = await page.locator('.break-all').innerText();
  log('booked', tn);
  await page.screenshot({ path: `${SP}/p2-1-pay-needed.png`, fullPage: true });

  // 2. Pay through hosted checkout (fake Paystack), return, server-verified confirmation
  await page.click('button:has-text("Pay GH₵")');
  await page.waitForURL(/127\.0\.0\.1:7070\/checkout/);
  log('on checkout page:', await page.locator('p').innerText());
  await page.click('button:has-text("Approve Mobile Money payment")');
  await page.waitForURL(/\/payment\/return/);
  await page.waitForSelector('text=Payment received', { timeout: 20000 });
  await page.screenshot({ path: `${SP}/p2-2-paid.png`, fullPage: true });
  log('return page:', (await page.locator('h1').innerText()));
  await page.click('a:has-text("Receipt")');
  await page.waitForSelector('text=Payment receipt');
  log('receipt shows:', await page.locator('text=via Mobile Money').innerText());
  await page.screenshot({ path: `${SP}/p2-3-receipt.png`, fullPage: true });

  // 3. Public tracking from a fresh browser (no access code): no personal data
  const anon = await browser.newPage();
  await anon.goto(`${BASE}/track`);
  await anon.getByLabel('Tracking number').fill(tn.toLowerCase());
  await anon.click('button:has-text("Track")');
  await anon.waitForSelector('text=History');
  const body = await anon.locator('main').innerText();
  log('public status:', await anon.locator('h2').first().innerText());
  log('public view leaks names/phones?', /Ama|Kofi|024|050|\+233/.test(body));
  log('timeline:', (await anon.locator('ol li p.font-medium').allInnerTexts()).join(' | '));
  await anon.screenshot({ path: `${SP}/p2-4-public-track.png`, fullPage: true });
  // wrong code feedback
  await anon.getByRole('textbox', { name: /Are you the sender/ }).fill('A'.repeat(32));
  await anon.click('button:has-text("Show details")');
  await anon.waitForSelector('text=does not match');
  log('wrong code message shown');

  // 4. Create account by email, verify via emulator, claim the guest booking
  const acct = await browser.newPage();
  await acct.goto(`${BASE}/signin`);
  await acct.click('button:has-text("Create account")');
  await acct.getByLabel('Your name').fill('Ama Mensah');
  await acct.getByLabel('Email').fill('ama@example.test');
  await acct.getByLabel('Password').fill('correct-horse-9');
  await acct.locator('form button.btn-primary').click();
  await acct.waitForSelector('text=I have verified my email');
  const codes = await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-courier/oobCodes')).json();
  const link = codes.oobCodes.filter((c) => c.requestType === 'VERIFY_EMAIL').at(-1).oobLink;
  await fetch(link);
  await acct.click('button:has-text("I have verified my email")');
  await acct.waitForSelector('text=My bookings', { timeout: 20000 });
  log('signed in; empty list:', await acct.locator('text=No bookings yet').count());
  await acct.click('text=Add a booking you made as a guest');
  await acct.getByLabel('Tracking number').fill(tn);
  await acct.getByLabel('Access code').fill(token);
  await acct.click('button:has-text("Add booking")');
  await acct.waitForSelector(`text=${tn}`);
  log('claimed booking listed:', await acct.locator(`a:has-text("${tn}")`).count());
  await acct.screenshot({ path: `${SP}/p2-5-account.png`, fullPage: true });
  // owner sees full details without the code
  await acct.click(`a:has-text("${tn}")`);
  await acct.waitForSelector('text=Kofi Boateng');
  log('owner sees full details without code');

  // saved address → reuse it in the booking form
  await acct.goto(`${BASE}/account`);
  await acct.click('button:has-text("+ Add address")');
  await acct.getByLabel('Label (e.g. Home, Shop)').fill('Shop');
  await acct.locator('#New\\ address-search').fill('adum');
  await acct.locator('button:has-text("Adum, Kumasi")').click();
  await acct.click('button:has-text("Save address")');
  await acct.waitForSelector('li:has-text("Shop")');
  log('saved address stored');
  await acct.goto(`${BASE}/book`);
  await acct.getByLabel('Destination: use a saved address').selectOption({ label: 'Shop — Adum, Kumasi' });
  log('destination filled from saved address:', await acct.getByLabel('Address / description').nth(1).inputValue());

  // 5. Declined payment path
  const p2 = await browser.newPage();
  await p2.goto(`${BASE}/book`);
  for (const [f, q, l] of [['Pickup', 'oxford', 'Oxford Street, Osu, Accra'], ['Destination', 'adum', 'Adum, Kumasi']]) {
    await p2.locator(`#${f}-search`).fill(q);
    await p2.locator(`button:has-text("${l}")`).click();
  }
  await p2.click('button:has-text("Continue")');
  await p2.getByLabel('What is it?').fill('Documents');
  for (const [l, v] of [['Weight (kg)', '1'], ['Length (cm)', '30'], ['Width (cm)', '20'], ['Height (cm)', '2'], ['Quantity', '1']]) await p2.getByLabel(l).fill(v);
  await p2.click('button:has-text("Get price")');
  await p2.click('button:has-text("Continue to book")');
  await p2.getByLabel('Full name').nth(0).fill('Yaw Owusu');
  await p2.getByLabel('Mobile number').nth(0).fill('0551234567');
  await p2.getByLabel('Full name').nth(1).fill('Efua Ansah');
  await p2.getByLabel('Mobile number').nth(1).fill('0261234567');
  await p2.click('text=Card — pay online now');
  await p2.locator('input[type=checkbox]').last().check();
  await p2.click('button:has-text("Confirm booking")');
  await p2.click('button:has-text("Pay GH₵")');
  await p2.waitForURL(/checkout/);
  await p2.click('button:has-text("Decline")');
  await p2.waitForSelector('text=Payment not completed', { timeout: 20000 });
  log('declined payment shows retry:', await p2.locator('button:has-text("Try again")').count());
  await p2.screenshot({ path: `${SP}/p2-6-declined.png`, fullPage: true });

  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const path of ['/track/' + tn, '/signin', '/payment/return?tn=' + tn]) {
    await m.goto(BASE + path);
    await m.waitForTimeout(800);
    log('mobile overflow', path, await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  }
  log('console errors:', errors.filter((e) => !/App Check|recaptcha/i.test(e)));
  await browser.close();
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
