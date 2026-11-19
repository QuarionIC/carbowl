// Adds up the parts written by steps-paired.cjs: for each quality setting, the share of words a
// recogniser did not hear, the difference from the standard setting take by take (same sentence,
// same seed) with its standard error, the two roughness measures, and how long the speech took to make.
// The scoring is redone from the stored transcripts with the same levelling of the recogniser's
// spelling as say-confirm-report.mjs.
// Usage: node tools/exp/steps-paired-report.mjs [--name steps-paired] [--base 5]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakable } from '../../docs/js/reading.js';
import { wordsOf } from '../../docs/js/speechtext.js';
import { canonNumbers } from '../../docs/js/numbers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '..', 'downloads', 'out', 'lab');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const name = arg('name', 'steps-paired'); const base = String(arg('base', 5));
const rows = []; let stepList = [];
for (const f of fs.readdirSync(dir)) if (new RegExp(`^${name}-\\d+of\\d+\\.json$`).test(f)) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); rows.push(...j.rows); stepList = j.stepList; }
const LETTER = { jay: 'j', kay: 'k', dee: 'd', gee: 'g', pee: 'p', tee: 't', vee: 'v', zee: 'z', ess: 's', eff: 'f', aitch: 'h', cue: 'q', ex: 'x', el: 'l', em: 'm', en: 'n' };
const canon = text => wordsOf(canonNumbers(speakable(String(text)).replace(/(\d),(?=\d{3})/g, '$1').replace(/,/g, ' ').replace(/%/g, ' percent ').replace(/-/g, ' ')
  .replace(/\bsaint\b/gi, 'st').replace(/\bmister\b/gi, 'mr').replace(/\bmissus\b/gi, 'mrs').replace(/\bdoctor\b/gi, 'dr').replace(/\bmount\b/gi, 'mt').replace(/\bversus\b/gi, 'vs').replace(/\bnumber\b/gi, 'no'))).map(w => LETTER[w] || w);
function wer (a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const se = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1) / a.length) : 0; };
const takes = [];
for (const r of rows) { const ref = canon(r.text); for (const t of r.takes) { const o = { words: ref.length }; for (const s of stepList) o[s] = { ...t[s], e: wer(ref, canon(t[s].heard)) }; takes.push(o); } }
console.log(`${rows.length} sentences, ${takes.length} takes at each of ${stepList.length} settings`);
for (const s of stepList) {
  const words = takes.reduce((a, t) => a + t.words, 0); const errors = takes.reduce((a, t) => a + t[s].e, 0);
  const diff = takes.map(t => (t[s].e - t[base].e) / Math.max(1, t.words));
  const better = takes.filter(t => t[s].e < t[base].e).length; const worse = takes.filter(t => t[s].e > t[base].e).length;
  const dh = takes.map(t => t[s].hnr - t[base].hnr); const dc = takes.map(t => t[s].cpp - t[base].cpp);
  const factor = takes.reduce((a, t) => a + t[s].ms, 0) / takes.reduce((a, t) => a + t[s].sec * 1000, 0);
  console.log(`quality ${String(s).padStart(2)}: words not heard ${(100 * errors / words).toFixed(1)}% (${errors} of ${words})` +
    (String(s) === base ? ' (the standard)' : ` | against ${base}, per take ${(100 * mean(diff)).toFixed(2)} points (s.e. ${(100 * se(diff)).toFixed(2)}), better ${better}, worse ${worse}, same ${takes.length - better - worse}`) +
    ` | HNR ${mean(takes.map(t => t[s].hnr)).toFixed(2)} dB${String(s) === base ? '' : ` (${mean(dh) >= 0 ? '+' : ''}${mean(dh).toFixed(2)}, s.e. ${se(dh).toFixed(2)})`}, CPP ${mean(takes.map(t => t[s].cpp)).toFixed(2)} dB${String(s) === base ? '' : ` (${mean(dc) >= 0 ? '+' : ''}${mean(dc).toFixed(2)}, s.e. ${se(dc).toFixed(2)})`} | made in ${factor.toFixed(2)} of its length`);
}
