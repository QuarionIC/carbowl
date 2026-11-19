// Adds up the parts written by say-confirm.cjs: for each kind of rewrite, how many words of the
// intended reading were not heard when the sentence was spoken as written and as rewritten, the
// paired difference per take with its standard error, and the takes that came out better or worse.
// The scoring is redone here from the stored transcripts, so that it can be refined without
// speaking everything again: numbers and abbreviations in both the intended reading and the
// transcript are put in one form first (the recogniser writes "Charles II" for a spoken "Charles
// the second", "o" for "oh", "%" for "percent").
// Usage: node tools/exp/say-confirm-report.mjs [--name say-confirm] [--worse] [--each]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakable } from '../../docs/js/reading.js';
import { wordsOf } from '../../docs/js/speechtext.js';
import { canonNumbers } from '../../docs/js/numbers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '..', 'downloads', 'out', 'lab');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const names = String(arg('name', 'say-confirm')).split(',');
let rows = [];
for (const n of names) for (const f of fs.readdirSync(dir)) if (new RegExp(`^${n}-\\d+of\\d+\\.json$`).test(f)) rows.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rows);
// The same sentence may be in two runs: the run named first is the one kept.
{ const seen = new Set(); rows = rows.filter(r => { if (seen.has(r.written)) return false; seen.add(r.written); return true; }); }
// --current: only the sentences that reading.js, as it is now, still rewrites in the way that was spoken
// (a rule dropped or narrowed after a run leaves its sentences as written: nothing to compare).
if (process.argv.includes('--current')) { const all = rows.length; rows = rows.filter(r => speakable(r.written) === r.said); console.log(`${all - rows.length} of ${all} sentences are no longer rewritten as they were spoken, and are left out`); }
if (arg('kinds', '')) { const want = arg('kinds').split(','); rows = rows.filter(r => want.includes(r.kind)); }
if (arg('not', '')) { const drop = arg('not').split(','); rows = rows.filter(r => !drop.includes(r.kind)); }

const UNIT = '(?:one|two|three|four|five|six|seven|eight|nine)';
// What the recogniser writes for a letter it heard named.
const LETTER = { jay: 'j', kay: 'k', dee: 'd', gee: 'g', pee: 'p', tee: 't', vee: 'v', zee: 'z', ess: 's', eff: 'f', aitch: 'h', cue: 'q', ex: 'x', el: 'l', em: 'm', en: 'n' };
const canon = text => {
  const words = wordsOf(canonNumbers(speakable(String(text))
    // "7,000" and "three thousand, three hundred": the commas are the recogniser's, not the voice's.
    .replace(/(\d),(?=\d{3})/g, '$1').replace(/,/g, ' ')
    .replace(/%/g, ' percent ').replace(/-/g, ' ')
    .replace(new RegExp(`\\b([a-z]+teen|ten|eleven|twelve)\\s+o\\s+(${UNIT})\\b`, 'gi'), '$1 oh $2')
    .replace(/\bsaint\b/gi, 'st').replace(/\bmister\b/gi, 'mr').replace(/\bmissus\b/gi, 'mrs').replace(/\bdoctor\b/gi, 'dr').replace(/\bmount\b/gi, 'mt').replace(/\bversus\b/gi, 'vs').replace(/\bnumber\b/gi, 'no').replace(/\bjunior\b/gi, 'jr')))
    .map(w => LETTER[w] || w);
  // Initials are heard as "W. K.", "W K" or "Wk": letters standing alone are run together.
  const out = [];
  for (const w of words) { if (/^[a-z]$/.test(w) && out.length && /^[a-z]{1,3}$/.test(out[out.length - 1]) && out[out.length - 1].single) { const j = new String(out[out.length - 1] + w); j.single = true; out[out.length - 1] = j; } else { const s = new String(w); s.single = /^[a-z]$/.test(w); out.push(s); } }
  return out.map(String);
};
function wer (a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// A finer kind for numbers, which hold four different rewrites.
const fine = r => {
  if (r.kind !== 'numbers') return r.kind;
  if (/\b1[1-9]0[1-9]\b/.test(r.written) && !/\d[.,]\d/.test(r.written)) return 'numbers: year';
  if (/\d\.\d/.test(r.written)) return 'numbers: decimal';
  if (/\b\d{1,3}(,000)+\b/.test(r.written) && !/\b\d{1,3},(?!000)\d{3}\b/.test(r.written)) return 'numbers: round';
  return 'numbers: other';
};
for (const r of rows) {
  const ref = canon(r.said); r.words = ref.length; r.fine = fine(r);
  for (const t of r.takes) { t.written.e = wer(ref, canon(t.written.heard)); t.said.e = wer(ref, canon(t.said.heard)); }
}
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const se = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1) / a.length) : 0; };
const line = (label, list) => {
  const takes = list.flatMap(r => r.takes.map(t => ({ ...t, words: r.words })));
  const words = takes.reduce((s, t) => s + t.words, 0);
  const ew = takes.reduce((s, t) => s + t.written.e, 0); const es = takes.reduce((s, t) => s + t.said.e, 0);
  const diff = takes.map(t => (t.said.e - t.written.e) / Math.max(1, t.words));
  const better = takes.filter(t => t.said.e < t.written.e).length; const worse = takes.filter(t => t.said.e > t.written.e).length;
  console.log(`${label.padEnd(17)} ${String(list.length).padStart(3)} sentences, ${String(takes.length).padStart(3)} takes, ${String(words).padStart(5)} words | not heard: as written ${(100 * ew / Math.max(1, words)).toFixed(1).padStart(5)}% (${ew}), rewritten ${(100 * es / Math.max(1, words)).toFixed(1).padStart(5)}% (${es}) | per take ${(100 * mean(diff)).toFixed(1).padStart(6)} points (s.e. ${(100 * se(diff)).toFixed(1)}) | better ${better}, worse ${worse}, same ${takes.length - better - worse} | length ${mean(takes.map(t => t.written.sec)).toFixed(2)} s -> ${mean(takes.map(t => t.said.sec)).toFixed(2)} s`);
};
for (const k of [...new Set(rows.map(r => r.fine))].sort()) line(k, rows.filter(r => r.fine === k));
line('ALL', rows);
if (process.argv.includes('--each')) for (const r of rows) console.log(`[${r.fine}] ${r.takes.map(t => t.written.e).join(' ')} -> ${r.takes.map(t => t.said.e).join(' ')} of ${r.words} | ${r.written.slice(0, 110)}`);
if (process.argv.includes('--worse')) {
  for (const r of rows) for (const t of r.takes) if (t.said.e > t.written.e) console.log(`\n[${r.fine}] seed ${t.seed}: ${t.written.e} -> ${t.said.e} of ${r.words}\n  written: ${r.written}\n  heard:   ${t.written.heard}\n  said:    ${r.said}\n  heard:   ${t.said.heard}`);
}
