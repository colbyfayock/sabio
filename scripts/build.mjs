import { build } from 'esbuild';
import { mkdir, readdir, copyFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const allowedOutputs = new Set(['index.html', 'admin.html', 'styles.css', 'app.js', 'admin.js', 'favicon.svg']);
await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink()) throw new Error('dist must not be a symlink.');
// Refuse unexpected files rather than uploading stale/private content or deleting unknown work.
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!allowedOutputs.has(entry.name) || !entry.isFile()) throw new Error('Unexpected file in dist; inspect it before building.');
}
for (const name of ['index.html', 'admin.html', 'styles.css', 'favicon.svg']) {
  const source = join(root, 'web', name);
  if (!(await lstat(source)).isFile()) throw new Error('Static source must be a regular file.');
  await copyFile(source, join(output, name));
}
await build({
  entryPoints: [join(root, 'web/app.ts'), join(root, 'web/admin.ts')],
  outdir: output,
  bundle: true,
  format: 'iife',
  target: ['firefox68'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
});
console.log('Built Firefox 68 display; no cloud resources created.');
