// Keeps the copy of the app on this device up to date.
//
// A page that stays open (a tab left for days, a phone that never closes Safari) goes on running
// the code it was loaded with, however often the site is updated. So the page itself asks, now and
// then, which version is published (version.json: a version number and a checksum for every file
// of the app). When that is not what is running here, it fetches the files afresh, checks each one
// against its checksum, and only when the whole set is in hand reloads itself, and only at a
// moment when nothing is going on (never during a quiz). The same check catches a half-updated
// copy: new files beside old ones, as a slow connection can leave behind.

export const SHELL_CACHE_PREFIX = 'carbowl-shell-';

export async function sha256Hex (buffer, subtle) {
  const digest = await subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const HEX64 = /^[0-9a-f]{64}$/;
/** version.json as published: { version, files: { path: sha256 } }. Anything else is not trusted. */
export function readVersionInfo (data) {
  if (!data || typeof data.version !== 'string' || !data.version || !data.files || typeof data.files !== 'object') return null;
  const files = {};
  for (const [path, hash] of Object.entries(data.files)) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) return null;
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.includes('..')) return null;
    files[path] = hash;
  }
  return Object.keys(files).length ? { version: data.version, files } : null;
}

export class Updater {
  /**
   * @param {object} o
   * @param {string} o.version the version running in this page
   * @param {string} o.base the site's address, ending in "/"
   * @param {string} [o.page] the address of this page without what follows a question mark (default: base)
   * @param {() => string} [o.busy] a reason not to reload just now ('' when nothing is going on)
   * @param {() => string[]} [o.lazy] files this page has not loaded yet (an old copy of those needs no reload)
   * @param {() => void} o.reload reloads the page
   * @param {(state: string, detail: object) => void} [o.onState] checking | current | offline | failed | waiting | reloading | updated | stuck
   * @param {{ get: Function, set: Function, del: Function }} o.store remembers, for this tab, that a reload was made for an update
   * @param {Function} [o.fetch] @param {CacheStorage} [o.caches] @param {SubtleCrypto} [o.subtle] stand-ins for tests
   */
  constructor ({ version, base, page, busy, lazy, reload, onState, store, log, fetch, caches, subtle, reloadDelayMs = 900, maxReloads = 2, timeoutMs = 20000 }) {
    this.version = version; this.base = base; this.page = page || base;
    this.busy = busy || (() => ''); this.lazy = lazy || (() => []); this.reload = reload; this.onState = onState || (() => {});
    this.store = store; this.log = log || (() => {});
    this.fetch = fetch || ((...a) => globalThis.fetch(...a));
    this.caches = caches === undefined ? (typeof globalThis.caches !== 'undefined' ? globalThis.caches : null) : caches;
    this.subtle = subtle === undefined ? (globalThis.crypto && globalThis.crypto.subtle) || null : subtle;
    this.reloadDelayMs = reloadDelayMs; this.maxReloads = maxReloads; this.timeoutMs = timeoutMs;
    this.state = 'idle'; this.latest = ''; this.ready = ''; this.lastCheck = 0; this._running = null;
  }

  _set (state, detail = {}) { this.state = state; try { this.onState(state, { latest: this.latest, ...detail }); } catch (e) { /* the screen's business */ } return state; }

  /** Looks for a newer (or cleaner) copy and, if there is one, fetches it and reloads when nothing is going on. */
  check (why = '') {
    if (!this._running) this._running = this._check(why).catch(e => { this.log('update: check failed: ' + (e && e.message)); return this._set('failed'); }).finally(() => { this._running = null; });
    return this._running;
  }

  /** Tells the updater that nothing is going on any more: an update that was held back goes ahead. */
  idle () { if (this.ready && this.state === 'waiting') this._apply(); }

  async _check (why) {
    if (this.state === 'reloading') return 'reloading';
    const info = await this._published();
    this.lastCheck = Date.now();
    if (!info) return this._set('offline');
    this.latest = info.version;
    const newer = info.version !== this.version;
    // Which files does this device hold in another form than the published one?
    const held = await this._held(info);
    const lazy = new Set(this.lazy());
    const wrong = Object.keys(info.files).filter(f => held[f] !== undefined && held[f] !== info.files[f]);
    const inUse = wrong.filter(f => !lazy.has(f));
    const tried = (this.store && this.store.get('update')) || {};
    if (!newer && !inUse.length) {
      // Up to date. (Old copies of files not loaded yet are replaced quietly: they would be fetched afresh anyway.)
      if (wrong.length) this._fetchAll(info, wrong).catch(() => {});
      if (tried.to === this.version) { this.store.del('update'); this.log(`update: now running ${this.version}`); return this._set('updated'); }
      return this._set('current');
    }
    this.log(newer ? `update: version ${info.version} is published; this page runs ${this.version} (${why})` : `update: ${inUse.length} file(s) of ${this.version} on this device are older copies (${inUse.slice(0, 4).join(', ')}) (${why})`);
    if (tried.to === info.version && tried.n >= this.maxReloads) {
      // Reloading has not helped: stop trying on our own and say so.
      this.log(`update: still not on ${info.version} after ${tried.n} reloads; leaving it to the listener`);
      return this._set('stuck');
    }
    // Everything not already held in its published form is fetched afresh (a file this device has never held included).
    const need = Object.keys(info.files).filter(f => held[f] !== info.files[f]);
    if (need.length) {
      this._set('checking');
      if (!await this._fetchAll(info, need)) return this._set('failed');
      // The site may have been republished while we were at it: then this set is not the latest after all.
      const again = await this._published();
      if (!again || again.version !== info.version || JSON.stringify(again.files) !== JSON.stringify(info.files)) { this.log('update: the site changed during the download; trying again later'); return this._set('failed'); }
    }
    this.ready = info.version;
    return this._apply();
  }

  _apply () {
    const why = this.busy();
    if (why) { this.log(`update: ${this.ready} is ready; waiting (${why})`); return this._set('waiting', { why }); }
    this.log(`update: reloading into ${this.ready}`);
    this._set('reloading');
    setTimeout(() => {
      // Something may have started in the meantime (a tap on Start): then it waits after all.
      if (this.busy()) { this._set('waiting'); return; }
      const tried = (this.store && this.store.get('update')) || {};
      if (this.store) this.store.set('update', { to: this.ready, n: tried.to === this.ready ? (tried.n || 0) + 1 : 1 });
      this.reload();
    }, this.reloadDelayMs);
    return 'reloading';
  }

  /** The version published right now, or null when it cannot be learned (offline, or nonsense came back). */
  async _published () {
    try {
      const got = await this._get(new URL('version.json', this.base).href, { cache: 'no-store' }, 8000);
      if (!got.ok) return null;
      return readVersionInfo(JSON.parse(new TextDecoder().decode(got.bytes)));
    } catch (e) { return null; }
  }

  /** Fetches a file whole, giving up (headers and body together) after ms. @returns {{ ok: boolean, status: number, bytes: ArrayBuffer }} */
  async _get (url, init, ms) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), ms || this.timeoutMs) : null;
    try {
      const res = await this.fetch(url, { ...init, ...(ac ? { signal: ac.signal } : {}) });
      return { ok: !!res && res.ok, status: res ? res.status : 0, bytes: res && res.ok ? await res.arrayBuffer() : new ArrayBuffer(0) };
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * The checksums of the copies this device holds (in the offline cache the service worker keeps):
   * { path: sha256 }. A file it does not hold, or cannot be asked about, is left out.
   */
  async _held (info) {
    const out = {};
    if (!this.caches || !this.subtle) return out;
    try {
      const names = (await this.caches.keys()).filter(n => n.startsWith(SHELL_CACHE_PREFIX));
      if (!names.length) return out;
      const stores = await Promise.all(names.map(n => this.caches.open(n)));
      await Promise.all(Object.keys(info.files).map(async path => {
        const url = this._url(path);
        for (const c of stores) {
          const hit = await c.match(url);
          if (hit) { out[path] = await sha256Hex(await hit.arrayBuffer(), this.subtle); return; }
        }
      }));
    } catch (e) { this.log('update: could not read the offline copy: ' + (e && e.message)); }
    return out;
  }

  /** Where a file of the list lives. The page itself ("index.html") is the address this page was opened by. */
  _url (path) { return path === 'index.html' ? this.page : new URL(path, this.base).href; }

  /** Fetches files afresh (past every cache) and checks each against its published checksum. */
  async _fetchAll (info, paths) {
    const jobs = paths.map(p => ({ path: p, url: this._url(p) }));
    let failed = '';
    const next = async () => {
      for (;;) {
        const job = jobs.shift();
        if (!job || failed) return;
        try {
          const got = await this._get(job.url, { cache: 'reload' });
          if (!got.ok) throw new Error('HTTP ' + got.status);
          if (this.subtle && await sha256Hex(got.bytes, this.subtle) !== info.files[job.path]) throw new Error('not the published copy');
        } catch (e) { failed = `${job.path}: ${(e && e.message) || e}`; }
      }
    };
    await Promise.all(Array.from({ length: 5 }, next));
    if (failed) { this.log('update: could not fetch ' + failed); return false; }
    this.log(`update: fetched and checked ${paths.length} file(s) of ${info.version}`);
    return true;
  }

  /**
   * For when reloading has not helped: lets go of the service worker and its copies, fetches
   * everything afresh and reloads.
   */
  async force () {
    this.log('update: starting over (offline copy dropped)');
    try {
      if (typeof navigator !== 'undefined' && navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      if (this.caches) for (const n of await this.caches.keys()) if (n.startsWith(SHELL_CACHE_PREFIX)) await this.caches.delete(n);
    } catch (e) { this.log('update: ' + (e && e.message)); }
    const info = await this._published();
    if (info) await this._fetchAll(info, Object.keys(info.files));
    if (this.store) this.store.del('update');
    this.reload();
  }
}
