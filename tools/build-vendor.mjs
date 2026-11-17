// Bundles Anthropic's JavaScript SDK (from node_modules) into one browser module, docs/vendor/anthropic-sdk.js,
// and writes the licences of every package that ended up inside it to docs/vendor/anthropic-sdk.LICENSES.txt.
// The site has no build step of its own: this is run by hand when the SDK version changes.
//
//   npm install            (once; fetches @anthropic-ai/sdk and esbuild, the versions pinned in package.json)
//   node tools/build-vendor.mjs
import { build } from 'esbuild';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'docs', 'vendor', 'anthropic-sdk.js');

const result = await build({
  absWorkingDir: root,
  stdin: { contents: "export { default } from '@anthropic-ai/sdk';\n", resolveDir: root, sourcefile: 'anthropic-sdk-entry.js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'safari16'],
  minify: true,
  legalComments: 'none',
  outfile: outFile,
  metafile: true,
  logLevel: 'warning'
});

// Which packages are in the bundle (only files that contributed bytes count).
const output = Object.values(result.metafile.outputs)[0];
const packages = new Map();
for (const [file, info] of Object.entries(output.inputs)) {
  if (!info.bytesInOutput) continue;
  const m = file.replace(/\\/g, '/').match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (!m) continue;
  const p = packages.get(m[2]) || { dir: path.join(root, m[1]), bytes: 0 };
  p.bytes += info.bytesInOutput;
  packages.set(m[2], p);
}

const parts = [];
const summary = [];
for (const [name, p] of [...packages].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const pkg = JSON.parse(await readFile(path.join(p.dir, 'package.json'), 'utf8'));
  summary.push(`${name} ${pkg.version} (${pkg.license || 'licence not stated'}), ${(p.bytes / 1024).toFixed(1)} KB`);
  const files = (await readdir(p.dir)).filter(f => /^(licen[cs]e|notice|copying|unlicense)/i.test(f)).sort();
  parts.push('='.repeat(100), `${name} ${pkg.version}`, `Licence: ${pkg.license || 'not stated'}`, pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '', '='.repeat(100), '');
  if (!files.length) parts.push('(This package ships no licence file; see the licence named above.)', '');
  for (const f of files) parts.push(`--- ${f} ---`, '', (await readFile(path.join(p.dir, f), 'utf8')).replace(/\r\n/g, '\n').trimEnd(), '');
}
const sdk = JSON.parse(await readFile(path.join(root, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8'));
const header = [
  'docs/vendor/anthropic-sdk.js is a bundle (made by tools/build-vendor.mjs with esbuild) of the packages',
  'listed below, unmodified apart from bundling and minification. Their licences follow.',
  '',
  ...summary.map(s => '  ' + s),
  ''
];
await writeFile(path.join(root, 'docs', 'vendor', 'anthropic-sdk.LICENSES.txt'), [...header, ...parts].join('\n'));

// A banner inside the bundle itself, so the file says what it is wherever it ends up.
const code = await readFile(outFile, 'utf8');
const banner = `/* @anthropic-ai/sdk ${sdk.version} bundled for the browser; Apache-2.0 and others: see anthropic-sdk.LICENSES.txt beside this file. */\n`;
await writeFile(outFile, banner + code);

const size = (await stat(outFile)).size;
console.log(`wrote docs/vendor/anthropic-sdk.js: ${(size / 1024).toFixed(1)} KB`);
for (const s of summary) console.log('  ' + s);
