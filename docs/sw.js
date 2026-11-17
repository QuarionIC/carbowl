/* Service worker: keeps the app loadable without signal.
 * - The app's own pages, scripts and styles: network first (so updates show up at once), falling
 *   back to the last good copy when the network is slow or absent.
 *   The app itself checks which version is published and refreshes these copies as a set (js/update.js).
 * - Model and runtime files: served from the model cache the app fills on first run.
 * - Everything else (QBReader, fonts): untouched.
 */
'use strict';
const SHELL = 'carbowl-shell-v2';
const MODELS = 'carbowl-models-v1';
// Model files live in the model cache; the list of them (manifest.json) is part of the app shell.
const BIG = /\/models\/(?!manifest\.json$)|\.(wasm|data|ort|onnx|bin)(\.part\d+)?$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('carbowl-shell-') && name !== SHELL) await caches.delete(name);
  // Earlier versions kept the page once for every address it was opened by ("/", "/?test", ...), each
  // copy of a different age, and kept the answer to "which version is published". Neither is wanted.
  try {
    const cache = await caches.open(SHELL);
    for (const req of await cache.keys()) { const u = new URL(req.url); if (u.search || /\/version\.json$/.test(u.pathname)) await cache.delete(req); }
  } catch (err) { /* tidying only */ }
  await self.clients.claim();
})()));

// The page is kept once, under its address without whatever follows a question mark.
const keyFor = request => { if (request.mode !== 'navigate') return request; const u = new URL(request.url); return u.origin + u.pathname; };

async function shellFirstNetwork (request) {
  const cache = await caches.open(SHELL);
  const key = keyFor(request);
  // The app fetching itself afresh for an update (see js/update.js) asks for exactly that: it gets
  // more time, and never an older copy in place of the new one.
  const fresh = request.cache === 'reload' && request.mode !== 'navigate';
  try {
    const res = await Promise.race([fetch(request), new Promise((resolve, reject) => setTimeout(() => reject(new Error('slow network')), fresh ? 30000 : 5000))]);
    if (res && res.ok) cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    if (fresh) throw e;
    const hit = await cache.match(key);
    if (hit) return hit;
    return fetch(request);
  }
}

async function bigFromCache (request) {
  const cache = await caches.open(MODELS);
  const hit = await cache.match(request.url);
  return hit || fetch(request);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Which version is published is always asked of the network itself: an old answer is worse than none.
  if (/\/version\.json$/.test(url.pathname)) return;
  if (BIG.test(url.pathname)) e.respondWith(bigFromCache(req));
  else e.respondWith(shellFirstNetwork(req));
});
