// Timers that keep time while the page is in the background. Browsers slow a hidden page's own
// timers down to about one tick a second (or worse); a worker's timers are left alone, so the
// waiting is done there and the page is only told when the time is up. Where no worker can be
// started (tests, very old browsers) the ordinary timer is used.

let worker = null;
let failed = false;
let nextId = 1;
const pending = new Map(); // id -> { fn, fallback }

function start () {
  if (worker || failed) return worker;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') { failed = true; return null; }
  try {
    worker = new Worker(new URL('./workers/timer-worker.js', import.meta.url), { name: 'carbowl-timers' });
    worker.onmessage = e => fire(e.data);
    worker.onerror = () => { failed = true; worker = null; };
  } catch (e) { failed = true; worker = null; }
  return worker;
}

function fire (id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.fallback) clearTimeout(p.fallback);
  p.fn();
}

/**
 * Calls fn once after ms milliseconds; returns an id for clearTimer.
 * Both the worker and (as a net, should the worker die) the page's own timer are armed: whichever
 * fires first wins, so a timer can be late by the page's throttling at worst, never lost.
 */
export function setTimer (fn, ms) {
  const id = nextId++;
  const delay = Math.max(0, Number(ms) || 0);
  const w = start();
  const entry = { fn, fallback: null };
  pending.set(id, entry);
  if (w) {
    try { w.postMessage({ id, ms: delay }); } catch (e) { /* the fallback below still fires */ }
    entry.fallback = setTimeout(() => fire(id), delay + 1500);
  } else entry.fallback = setTimeout(() => fire(id), delay);
  return id;
}

export function clearTimer (id) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.fallback) clearTimeout(p.fallback);
  if (worker) { try { worker.postMessage({ cancel: id }); } catch (e) { /* gone */ } }
}

/** Resolves after ms milliseconds. */
export function sleep (ms) { return new Promise(resolve => setTimer(resolve, ms)); }

/** True when timing is being done in a worker (for the troubleshooting report). */
export function usingWorkerClock () { start(); return !!worker; }
