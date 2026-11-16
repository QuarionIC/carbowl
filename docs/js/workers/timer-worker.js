/* Timer worker: waits on behalf of the page, whose own timers are slowed down while it is in the
 * background. Messages in: { id, ms } to start, { cancel: id } to stop. Message out: the id. */
'use strict';
const timers = new Map();
self.onmessage = e => {
  const m = e.data || {};
  if (m.cancel !== undefined) { clearTimeout(timers.get(m.cancel)); timers.delete(m.cancel); return; }
  timers.set(m.id, setTimeout(() => { timers.delete(m.id); self.postMessage(m.id); }, m.ms));
};
