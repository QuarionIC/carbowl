/* Service worker: keeps the app loadable without signal.
 * - The app's own pages, scripts and styles: network first (so updates show up at once), falling
 *   back to the last good copy when the network is slow or absent.
 * - Model and runtime files: served from the model cache the app fills on first run.
 * - Everything else (QBReader, fonts): untouched.
 */
'use strict';
const SHELL = 'carbowl-shell-v1';
const MODELS = 'carbowl-models-v1';
const BIG = /\/models\/|\.(wasm|data|ort|onnx|bin)(\.part\d+)?$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('carbowl-shell-') && name !== SHELL) await caches.delete(name);
  await self.clients.claim();
})()));

async function shellFirstNetwork (request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(request), new Promise((resolve, reject) => setTimeout(() => reject(new Error('slow network')), 5000))]);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
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
  if (BIG.test(url.pathname)) e.respondWith(bigFromCache(req));
  else e.respondWith(shellFirstNetwork(req));
});
