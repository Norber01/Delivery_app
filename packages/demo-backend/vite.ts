/**
 * Vite settings that turn a normal build of the website or ops app into the card-free demo:
 * Firebase (and the server libraries the real services use) are replaced by the in-browser
 * stand-ins in this package. Used only when VITE_DEMO=true.
 */
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export const demoAlias = [
  { find: /^firebase\/app$/, replacement: src('client/app.ts') },
  { find: /^firebase\/auth$/, replacement: src('client/auth.ts') },
  { find: /^firebase\/firestore$/, replacement: src('client/firestore.ts') },
  { find: /^firebase\/functions$/, replacement: src('client/functions.ts') },
  { find: /^firebase\/database$/, replacement: src('client/database.ts') },
  { find: /^firebase\/app-check$/, replacement: src('client/appCheck.ts') },
  { find: /^firebase-admin\/firestore$/, replacement: src('admin/firestore.ts') },
  { find: /^firebase-admin\/app$/, replacement: src('admin/app.ts') },
  { find: /^firebase-functions\/v2\/https$/, replacement: src('node/https.ts') },
  { find: /^node:crypto$/, replacement: src('node/crypto.ts') },
];

/** Restores the address GitHub Pages' 404 page redirected from (single-page app routing). */
export function demoHtml(): Plugin {
  return {
    name: 'courier-demo-html',
    transformIndexHtml(html: string) {
      const restore = `<script>(function(){var p=new URLSearchParams(location.search).get('__p');if(p)history.replaceState(null,'',p)})()</script>`;
      return html.replace('<head>', `<head>\n    ${restore}\n    <meta name="robots" content="noindex" />`);
    },
  };
}
