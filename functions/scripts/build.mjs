// Bundles functions + workspace packages into .deploy/ with a deploy-only package.json.
// Workspace packages are bundled (they are never published); firebase-admin and
// firebase-functions stay external and are installed by Cloud Build.
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.deploy');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(out, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies),
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
await writeFile(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'courier-functions-deploy',
      private: true,
      type: 'module',
      main: 'lib/index.js',
      engines: pkg.engines,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);
console.log('Functions bundle written to', out);
