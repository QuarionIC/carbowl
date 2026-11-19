// Everything that was asked, kept across sessions for review. Records live in IndexedDB (a long
// history outgrows localStorage's few megabytes); a plain in-memory store stands in where
// IndexedDB is missing (private browsing, tests).

import { packetSource, sourceFields } from './packet.js';

const DB_NAME = 'carbowl';
const STORE = 'history';
/** A session that was last used this recently is carried on after a reload instead of starting a new one. */
export const RESUME_WINDOW_MS = 6 * 3600 * 1000;

/** The part of a game record worth keeping: plain data, no references to live objects. */
export function slimRecord (h, session) {
  const q = h.q || {};
  const base = {
    key: `${h.at || 0}-${h.id}`,
    session: session || h.session || 0,
    id: h.id, type: h.type, at: h.at || 0,
    result: h.result === undefined ? null : h.result, points: h.points || 0,
    set: (q.set && q.set.name) || h.set || '', cat: q.category || h.cat || '', sub: q.subcategory || h.sub || '',
    alt: q.alternate_subcategory || h.alt || '', difficulty: q.difficulty === undefined ? (h.difficulty === undefined ? null : h.difficulty) : q.difficulty
  };
  if (h.overridden) base.overridden = true;
  // The text as the packet printed it (formatting, pronunciation guides, its number and packet),
  // so that Review can show the question as it stood on the page and not only as it was read.
  const src = packetSource(q);
  if (src) base.src = src;
  if (h.type === 'tossup') {
    return { ...base, text: h.text || '', answer: h.answer || '', answerText: h.answerText || '', heard: h.heard || '', buzzOffset: h.buzzOffset === undefined ? null : h.buzzOffset, powerOffset: h.powerOffset === undefined ? -1 : h.powerOffset };
  }
  return { ...base, leadin: h.leadin || '', parts: (h.parts || []).map(p => ({ text: p.text || '', answer: p.answer || '', answerText: p.answerText || '', result: p.result === undefined ? null : p.result, points: p.points || 0, heard: p.heard || '', ...(p.overridden ? { overridden: true } : {}) })) };
}

/** A stored record in the shape the game and the review screen work with. */
export function expandRecord (r) {
  const src = r.src || null;
  const set = { name: r.set || '' };
  if (src && Number.isFinite(src.year)) set.year = src.year;
  return { ...r, parts: r.parts || [], q: { ...sourceFields(src), set, category: r.cat || '', subcategory: r.sub || '', alternate_subcategory: r.alt || undefined, difficulty: r.difficulty === null ? undefined : r.difficulty } };
}

const isRecord = r => !!(r && (r.type === 'tossup' || r.type === 'bonus') && r.key);

export class MemoryBackend {
  constructor () { this.map = new Map(); }
  async open () { return true; }
  async put (r) { this.map.set(r.key, JSON.parse(JSON.stringify(r))); }
  async all () { return [...this.map.values()].map(r => JSON.parse(JSON.stringify(r))); }
  async deleteWhere (pred) { for (const [k, r] of this.map) if (pred(r)) this.map.delete(k); }
  async clear () { this.map.clear(); }
}

const wrap = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error || new Error('storage request failed')); });

export class IdbBackend {
  constructor (idb) { this.idb = idb; this.db = null; }
  open () {
    return new Promise((resolve, reject) => {
      let req;
      try { req = this.idb.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) { const os = db.createObjectStore(STORE, { keyPath: 'key' }); os.createIndex('session', 'session'); os.createIndex('at', 'at'); }
      };
      req.onsuccess = () => { this.db = req.result; this.db.onversionchange = () => { try { this.db.close(); } catch (e) { /* closing */ } }; resolve(true); };
      req.onerror = () => reject(req.error || new Error('could not open storage'));
      req.onblocked = () => reject(new Error('storage is busy in another tab'));
    });
  }
  _store (mode) { return this.db.transaction(STORE, mode).objectStore(STORE); }
  async put (r) { await wrap(this._store('readwrite').put(r)); }
  async all () { return wrap(this._store('readonly').getAll()); }
  async deleteWhere (pred) {
    const os = this._store('readwrite');
    const keys = (await wrap(os.getAll())).filter(pred).map(r => r.key);
    await Promise.all(keys.map(k => wrap(os.delete(k))));
  }
  async clear () { await wrap(this._store('readwrite').clear()); }
}

export class HistoryStore {
  /** @param {{ backend?: object, log?: Function }} [o] backend defaults to IndexedDB, or memory when that is unavailable */
  constructor ({ backend, log } = {}) {
    this.log = log || (() => {});
    this.backend = backend || null;
    this.persistent = false;
    this.ready = null;
    this.chain = Promise.resolve();
  }

  open () {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.backend) {
        const idb = typeof indexedDB !== 'undefined' ? indexedDB : null;
        if (idb) {
          const b = new IdbBackend(idb);
          try { await b.open(); this.backend = b; this.persistent = true; } catch (e) { this.log('history: no lasting storage (' + (e && e.message) + '); this session only'); }
        }
        if (!this.backend) this.backend = new MemoryBackend();
      } else { await this.backend.open(); this.persistent = !(this.backend instanceof MemoryBackend); }
      return this;
    })();
    return this.ready;
  }

  /** Writes one after another, in order, and never throws: losing a history line must not stop a quiz. */
  _queue (fn) {
    this.chain = this.chain.then(() => this.open()).then(fn).catch(e => { this.log('history: ' + (e && e.message ? e.message : e)); });
    return this.chain;
  }

  /** Adds a finished question, or replaces it after a verdict was overruled. */
  save (rec, session) { const slim = slimRecord(rec, session); return this._queue(() => this.backend.put(slim)); }

  /** Every record, oldest first. */
  async all () {
    await this.open(); await this.chain;
    try { return (await this.backend.all()).filter(isRecord).sort((a, b) => (a.at - b.at) || (a.key < b.key ? -1 : 1)); } catch (e) { this.log('history: could not read (' + (e && e.message) + ')'); return []; }
  }

  removeSession (session) { return this._queue(() => this.backend.deleteWhere(r => r.session === session)); }
  clear () { return this._queue(() => this.backend.clear()); }
}

/** Score of a list of records, in the same terms as the scoreboard. */
export function scoreOf (items) {
  const s = { tossups: 0, powers: 0, tens: 0, negs: 0, tossupPoints: 0, bonuses: 0, bonusPoints: 0, bonusParts: 0, bonusCorrect: 0 };
  for (const h of items || []) {
    if (!h || h.result === 'skipped') continue;
    if (h.type === 'tossup') {
      s.tossups++; s.tossupPoints += h.points || 0;
      if (h.result === 'power') s.powers++; else if (h.result === 'ten') s.tens++; else if (h.result === 'neg') s.negs++;
    } else if (h.type === 'bonus') {
      const parts = h.parts || [];
      s.bonuses++; s.bonusPoints += h.points || 0; s.bonusParts += parts.length; s.bonusCorrect += parts.filter(p => p.result === 'correct').length;
    }
  }
  s.points = s.tossupPoints + s.bonusPoints;
  s.ppb = s.bonuses ? s.bonusPoints / s.bonuses : 0;
  return s;
}

/** Groups records into sessions, newest session first; items inside a session stay in the order asked. */
export function groupSessions (records) {
  const by = new Map();
  for (const r of records || []) {
    if (!isRecord(r)) continue;
    const id = r.session || 0;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(r);
  }
  const out = [];
  for (const [session, items] of by) {
    items.sort((a, b) => a.at - b.at);
    out.push({ session, start: items[0].at || session, end: items[items.length - 1].at || session, items, score: scoreOf(items) });
  }
  return out.sort((a, b) => b.end - a.end);
}

/** The session to carry on with after a reload: the newest one, if it was in use recently. */
export function resumableSession (records, now = Date.now()) {
  const groups = groupSessions(records);
  if (!groups.length || !groups[0].session || now - groups[0].end > RESUME_WINDOW_MS) return null;
  return groups[0];
}

const strip = s => String(s == null ? '' : s).replace(/<[^>]*>/g, '');
const wasMissedTossup = h => h.type === 'tossup' && h.result !== 'power' && h.result !== 'ten';

/** Plain text of the questions that were not answered correctly, for copying into notes or flashcards. */
export function missedLines (items) {
  const lines = [];
  for (const h of items || []) {
    if (wasMissedTossup(h)) lines.push(`TOSSUP: ${h.text}\nANSWER: ${strip(h.answer)}\n`);
    if (h.type === 'bonus') (h.parts || []).forEach(p => { if (p.result !== 'correct' && (p.result || h.result === 'skipped')) lines.push(`BONUS PART: ${p.text}\nANSWER: ${strip(p.answer)}\n`); });
  }
  return lines;
}

/** Counts by category, most asked first: [{ cat, asked, right }]. A bonus counts once per part. */
export function byCategory (items) {
  const m = new Map();
  const bump = (cat, right) => { const k = cat || 'Other'; const v = m.get(k) || { cat: k, asked: 0, right: 0 }; v.asked++; if (right) v.right++; m.set(k, v); };
  for (const h of items || []) {
    if (!h || h.result === 'skipped') continue;
    const cat = h.alt || h.sub || h.cat;
    if (h.type === 'tossup') bump(cat, h.result === 'power' || h.result === 'ten');
    else for (const p of h.parts || []) if (p.result) bump(cat, p.result === 'correct');
  }
  return [...m.values()].sort((a, b) => b.asked - a.asked);
}
