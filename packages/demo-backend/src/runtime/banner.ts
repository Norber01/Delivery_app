/**
 * The demo bar shown on every page: explains that this is a demo, signs in as any sample person
 * in one tap, shows the text messages customers would receive (e.g. delivery codes), links the
 * website and the ops app, and resets the sample data.
 */
import { ACCOUNTS, STORAGE_KEY, theDb } from './core.js';
import { clearFiles } from './evidence.js';
import { DRIVERS, PEOPLE } from './seed.js';
import { DEMO_PASSWORD } from './wiring.js';

const env = ((import.meta as { env?: Record<string, string> }).env ?? {}) as Record<string, string>;
const WEB = env.VITE_DEMO_WEB_BASE || '/';
const OPS = env.VITE_DEMO_OPS_BASE || '/ops/';
const SESSION = (base: string) => `courier-demo-session:${base}`;

const css = `
#cdemo{position:fixed;top:0;left:0;right:0;z-index:2147483000;font:13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1e1b4b}
#cdemo .bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#fef3c7;border-bottom:1px solid #f59e0b;padding:6px 10px}
#cdemo .tag{background:#b45309;color:#fff;border-radius:4px;padding:2px 6px;font-weight:700;letter-spacing:.04em}
#cdemo button,#cdemo a.btn{background:#fff;border:1px solid #d97706;border-radius:6px;padding:3px 8px;color:#78350f;font:inherit;cursor:pointer;text-decoration:none}
#cdemo .panel{background:#fff;border-bottom:1px solid #e5e7eb;box-shadow:0 8px 16px rgba(0,0,0,.08);max-height:65vh;overflow:auto;padding:10px 12px}
#cdemo .panel h3{margin:4px 0 8px;font-size:14px}
#cdemo .who{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px}
#cdemo .who button{text-align:left;border-color:#e5e7eb;color:#111827}
#cdemo .who small,#cdemo .sms small{color:#6b7280;display:block}
#cdemo .sms li{border-bottom:1px solid #f3f4f6;padding:5px 0;list-style:none}
#cdemo ul{margin:0;padding:0}
#cdemo .grow{flex:1;min-width:120px;color:#78350f}
#cdemo .short{display:none;color:#78350f}
@media (max-width:640px){#cdemo .bar{gap:4px;padding:4px 6px;font-size:12px}#cdemo .grow{display:none}#cdemo .short{display:inline;flex:1}#cdemo button,#cdemo a.btn{padding:2px 6px}}
`;

function signInAs(uid: string, staff: boolean) {
  try {
    localStorage.setItem(SESSION(staff ? OPS : WEB), uid);
  } catch {
    /* ignore */
  }
  location.href = staff ? OPS : `${WEB}${uid === 'd_adwoa' ? 'business' : 'account'}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

export function mountBanner() {
  if (document.getElementById('cdemo')) return;
  document.head.append(el('style', {}, css));
  const root = el('div', { id: 'cdemo', role: 'region', 'aria-label': 'Demo controls' });
  const panel = el('div', { class: 'panel', hidden: '' });
  const smsBtn = el('button', { type: 'button' }, 'Text messages');
  const isOps = location.pathname.startsWith(OPS);
  const bar = el(
    'div',
    { class: 'bar' },
    el('span', { class: 'tag' }, 'DEMO'),
    el('span', { class: 'grow' }, 'Sample data — nothing is real. Phone codes: 123456. Passwords: ' + DEMO_PASSWORD),
    el('span', { class: 'short' }, 'Sample data'),
    el('button', { type: 'button', 'data-panel': 'who' }, 'Sign in as…'),
    smsBtn,
    el('a', { class: 'btn', href: isOps ? WEB : OPS }, isOps ? 'Website' : 'Ops app'),
    el('a', { class: 'btn', href: `${OPS}rider` }, 'Rider app'),
    el('button', { type: 'button', 'data-panel': 'reset' }, 'Reset'),
  );
  root.append(bar, panel);
  document.body.prepend(root);
  const pad = () => {
    document.body.style.paddingTop = `${bar.offsetHeight}px`;
    document.documentElement.style.setProperty("--demo-bar", `${bar.offsetHeight}px`);
  };
  pad();
  new ResizeObserver(pad).observe(bar);

  let open: string | null = null;
  const show = (which: string | null) => {
    open = open === which ? null : which;
    panel.hidden = !open;
    panel.replaceChildren();
    if (open === 'who') {
      const grid = el('div', { class: 'who' });
      const riders = el('div', { class: 'who' });
      for (const d of DRIVERS) {
        const b = el('button', { type: 'button' }, el('strong', {}, d.name), el('small', {}, d.riderType === 'pickup' ? 'Pickup rider — collects parcels, brings them to the warehouse' : 'Delivery rider — takes parcels from the warehouse to recipients'), el('small', {}, d.email));
        b.onclick = () => (location.href = `${OPS}rider?as=${d.uid}`);
        riders.append(b);
      }
      for (const p of PEOPLE) {
        const staff = !['customer'].includes(p.role);
        const b = el('button', { type: 'button' }, el('strong', {}, p.name), el('small', {}, p.what), el('small', {}, p.email));
        b.onclick = () => signInAs(p.uid, staff);
        grid.append(b);
      }
      panel.append(
        el('h3', {}, 'Sign in as a sample person'),
        el('p', {}, el('small', {}, `Or use the normal sign-in pages: every sample password is "${DEMO_PASSWORD}", and phone codes are always 123456.`)),
        grid,
        el('h3', {}, 'Riders (the rider app)'),
        el('p', {}, el('small', {}, 'In real life riders use the Android app on their own phone. Here it opens as a phone screen in this browser.')),
        riders,
      );
    } else if (open === 'sms') {
      const rows = theDb()
        .list('notifications')
        .map(([, n]) => n as { recipientPhone?: string; body?: string; createdAt?: { toMillis: () => number } })
        .sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
        .slice(0, 30);
      const list = el('ul', { class: 'sms' });
      for (const n of rows) {
        list.append(el('li', {}, el('small', {}, `To ${n.recipientPhone ?? 'customer'} · ${n.createdAt ? new Date(n.createdAt.toMillis()).toLocaleString('en-GH') : ''}`), n.body ?? ''));
      }
      panel.append(el('h3', {}, 'Text messages customers would receive (newest first)'), rows.length ? list : el('p', {}, 'None yet.'));
    } else if (open === 'reset') {
      const yes = el('button', { type: 'button' }, 'Yes, start again with fresh sample data');
      yes.onclick = async () => {
        theDb().reset();
        await clearFiles();
        try {
          for (const k of Object.keys(localStorage)) if (k.startsWith('courier-demo')) localStorage.removeItem(k);
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
        location.href = WEB;
      };
      panel.append(el('h3', {}, 'Reset the demo?'), el('p', {}, 'Everything you created or changed in this browser is removed and the sample data is rebuilt.'), yes);
    }
  };
  bar.querySelector('[data-panel="who"]')!.addEventListener('click', () => show('who'));
  bar.querySelector('[data-panel="reset"]')!.addEventListener('click', () => show('reset'));
  smsBtn.addEventListener('click', () => show('sms'));
  const count = () => (smsBtn.textContent = `Text messages (${theDb().list('notifications').length})`);
  count();
  theDb().subscribe(() => {
    count();
    if (open === 'sms') {
      open = null;
      show('sms');
    }
  });
  void ACCOUNTS;
}
