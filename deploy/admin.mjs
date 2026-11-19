// One-off administration from the GitHub website (.github/workflows/admin.yml).
//   seed-config      load service areas, hubs/routes and prices from firebase/seed/*.json
//   make-super-admin give the first owner account full control (after they sign up and verify email)
import { env, run, stop, summary, StopError } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
let project;
try {
  project = JSON.parse(env.GCP_SA_KEY || '').project_id;
} catch {
  /* handled below */
}
try {
  if (!project) stop('GCP_SA_KEY is missing or invalid', [`Add it under Settings → Environments → *${env.DEPLOY_ENV}* → Environment secrets (setup guide, step 3).`]);
  const tsx = (script, args) => run('pnpm', ['--filter', '@courier/functions', 'exec', 'tsx', script, '--project', project, ...args], { cwd: ROOT });

  if (env.TASK === 'seed-config') {
    tsx('scripts/seed.ts', []);
    summary(`✅ Service areas, hubs/routes and prices loaded into \`${project}\` from \`firebase/seed/\`.\n\nTo change prices later, edit \`firebase/seed/pricing-rules.sample.json\` on GitHub (✏️ button) and run this task again — each run publishes a new, audited price version (bookings keep the price they were quoted).`);
  } else if (env.TASK === 'make-super-admin') {
    const email = (env.EMAIL || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) stop('Enter the email address', ['Type the email the person signed up with on the website in the **email** box when you run the task.']);
    const r = run('pnpm', ['--filter', '@courier/functions', 'exec', 'tsx', 'scripts/bootstrap-admin.ts', '--project', project, '--email', email], { cwd: ROOT, allowFail: true });
    if (!r.ok) {
      const why = r.err + r.out;
      if (/no user record|USER_NOT_FOUND/i.test(why)) stop('No account with that email', ['Sign up on the website first (Sign in → Create account), then run this again.']);
      if (/verify their email/.test(why)) stop('The email address is not verified yet', ['Open the verification email Firebase sent to that address and tap the link, then run this again.']);
      if (/already 3 super admins/.test(why)) stop('There are already 3 super admins', ['Use the Staff page in the operations app instead.']);
      throw new Error(why.trim().split('\n').slice(-3).join(' '));
    }
    summary(`✅ **${email}** is now super admin of \`${project}\`.\n\nOpen the operations app, sign in with that email and set up two-step verification (a code by SMS). From then on, give other staff access on the ops app's **Staff** page.`);
  } else stop('Unknown task', [String(env.TASK)]);
} catch (e) {
  if (!(e instanceof StopError)) {
    console.error(e);
    summary(`❌ ${String(e.message ?? e).slice(0, 400)}`);
  }
  process.exit(1);
}
