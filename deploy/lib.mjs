// Small helpers shared by the deploy scripts (run inside GitHub Actions).
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const env = process.env;

/** Markdown appended to the run's summary page (what the person sees on their phone). */
export function summary(md) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
}

export class StopError extends Error {}

/** Stop with a plain-language explanation shown at the top of the summary. */
export function stop(title, lines) {
  summary(`\n### ❌ ${title}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
  throw new StopError(title);
}

let stepNo = 0;
export async function step(title, fn) {
  stepNo++;
  console.log(`\n::group::${stepNo}. ${title}`);
  try {
    const r = await fn();
    console.log('::endgroup::');
    summary(`- ✅ ${title}`);
    return r;
  } catch (e) {
    console.log('::endgroup::');
    if (!(e instanceof StopError)) summary(`- ❌ ${title} — ${String(e.message ?? e).split('\n')[0].slice(0, 300)}`);
    throw e;
  }
}

/** Run a command; returns stdout. Secrets are passed via files/stdin, never arguments. */
export function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: opts.input, cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
  if (!opts.quiet) {
    if (r.stdout) process.stdout.write(r.stdout.slice(-20000));
    if (r.stderr) process.stderr.write(r.stderr.slice(-20000));
  }
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  return opts.allowFail ? { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' } : r.stdout;
}

let token = null;
let tokenAt = 0;
function gcpToken() {
  if (!token || Date.now() - tokenAt > 30 * 60_000) {
    token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
    tokenAt = Date.now();
  }
  return token;
}

/** Google REST call with the deploy service account. Returns { status, body }. */
export async function gcp(method, url, body, { project } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${gcpToken()}`,
      'Content-Type': 'application/json',
      ...(project ? { 'X-Goog-User-Project': project } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/** Wait for a long-running Google operation (if the response is one). */
export async function waitOp(base, op) {
  if (!op?.name || op.done) return op;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await gcp('GET', `${base}/${op.name}`);
    if (r.body?.done) {
      if (r.body.error) throw new Error(r.body.error.message);
      return r.body;
    }
  }
  throw new Error(`Timed out waiting for ${op.name}`);
}

/** Cloudflare API call. Returns { status, body } (body.success, body.result, body.errors). */
export async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export const errText = (r) => JSON.stringify(r.body?.error ?? r.body?.errors ?? r.body).slice(0, 400);
