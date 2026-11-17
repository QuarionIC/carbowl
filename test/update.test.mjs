// Keeping a device's copy of the app up to date: the page's own check (docs/js/update.js), the
// published list of files it relies on (docs/version.json), and the service worker's part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Updater, readVersionInfo, sha256Hex } from '../docs/js/update.js';
import { versionInfo, appFiles, render } from '../tools/stamp-version.mjs';

const BASE = 'https://example.test/carbowl/';
const sha = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A little site: what is published, what this device holds, and everything that is asked of the network. */
function world ({ running = '1.0.0', published, held = {}, offline = false, busy = '', lazy = [], stored, republishAfter = 0 } = {}) {
  const site = { ...published };                      // path -> text, plus 'version'
  const info = () => ({ version: site.version, files: Object.fromEntries(Object.entries(site).filter(([k]) => k !== 'version').map(([k, v]) => [k, sha(v)])) });
  const calls = []; let versionAsked = 0;
  const w = { calls, reloads: 0, states: [], logs: [], busy, site, held: { ...held } };
  const fetch = async (url, init = {}) => {
    const path = url === BASE ? '(page)' : url.slice(BASE.length);
    calls.push({ path, cache: init.cache });
    if (offline) throw new TypeError('Failed to fetch');
    if (path === 'version.json') { versionAsked++; if (republishAfter && versionAsked > republishAfter) site.version = site.version + '-b'; return new Response(JSON.stringify(info()), { status: 200 }); }
    const key = path === '(page)' ? 'index.html' : path;
    if (!(key in site)) return new Response('not found', { status: 404 });
    if (init.cache === 'reload') w.held[path] = site[key]; // the service worker keeps what it fetched
    return new Response(site[key], { status: 200 });
  };
  const caches = {
    keys: async () => ['carbowl-shell-v2', 'carbowl-models-v1'],
    open: async name => ({ match: async url => { if (name !== 'carbowl-shell-v2') return undefined; const path = url === BASE ? '(page)' : url.slice(BASE.length); return path in w.held ? new Response(w.held[path]) : undefined; } })
  };
  const mem = new Map(stored ? [['update', stored]] : []);
  w.store = { get: k => mem.get(k), set: (k, v) => mem.set(k, v), del: k => mem.delete(k) };
  w.updater = new Updater({ version: running, base: BASE, fetch, caches, busy: () => w.busy, lazy: () => lazy, reload: () => { w.reloads++; }, onState: s => w.states.push(s), store: w.store, log: l => w.logs.push(l), reloadDelayMs: 5 });
  w.fetched = () => calls.filter(c => c.cache === 'reload').map(c => c.path).sort();
  return w;
}
const V1 = { version: '1.0.0', 'index.html': '<p>one</p>', 'app.css': 'a{}', 'js/app.js': 'const VERSION = "1.0.0"', 'js/game.js': 'game 1', 'vendor/anthropic-sdk.js': 'sdk 1' };
const V2 = { version: '1.1.0', 'index.html': '<p>one</p>', 'app.css': 'a{}', 'js/app.js': 'const VERSION = "1.1.0"', 'js/game.js': 'game 2', 'vendor/anthropic-sdk.js': 'sdk 1', 'js/new.js': 'new in 2' };
const holding = v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'version').map(([k, text]) => [k === 'index.html' ? '(page)' : k, text]));

test('update: nothing to do when the published version is the one running, and nothing is fetched', async () => {
  const w = world({ published: V1, held: holding(V1) });
  assert.equal(await w.updater.check('start'), 'current');
  await sleep(20);
  assert.equal(w.reloads, 0);
  assert.deepEqual(w.calls, [{ path: 'version.json', cache: 'no-store' }]);
  assert.equal(w.updater.latest, '1.0.0');
  // Without an offline copy to compare with (first visit, no service worker) the same holds.
  const bare = world({ published: V1 });
  assert.equal(await bare.updater.check(), 'current'); assert.equal(bare.fetched().length, 0);
});

test('update: a newer version is fetched as a checked set (only what changed), then the page reloads into it', async () => {
  const w = world({ published: V2, held: holding(V1) });
  assert.equal(await w.updater.check('page shown'), 'reloading');
  assert.equal(w.reloads, 0, 'a moment is left for the notice to be read');
  await sleep(30);
  assert.equal(w.reloads, 1);
  assert.deepEqual(w.fetched(), ['js/app.js', 'js/game.js', 'js/new.js'], 'the files that changed and the one this device never held; the unchanged ones are left alone');
  assert.deepEqual(w.states, ['checking', 'reloading']);
  assert.deepEqual(w.store.get('update'), { to: '1.1.0', n: 1 });
  assert.equal(w.calls.filter(c => c.path === 'version.json').length, 2, 'the published version is confirmed once more before reloading');
  assert.ok(w.logs.some(l => /version 1\.1\.0 is published; this page runs 1\.0\.0 \(page shown\)/.test(l)));
  // Next, in the reloaded page (which now runs 1.1.0): all is well, and it says that it was updated.
  const after = world({ running: '1.1.0', published: V2, held: w.held, stored: w.store.get('update') });
  assert.equal(await after.updater.check('start'), 'updated');
  assert.equal(after.store.get('update'), undefined);
  assert.equal(after.fetched().length, 0); assert.equal(after.reloads, 0);
});

test('update: with no offline copy to compare with, every file is fetched afresh', async () => {
  const w = world({ published: V2 });
  assert.equal(await w.updater.check(), 'reloading');
  assert.deepEqual(w.fetched(), ['(page)', ...Object.keys(V2).filter(k => k !== 'version' && k !== 'index.html')].sort(), 'the page itself is fetched by its own address');
});

test('update: never in the middle of something; it waits and goes ahead when told that all is quiet', async () => {
  const w = world({ published: V2, held: holding(V1), busy: 'a quiz is running' });
  assert.equal(await w.updater.check(), 'waiting');
  await sleep(20);
  assert.equal(w.reloads, 0);
  assert.equal(w.updater.ready, '1.1.0');
  w.updater.idle();                      // still busy: nothing
  await sleep(20); assert.equal(w.reloads, 0);
  w.busy = '';
  w.updater.idle();
  await sleep(20);
  assert.equal(w.reloads, 1);
  // A quiz that starts in the moment before the reload wins: the update waits again.
  const late = world({ published: V2, held: holding(V1) });
  assert.equal(await late.updater.check(), 'reloading');
  late.busy = 'a quiz is running';
  await sleep(20);
  assert.equal(late.reloads, 0); assert.equal(late.updater.state, 'waiting');
  assert.equal(late.store.get('update'), undefined, 'no reload was made, so none is counted');
});

test('update: a set that does not check out is not loaded', async () => {
  // The list says one thing and the file served is another (a site caught half-way through publishing).
  const w = world({ published: V2, held: holding(V1) });
  const real = w.updater.fetch;
  w.updater.fetch = async (url, init) => url.endsWith('js/game.js') ? new Response('game 1', { status: 200 }) : real(url, init);
  assert.equal(await w.updater.check(), 'failed');
  await sleep(20); assert.equal(w.reloads, 0);
  assert.ok(w.logs.some(l => /could not fetch js\/game\.js: not the published copy/.test(l)));
  // A file that is missing altogether.
  const missing = world({ published: V2, held: holding(V1) });
  const real2 = missing.updater.fetch;
  missing.updater.fetch = async (url, init) => url.endsWith('js/new.js') ? new Response('', { status: 404 }) : real2(url, init);
  assert.equal(await missing.updater.check(), 'failed'); assert.equal(missing.reloads, 0);
  // Published again while the files were being fetched: this set is no longer the latest.
  const moved = world({ published: V2, held: holding(V1), republishAfter: 1 });
  assert.equal(await moved.updater.check(), 'failed'); await sleep(20); assert.equal(moved.reloads, 0);
});

test('update: offline, or with nonsense for an answer, it simply carries on with what it has', async () => {
  const w = world({ published: V2, held: holding(V1), offline: true });
  assert.equal(await w.updater.check(), 'offline');
  assert.equal(w.reloads, 0);
  const odd = world({ published: V2 });
  odd.updater.fetch = async () => new Response('<html>captive portal</html>', { status: 200 });
  assert.equal(await odd.updater.check(), 'offline');
  assert.equal(readVersionInfo({ version: '1', files: { 'js/app.js': 'abc' } }), null);
  assert.equal(readVersionInfo({ version: '1', files: { '../secret': 'a'.repeat(64) } }), null);
  assert.equal(readVersionInfo({ version: '', files: {} }), null);
  assert.deepEqual(readVersionInfo({ version: '1', files: { 'js/app.js': 'a'.repeat(64) } }), { version: '1', files: { 'js/app.js': 'a'.repeat(64) } });
});

test('update: a half-updated copy (new files beside old ones) is noticed and put right', async () => {
  // The page runs 1.1.0, but game.js on this device is still the old one (a slow connection fell back to it).
  const mixed = { ...holding(V2), 'js/game.js': 'game 1' };
  const w = world({ running: '1.1.0', published: V2, held: mixed });
  assert.equal(await w.updater.check('start'), 'reloading');
  await sleep(20);
  assert.deepEqual(w.fetched(), ['js/game.js']);
  assert.equal(w.reloads, 1);
  assert.ok(w.logs.some(l => /1 file\(s\) of 1\.1\.0 on this device are older copies \(js\/game\.js\)/.test(l)));
  // An old copy of a file the page has not loaded yet needs no reload: it is replaced quietly.
  const lazy = world({ running: '1.1.0', published: V2, held: { ...holding(V2), 'vendor/anthropic-sdk.js': 'sdk 0' }, lazy: ['vendor/anthropic-sdk.js'] });
  assert.equal(await lazy.updater.check(), 'current');
  await sleep(20);
  assert.deepEqual(lazy.fetched(), ['vendor/anthropic-sdk.js']); assert.equal(lazy.reloads, 0);
  // The page itself counts too: it is held under the site's address.
  const page = world({ running: '1.1.0', published: V2, held: { ...holding(V2), '(page)': '<p>old</p>' } });
  assert.equal(await page.updater.check(), 'reloading');
  assert.deepEqual(page.fetched(), ['(page)']);
});

test('update: when reloading does not help it stops trying by itself and says so; starting over is one tap', async () => {
  const w = world({ published: V2, held: holding(V1), stored: { to: '1.1.0', n: 2 } });
  assert.equal(await w.updater.check(), 'stuck');
  await sleep(20);
  assert.equal(w.reloads, 0); assert.equal(w.fetched().length, 0);
  assert.deepEqual(w.states, ['stuck']);
  // A different version is a new story.
  const other = world({ published: V2, held: holding(V1), stored: { to: '1.0.5', n: 2 } });
  assert.equal(await other.updater.check(), 'reloading');
  await sleep(20); assert.deepEqual(other.store.get('update'), { to: '1.1.0', n: 1 });
  // Starting over: everything afresh, the count forgotten, one reload.
  await w.updater.force();
  assert.equal(w.reloads, 1); assert.equal(w.store.get('update'), undefined);
  assert.deepEqual(w.fetched(), ['(page)', ...Object.keys(V2).filter(k => k !== 'version' && k !== 'index.html')].sort());
});

test('update: two checks at once are one check', async () => {
  const w = world({ published: V1, held: holding(V1) });
  const [a, b] = await Promise.all([w.updater.check('one'), w.updater.check('two')]);
  assert.equal(a, 'current'); assert.equal(b, 'current');
  assert.equal(w.calls.length, 1);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc').buffer, globalThis.crypto.subtle), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ---- the published list ------------------------------------------------------------------------

test('version.json is up to date with the app (run node tools/stamp-version.mjs after changing the site)', async () => {
  const want = await versionInfo();
  const have = (await readFile(new URL('../docs/version.json', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(have, render(want), 'docs/version.json does not match the files in docs/: run node tools/stamp-version.mjs');
  assert.ok(readVersionInfo(JSON.parse(have)), 'and the page accepts it');
  const files = await appFiles();
  for (const f of ['index.html', 'app.css', 'js/app.js', 'js/update.js', 'js/game.js', 'js/workers/listen-worker.js', 'js/workers/capture-worklet.js', 'vendor/anthropic-sdk.js', 'vendor/qb-answer-checker.js', 'vendor/sherpa/sherpa-onnx-wasm-web.js', 'models/manifest.json']) assert.ok(files.includes(f), f + ' is listed');
  for (const f of ['sw.js', 'version.json']) assert.equal(files.includes(f), false, f + ' is not listed');
  assert.ok(files.every(f => !/\.(wasm|onnx|data|bin)$/.test(f)), 'no model or runtime binaries');
  const app = await readFile(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  assert.equal(want.version, app.match(/const VERSION = '([^']+)'/)[1]);
  assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, want.version, 'package.json carries the same version');
});

// ---- the service worker's part --------------------------------------------------------------------

async function serviceWorker ({ network, cached = {} }) {
  const handlers = {}; const store = new Map(Object.entries(cached));
  const urlOf = req => typeof req === 'string' ? req : req.url;
  const cache = { match: async req => store.has(urlOf(req)) ? new Response(store.get(urlOf(req))) : undefined, put: async (req, res) => { store.set(urlOf(req), await res.text()); }, keys: async () => [...store.keys()].map(url => ({ url })), delete: async req => store.delete(urlOf(req)) };
  const context = vm.createContext({
    self: { addEventListener: (name, fn) => { handlers[name] = fn; }, location: { origin: 'https://example.test' }, skipWaiting () {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    // (its "too slow" timers must not keep the test run alive)
    fetch: network, URL, Promise, Error, Response, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }
  });
  vm.runInContext(await readFile(new URL('../docs/sw.js', import.meta.url), 'utf8'), context);
  const ask = (url, { method = 'GET', cache: mode = 'default', nav = false } = {}) => {
    let answer; const req = { url, method, cache: mode, mode: nav ? 'navigate' : 'cors' };
    handlers.fetch({ request: req, respondWith: p => { answer = p; } });
    return answer;
  };
  const activate = () => { let done; handlers.activate({ waitUntil: p => { done = p; } }); return done; };
  return { ask, store, activate };
}

test('service worker: network first with the last good copy behind it; the version question and fresh fetches are never answered from that copy', async () => {
  let up = true; const asked = [];
  const network = async req => { asked.push(req.url); if (!up) throw new TypeError('offline'); return new Response('fresh ' + req.url.split('/').pop(), { status: 200 }); };
  const sw = await serviceWorker({ network, cached: { 'https://example.test/carbowl/js/app.js': 'old app.js', 'https://example.test/carbowl/': 'old page' } });
  const app = 'https://example.test/carbowl/js/app.js';
  assert.equal(await (await sw.ask(app)).text(), 'fresh app.js');
  await sleep(5);
  assert.equal(sw.store.get(app), 'fresh app.js', 'the copy is renewed');
  assert.equal(sw.ask('https://example.test/carbowl/version.json'), undefined, 'left to the network itself');
  assert.equal(sw.ask('https://example.test/carbowl/version.json?x=1'), undefined);
  assert.equal(sw.ask('https://api.anthropic.com/v1/messages', { method: 'POST' }), undefined, 'not ours to touch');
  assert.equal(sw.ask('https://www.qbreader.org/api/random-tossup'), undefined);
  // The page is kept once, whatever follows the question mark in its address.
  assert.equal(await (await sw.ask('https://example.test/carbowl/?x=1', { nav: true })).text(), 'fresh ?x=1');
  await sleep(5);
  assert.equal(sw.store.get('https://example.test/carbowl/'), 'fresh ?x=1'); assert.equal(sw.store.has('https://example.test/carbowl/?x=1'), false);
  sw.store.set('https://example.test/carbowl/', 'old page');
  up = false;
  assert.equal(await (await sw.ask(app)).text(), 'fresh app.js', 'offline: the last good copy');
  assert.equal(await (await sw.ask('https://example.test/carbowl/?test', { nav: true })).text(), 'old page', 'the page itself too, whatever follows the question mark');
  assert.equal(await (await sw.ask('https://example.test/carbowl/', { nav: true, cache: 'reload' })).text(), 'old page', 'a reload by hand while offline still gets the page');
  await assert.rejects(sw.ask(app, { cache: 'reload' }), /offline/, 'the app updating itself gets the new file or nothing');
  // Taking over from an earlier version: the copies it kept per address, and its kept answer about the version, go.
  sw.store.set('https://example.test/carbowl/?test', 'a copy from last week'); sw.store.set('https://example.test/carbowl/version.json', '{}');
  await sw.activate();
  assert.deepEqual([...sw.store.keys()].sort(), ['https://example.test/carbowl/', app]);
});
