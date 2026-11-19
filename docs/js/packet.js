// A question laid out the way a quizbowl packet prints it: its number, the text with the power in
// bold up to the (*) mark, the ANSWER line with what must be said in bold and underlined, and the
// category in angle brackets; a bonus as its lead-in and "[10]" parts, each with its answer. The
// Review screen shows this when a question is opened. Nothing here touches the page: it turns a
// history record into HTML, and finds where in the printed text a buzz came.

import { escapeHtml } from './speechtext.js';

const TAGS = 'b|u|i|em|strong|sub|sup';

/**
 * Text from QBReader made safe to show: everything is escaped, then only plain formatting tags
 * (without attributes) are let back in, and whatever is left open is closed, so that a stray
 * "<b>" cannot turn the rest of the screen bold.
 */
export function safePacketHtml (html) {
  const esc = String(html == null ? '' : html)
    .replace(/&(?!(?:#x?[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const open = [];
  let out = esc.replace(new RegExp(`&lt;(/?)(${TAGS})&gt;`, 'gi'), (m, slash, tag) => {
    const t = tag.toLowerCase();
    if (!slash) { open.push(t); return `<${t}>`; }
    const at = open.lastIndexOf(t);
    if (at < 0) return ''; // closes nothing
    let s = '';
    while (open.length > at) s += `</${open.pop()}>`; // and whatever was left open inside it
    return s;
  });
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/**
 * Safe HTML of a printed line, with the stray spaces QBReader's copy has where the packet changed
 * face ("<u>method</u> ; accept", "<i>Novum Organum</i> .") closed up as the packet has them.
 */
export function printedHtml (html) {
  return safePacketHtml(html).replace(/\s+((?:<\/[a-z]+>)*)([,.;:!?\]])(?=\s|$|<)/g, '$1$2').replace(/\s{2,}/g, ' ').trim();
}

const norm = w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

/** Words of plain text: [{ w, start, end }] (character offsets). */
function textWords (text) {
  const out = []; const re = /\S+/g; let m;
  while ((m = re.exec(String(text || ''))) !== null) { const w = norm(m[0]); if (w) out.push({ w, start: m.index, end: m.index + m[0].length }); }
  return out;
}

/** Words a reader of the HTML sees: [{ w, end }], `end` being the place in the string just after the word. */
function htmlWords (html) {
  const out = []; let cur = ''; let end = 0; let i = 0;
  const flush = () => { const w = norm(cur); if (w) out.push({ w, end }); cur = ''; };
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') { const j = html.indexOf('>', i); if (j < 0) break; i = j + 1; continue; } // a tag is not text and does not end a word
    if (ch === '&') {
      const j = html.indexOf(';', i);
      if (j > i && j - i <= 9) { if (/^&(nbsp|#160|#xa0);$/i.test(html.slice(i, j + 1))) flush(); else end = j + 1; i = j + 1; continue; }
    }
    if (/\s/.test(ch)) { flush(); i++; continue; }
    cur += ch; i++; end = i;
  }
  flush();
  return out;
}

/** For each word of `a`, the word of `b` it lines up with, or -1 (the longest run of words the two share, in order). */
function align (a, b) {
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const to = new Int32Array(n).fill(-1);
  let i = 0; let j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { to[i] = j; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  return to;
}

/**
 * Where in the printed text the reading had got to. What was read aloud is not what is printed
 * (pronunciation guides are left out, "x^2" is said "x squared"), so the two are lined up word by
 * word. Returns the place in `html` just after the word being read at `offset` characters into the
 * spoken text; 0 for "before the first word"; -1 when there was no buzz.
 */
export function buzzPoint (html, spoken, offset) {
  if (offset === null || offset === undefined || !(offset >= 0)) return -1;
  const sw = textWords(spoken); const hw = htmlWords(html);
  if (!hw.length) return -1;
  let k = 0; while (k < sw.length && sw[k].start < offset) k++; // words begun before the buzz
  if (k === 0) return 0;
  if (k >= sw.length) return hw[hw.length - 1].end; // read to the end
  const to = align(sw.map(x => x.w), hw.map(x => x.w));
  let i = k - 1; while (i >= 0 && to[i] < 0) i--;
  if (i < 0) return 0;
  // Words said since the last one that stands in print (a number read out in words, say) move the
  // mark on by as many printed words, but never past the next word that lines up.
  let next = hw.length; for (let x = k; x < sw.length; x++) if (to[x] >= 0) { next = to[x]; break; }
  const j = Math.max(to[i], Math.min(to[i] + (k - 1 - i), next - 1, hw.length - 1));
  return hw[j].end;
}

const markHtml = kind => `<span class="p-buzz${kind ? ' ' + kind : ''}" role="img" aria-label="you buzzed here" title="You buzzed here"></span>`;

/** The spoken text standing in for the printed one (history kept before 0.3.5, when the packet's own text was not stored). */
function fromSpoken (text, powerOffset) {
  const t = String(text || '');
  if (!(powerOffset > 0) || powerOffset >= t.length) return escapeHtml(t);
  return `<b>${escapeHtml(t.slice(0, powerOffset).replace(/\s+$/, ''))} (*)</b> ${escapeHtml(t.slice(powerOffset).replace(/^\s+/, ''))}`;
}

/** "[10]" at the head of a bonus part, which some sets carry in the text itself. */
const stripValue = s => String(s || '').replace(/^\s*\[\s*(?:\d{1,2}\s*[emh]?|[emh])\s*\]\s*/i, '');

function headLine (h) {
  const q = h.q || {};
  const set = (q.set && q.set.name) || h.set || '';
  const p = q.packet;
  let packet = '';
  if (p && (p.name || Number.isFinite(p.number))) {
    // QBReader's packet names are "02", "Editors 2", "15 - Editors 1", "Packet 7": the number is said once.
    let name = String(p.name || '').trim();
    const n = Number.isFinite(p.number) ? p.number : (/^\d+$/.test(name) ? Number(name) : null);
    if (n !== null) name = name.replace(new RegExp(`^(?:(?:packet|round)\\s*)?0*${n}(?![0-9])\\s*[-–—:.,]?\\s*`, 'i'), '');
    packet = n !== null ? `Packet ${n}${name ? ` (${name})` : ''}` : name;
  }
  const bits = [set, packet].filter(Boolean).map(escapeHtml);
  return bits.length ? `<p class="p-head">${bits.join(' · ')}</p>` : '';
}

function tagLine (h) {
  const q = h.q || {};
  const cat = q.category || h.cat || ''; const sub = q.subcategory || h.sub || ''; const alt = q.alternate_subcategory || h.alt || '';
  const label = [sub || cat, alt].filter(Boolean).join(' – ');
  return label ? `<p class="p-tag">&lt;${escapeHtml(label)}&gt;</p>` : '';
}

const numberOf = q => Number.isFinite(q.number) && q.number > 0 ? `${q.number}. ` : '';

/** True when the record holds the text as the packet printed it (and not only what was read aloud). */
export function hasPacketText (h) {
  const q = (h && h.q) || {};
  return h && h.type === 'bonus' ? Array.isArray(q.parts) && q.parts.length > 0 && q.parts.length === (h.parts || []).length : !!q.question;
}

/**
 * One history record as a packet prints it.
 * @returns {{ html: string, buzz: ''|'good'|'bad'|'plain' }} buzz says whether (and how) a buzz is marked in the text
 */
export function packetView (h) {
  const q = h.q || {};
  let body; let buzz = '';
  if (h.type === 'tossup') {
    let text = q.question ? printedHtml(q.question) : fromSpoken(h.text, h.powerOffset);
    const at = h.result && h.result !== 'skipped' && h.result !== 'dead' ? buzzPoint(text, h.text || '', h.buzzOffset) : -1;
    if (at >= 0) {
      buzz = h.result === 'power' || h.result === 'ten' ? 'good' : (h.result === 'neg' || h.result === 'wrong') ? 'bad' : 'plain';
      text = text.slice(0, at) + markHtml(buzz === 'plain' ? '' : buzz) + text.slice(at);
    }
    body = `<p class="p-q">${numberOf(q)}${text}</p><p class="p-ans">ANSWER: ${printedHtml(h.answer || q.answer || '')}</p>`;
  } else {
    const parts = h.parts || [];
    const printed = hasPacketText(h) ? q.parts : null;
    const leadin = q.leadin ? printedHtml(q.leadin) : escapeHtml(h.leadin || '');
    body = `<p class="p-q">${numberOf(q)}${leadin}</p>` + parts.map((p, i) => {
      const value = (Array.isArray(q.values) && Number.isFinite(q.values[i]) && q.values[i]) || 10;
      const mod = (Array.isArray(q.difficultyModifiers) && /^[emh]$/i.test(q.difficultyModifiers[i] || '')) ? q.difficultyModifiers[i].toLowerCase() : '';
      const text = printed ? printedHtml(stripValue(printed[i])) : escapeHtml(p.text || '');
      return `<p class="p-q">[${value}${mod}] ${text}</p><p class="p-ans">ANSWER: ${printedHtml(p.answer || (q.answers && q.answers[i]) || '')}</p>`;
    }).join('');
  }
  return { html: `<div class="packet">${headLine(h)}${body}${tagLine(h)}</div>`, buzz };
}

/** The packet layout with, when a buzz is marked in it, a line under it saying what the mark means. */
export function packetHtml (h) {
  const v = packetView(h);
  const what = { good: ' (right)', bad: ' (wrong)', plain: '' };
  return v.html + (v.buzz ? `<p class="p-key">${markHtml(v.buzz === 'plain' ? '' : v.buzz)}where you buzzed${what[v.buzz]}</p>` : '');
}

/** The part of a QBReader record that the packet layout needs and a history record does not otherwise keep. */
export function packetSource (q) {
  if (!q || typeof q !== 'object') return null;
  const s = {};
  if (typeof q.question === 'string' && q.question) s.question = q.question;
  if (typeof q.leadin === 'string' && q.leadin) s.leadin = q.leadin;
  if (Array.isArray(q.parts) && q.parts.length && q.parts.every(p => typeof p === 'string')) s.parts = q.parts.slice();
  if (Array.isArray(q.values)) s.values = q.values.slice();
  if (Array.isArray(q.difficultyModifiers)) s.mods = q.difficultyModifiers.slice();
  if (Number.isFinite(q.number)) s.number = q.number;
  if (q.packet && (q.packet.name || Number.isFinite(q.packet.number))) s.packet = { name: String(q.packet.name || ''), number: Number.isFinite(q.packet.number) ? q.packet.number : null };
  if (q.set && Number.isFinite(q.set.year)) s.year = q.set.year;
  return Object.keys(s).length ? s : null;
}

/** The other way: what packetSource() kept, as fields of a question object. */
export function sourceFields (s) {
  if (!s || typeof s !== 'object') return {};
  const q = {};
  if (s.question) q.question = s.question;
  if (s.leadin) q.leadin = s.leadin;
  if (Array.isArray(s.parts)) q.parts = s.parts.slice();
  if (Array.isArray(s.values)) q.values = s.values.slice();
  if (Array.isArray(s.mods)) q.difficultyModifiers = s.mods.slice();
  if (Number.isFinite(s.number)) q.number = s.number;
  if (s.packet) q.packet = { name: s.packet.name || '', number: s.packet.number };
  return q;
}

/**
 * Gives a record the printed text of the question fetched for it. Returns true when it now has it.
 * A bonus is only taken when it has as many parts as were asked.
 */
export function applyPacketSource (h, fetched) {
  const s = packetSource(fetched);
  if (!h || !s) return false;
  if (h.type === 'bonus' ? !(s.parts && s.parts.length === (h.parts || []).length) : !s.question) return false;
  const set = { ...((h.q && h.q.set) || { name: h.set || '' }) };
  if (!set.name && fetched.set && fetched.set.name) set.name = fetched.set.name;
  if (s.year) set.year = s.year;
  h.q = { ...(h.q || {}), ...sourceFields(s), set };
  return true;
}
