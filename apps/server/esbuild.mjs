/**
 * Bundle the browser client (editor + replay) into public/assets.
 *
 * Both entry points import the shared @scriptorium/schema package — the same
 * schema the server applies — so esbuild resolves it from the workspace and
 * there is exactly one schema in the shipped bundle.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: {
    editor: join(here, 'client', 'editor.ts'),
    replay: join(here, 'client', 'replay.ts'),
  },
  outdir: join(here, 'public', 'assets'),
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
  loader: { '.css': 'css' },
});

// eslint-disable-next-line no-console
console.log('Client bundled to public/assets/{editor,replay}.js');
