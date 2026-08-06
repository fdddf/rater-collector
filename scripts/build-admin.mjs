/**
 * Wraps the built admin console (a single self-contained `index.html`) in a TypeScript
 * string constant, so the Worker keeps serving it straight from its own bundle.
 *
 * Run via `npm run build:admin` in worker/. The generated file is committed, so a plain
 * `wrangler deploy` never needs the UI toolchain.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'admin-ui/dist/index.html');
const target = resolve(root, 'src/admin/dashboard.ts');

const html = await readFile(source, 'utf8');

// JSON.stringify rather than a template literal: the minified bundle contains backticks and
// `${`, both of which would terminate a template early (and `String.raw` would keep the
// escaping backslashes verbatim).
const literal = JSON.stringify(html);

await writeFile(
  target,
  `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Built from admin-ui/ by scripts/build-admin.mjs (\`npm run build:admin\`). The console is a
 * React + TypeScript + Tailwind app that Vite collapses into one self-contained HTML file,
 * inlined here so deploying the Worker still deploys the console — no second pipeline and no
 * static-asset binding.
 */
export const dashboardHTML = ${literal};
`,
  'utf8',
);

console.log(
  `admin console → src/admin/dashboard.ts (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`,
);
