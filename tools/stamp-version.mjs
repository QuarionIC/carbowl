// Writes docs/version.json: the version of the app (taken from docs/js/app.js) and a SHA-256
// checksum for every file of the app itself. The page reads it to learn whether a newer version
// is published and to check that it holds a complete, unmixed copy (see docs/js/update.js).
//
// Run it before every release, after the last change to the site:
//   node tools/stamp-version.mjs            writes the file
//   node tools/stamp-version.mjs --check    exits with 1 when the file is out of date (used by the tests)
//
// The checksums are of the files as GitHub Pages serves them, which is as git stores them: with
// plain line feeds. On Windows the working copy may hold CR LF line ends, so those are folded
// before hashing.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

/** The files that make up the app: its page, style, scripts and the list of models. Not the models, not this file, not the service worker. */
export async function appFiles (dir = root) {
  const out = ['index.html', 'app.css', 'models/manifest.json'];
  const scripts = async rel => (await readdir(path.join(dir, rel), { withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith('.js')).map(e => `${rel}/${e.name}`);
  out.push(...await scripts('js'), ...await scripts('js/workers'), ...await scripts('vendor'), ...await scripts('vendor/sherpa'));
  return out.sort();
}

export async function servedBytes (file, dir = root) {
  const raw = await readFile(path.join(dir, file));
  // Text files only (everything in the list is text): fold CR LF to LF, as git does on the way in.
  return Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

export async function versionInfo (dir = root) {
  const app = await readFile(path.join(dir, 'js', 'app.js'), 'utf8');
  const m = app.match(/const VERSION = '([^']+)'/);
  if (!m) throw new Error('no VERSION in docs/js/app.js');
  const files = {};
  for (const f of await appFiles(dir)) files[f] = createHash('sha256').update(await servedBytes(f, dir)).digest('hex');
  return { version: m[1], files };
}

export const render = info => JSON.stringify(info, null, 1) + '\n';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = await versionInfo();
  const target = path.join(root, 'version.json');
  let current = '';
  try { current = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n'); } catch (e) { /* not written yet */ }
  if (process.argv.includes('--check')) {
    if (current !== render(info)) { console.error('docs/version.json is out of date: run node tools/stamp-version.mjs'); process.exit(1); }
    console.log(`docs/version.json is up to date (${info.version}, ${Object.keys(info.files).length} files)`);
  } else {
    await writeFile(target, render(info));
    console.log(`wrote docs/version.json: ${info.version}, ${Object.keys(info.files).length} files${current === render(info) ? ' (unchanged)' : ''}`);
  }
}
