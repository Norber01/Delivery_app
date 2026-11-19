/**
 * Browser E2E for Phase 5 (Playwright): customer registers a business (document upload through a
 * signed URL) → admin verifies it in ops (opens the document) → finance approves credit and a
 * contract discount → owner invites staff → CSV bulk upload (preview with a bad row, invoice
 * billing, confirm, labels) → finance generates the month's invoice, records part then full
 * payment → owner sees the paid invoice and the monthly report.
 * Prerequisites: test-integration/e2e-up.sh, then (before every run; resets the accounts)
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node test-integration/e2e-seed-users.mjs
 * Run: node test-integration/e2e-phase5.cjs <screenshot-dir>
 */
const { chromium } = require('playwright');
const SP = process.argv[2] ?? '/tmp/courier-e2e';
const WEB = 'http://127.0.0.1:4173';
const OPS = 'http://127.0.0.1:4174';
const AUTH = 'http://127.0.0.1:9099';
const log = (...a) => console.log('•', ...a);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
const STAFF_EMAIL = `kwesi.${RUN.toLowerCase()}@example.test`;
const LEGAL = `Adwoa Styles Enterprise ${RUN} Ltd`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, what) => { if (!cond) throw new Error(`CHECK FAILED: ${what}`); log('ok:', what); };

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
const status = (p) => p.locator('[role=status]').first();
async function expectStatus(p, text) {
  await p.waitForSelector(`[role=status]:has-text("${text}")`, { timeout: 15000 });
}

const CSV = [
  'reference,recipient_name,recipient_phone,recipient_email,address_line1,landmark,city,region,ghanapost_gps,lat,lng,description,weight_kg,length_cm,width_cm,height_cm,quantity,urgency,special_handling,declared_value_ghs,instructions',
  'ORD-1001,Kofi Boateng,0501234567,,Madina Market shop 12,Opposite the lorry station,Accra,Greater Accra,,5.6681,-0.1653,Dress,0.5,30,20,5,1,standard,fragile,,Call on arrival',
  'ORD-1002,Abena Owusu,0241112223,,Adum near Kejetia,,Kumasi,Ashanti,,6.6966,-1.6233,Shoes,1.2,35,25,12,1,standard,,,',
  'ORD-1003,Yaw Mensah,0209998887,,Oxford Street Osu,,Accra,Greater Accra,,5.556,-0.1823,"Bag, leather",abc,30,20,10,1,express,,,',
  'ORD-1004,Esi Asante,0277654321,,Osu Danquah Circle,,Accra,Greater Accra,,5.5571,-0.1818,Phone case,0.2,15,10,3,2,express,,,',
].join('\n');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p, name) => p.on('console', (m) => m.type() === 'error' && !/recaptchaConfig|501|favicon/.test(m.text()) && errors.push(`${name}: ${m.text().slice(0, 200)}`));
  const shot = (p, name) => p.screenshot({ path: `${SP}/${name}.png`, fullPage: true });

  // 1. Customer signs in and registers a business.
  const web = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(web, 'web');
  await web.goto(`${WEB}/signin`);
  await web.getByRole('button', { name: 'Email sign in' }).click();
  await web.getByLabel('Email').fill('owner@example.test');
  await web.getByLabel('Password').fill('biz-password-1');
  await web.getByRole('button', { name: 'Sign in', exact: true }).click();
  await web.waitForURL(/\/account/);
  await web.click('text=Open a business account');
  await web.waitForSelector('h1:has-text("Open a business account")');
  await web.getByLabel('Registered (legal) name').fill(LEGAL);
  await web.getByLabel('Trading name').fill('Adwoa Styles');
  await web.getByLabel('Registrar-General number').fill('CS123456789');
  await web.getByLabel('GRA TIN').fill('C0012345678');
  await web.getByLabel('Name', { exact: true }).fill('Adwoa Mensah');
  await web.getByLabel('Mobile number').fill('0244556677');
  await web.locator('[id="Pickup address (where we collect your parcels)-search"]').fill('oxford');
  await web.locator('button:has-text("Oxford Street, Osu, Accra")').click();
  await web.getByLabel('Registration documents').setInputFiles({ name: 'certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e certificate\n%%EOF\n') });
  await shot(web, 'p5-1-register');
  await web.click('button:has-text("Submit for verification")');
  await web.waitForSelector('text=Verification in progress', { timeout: 20000 });
  check(await web.isVisible('text=Not set up'), 'new business has no invoice billing');
  check(await web.locator('nav[aria-label="Business sections"] button:has-text("Invoices")').isVisible(), 'owner sees invoices tab');

  // 2. Admin verifies in ops (opens the uploaded certificate first).
  const ops = await opsSignIn(browser, 'ops@example.test');
  watch(ops, 'ops');
  await ops.click('a:has-text("Businesses")');
  await ops.click(`button:has-text("${LEGAL}")`);
  const [req] = await Promise.all([ops.context().waitForEvent('request', (r) => /8788\/evidence\/kyb\//.test(r.url())), ops.click('button:has-text("Document 1")')]);
  const doc = { url: () => req.url() };
  const fetched = await fetch(doc.url());
  check(fetched.status === 200 && (await fetched.text()).startsWith('%PDF'), 'certificate opens through a signed evidence URL');
  const tampered = await fetch(doc.url().replace(/sig=[0-9a-f]{4}/, 'sig=0000'));
  check(tampered.status === 403, 'tampered evidence URL refused');
  for (const p of ops.context().pages()) if (p !== ops) await p.close();
  await ops.getByRole('button', { name: 'Verify' }).click();
  await expectStatus(ops, 'Marked verified');
  await ops.getByRole('tab', { name: 'verified', exact: true }).click();
  await ops.click(`button:has-text("${LEGAL}")`);

  // 3. Finance: credit + contract pricing (admin may also set them; use the finance role to prove access).
  const fin = await opsSignIn(browser, 'finance@example.test');
  watch(fin, 'finance');
  log('finance header:', await fin.locator('header').innerText());
  check(fin.url().endsWith('/invoices'), 'finance lands on invoices');
  await fin.click('a:has-text("Businesses")');
  await fin.getByRole('tab', { name: 'verified', exact: true }).click();
  await fin.click(`button:has-text("${LEGAL}")`);
  check((await fin.getByRole('button', { name: 'Suspend', exact: true }).count()) === 0, 'finance cannot change verification');
  await fin.getByLabel('Limit (GH₵, 0 removes)').fill('5000');
  await fin.getByLabel('Payment terms (days)').fill('30');
  await fin.click('button:has-text("Save credit")');
  await expectStatus(fin, 'Credit terms saved');
  await fin.getByLabel('Discount %').fill('10');
  const until = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  await fin.getByLabel('Valid until').fill(until);
  await fin.click('button:has-text("Save contract")');
  await expectStatus(fin, 'Contract pricing saved');
  await shot(fin, 'p5-2-ops-business');

  // 4. Owner: dashboard reflects verification and credit live; invite a staff member.
  await web.waitForSelector('text=Verified business', { timeout: 15000 });
  await web.waitForSelector('text=GH₵ 0.00 of GH₵ 5,000.00 used');
  await web.waitForSelector('text=10% contract discount');
  await shot(web, 'p5-3-business-overview');
  await web.click('nav[aria-label="Business sections"] button:has-text("Staff")');
  await web.getByLabel('Name').fill('Kwesi Appiah');
  await web.getByLabel('Work email').fill(STAFF_EMAIL);
  await web.click('button:has-text("Invite")');
  await web.waitForSelector('text=Send this one-time link');
  await web.waitForSelector(`text=${STAFF_EMAIL}`);
  log('staff invited');

  // 5. Bulk upload: 4 rows, one invalid; billed on the monthly invoice.
  await web.click('nav[aria-label="Business sections"] button:has-text("Bulk upload")');
  await web.getByLabel('CSV file').setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await web.locator('label:has-text("Monthly invoice") input').check();
  await web.click('button:has-text("Check and price")');
  await web.waitForSelector('text=3 ready · 1 to fix', { timeout: 30000 });
  check(await web.isVisible('text=weight_kg must be a number'), 'bad row explained');
  await shot(web, 'p5-4-bulk-preview');
  await web.locator('label:has-text("I confirm the parcel details") input').check();
  await web.click('button:has-text("Book 3 parcel(s)")');
  await web.waitForSelector('text=3 parcel(s) booked', { timeout: 30000 });
  await web.click('a:has-text("Print labels")');
  await web.waitForSelector('article[aria-label^="Label GH"]');
  check((await web.locator('article[aria-label^="Label"]').count()) === 3, '3 labels');
  await shot(web, 'p5-5-bulk-labels');
  await web.goto(`${WEB}/business`);
  await web.waitForSelector('text=Verified business');
  const usedText = await web.locator('p:has-text(" used")').first().innerText();
  log('credit after bulk:', usedText);
  check(!usedText.startsWith('GH₵ 0.00'), 'credit used increased');
  await web.click('nav[aria-label="Business sections"] button:has-text("Bookings")');
  await web.waitForSelector('text=ORD-1004');
  check((await web.locator('text=on invoice').count()) === 0, 'not yet invoiced');

  // 6. Finance: invoice the current month, record a part payment then the balance.
  const period = new Date().toISOString().slice(0, 7);
  await fin.click('a:has-text("Invoices")');
  await fin.getByLabel('Billing month').fill(period);
  await fin.click('button:has-text("Generate invoices")');
  await expectStatus(fin, 'Issued 1 invoice(s)');
  await fin.click('button:has-text("Generate invoices")');
  await expectStatus(fin, 'Nothing to invoice');
  log('re-run is a no-op');
  await fin.click(`td:has-text("${LEGAL}")`);
  const header = await fin.locator('section h2').first().innerText();
  const number = header.split(' · ')[0];
  log('invoice', header);
  await fin.getByLabel('Amount (GH₵)').fill('10');
  await fin.getByLabel('Bank / MoMo reference').fill('GCB-TRF-0001');
  await fin.click('button:has-text("Record payment")');
  await expectStatus(fin, 'Payment recorded');
  await fin.getByRole('tab', { name: 'Part paid' }).click();
  await fin.click(`td:has-text("${LEGAL}")`);
  await fin.getByLabel('Method').selectOption('mobile_money');
  await fin.getByLabel('Bank / MoMo reference').fill('MOMO-778899');
  await fin.click('button:has-text("Record payment")'); // amount pre-filled with the balance
  await expectStatus(fin, 'Payment recorded');
  await fin.getByRole('tab', { name: 'Paid', exact: true }).click();
  await fin.click(`td:has-text("${LEGAL}")`);
  await shot(fin, 'p5-6-ops-invoice-paid');

  // 7. Owner: paid invoice, printable view, report.
  await web.click('nav[aria-label="Business sections"] button:has-text("Invoices")');
  await web.waitForSelector(`a:has-text("${number}")`);
  check(await web.isVisible('td:has-text("Paid")'), 'owner sees invoice paid');
  await web.click(`a:has-text("${number}")`);
  await web.waitForSelector('text=Balance due');
  check((await web.locator('tbody tr').count()) === 3, 'invoice has 3 lines');
  await shot(web, 'p5-7-invoice');
  await web.goto(`${WEB}/business`);
  await web.waitForSelector('text=GH₵ 0.00 of GH₵ 5,000.00 used');
  log('credit released after payment');
  await web.click('nav[aria-label="Business sections"] button:has-text("Reports")');
  await web.click('button:has-text("Show report")');
  await web.waitForSelector('text=Top destinations');
  const tiles = await web.locator('.card p.text-xl').allInnerTexts();
  log('report tiles', tiles.join(' | '));
  check(tiles[0] === '3', 'report counts 3 bookings');
  await shot(web, 'p5-8-report');

  log('console errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
