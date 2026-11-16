// Samples Math / Computer Science questions from QBReader to see how they are tagged and what
// notation they contain. Usage: node tools/exp/sample-mathcs.mjs [--save]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://www.qbreader.org/api';
const save = process.argv.includes('--save');

async function get (kind, params) {
  const url = `${API}/random-${kind}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
  const data = await res.json();
  return kind === 'tossup' ? data.tossups : data.bonuses;
}

const base = { difficulties: '7,8,9,10', categories: 'Science', subcategories: 'Other Science', minYear: '2010', maxYear: '2026', number: '50' };
const count = (list, key) => { const m = {}; for (const q of list) { const k = q[key] === undefined ? '(untagged)' : q[key]; m[k] = (m[k] || 0) + 1; } return m; };

const narrowed = { ...base, alternateSubcategories: 'Math,Computer Science' };
const tossups = [...await get('tossup', narrowed), ...await get('tossup', narrowed)];
const bonuses = await get('bonus', { ...narrowed, threePartBonuses: 'true' });
const wide = await get('tossup', base);

console.log('tossups asked for Math + Computer Science:', tossups.length, count(tossups, 'alternate_subcategory'));
console.log('bonuses asked for Math + Computer Science:', bonuses.length, count(bonuses, 'alternate_subcategory'));
console.log('tossups with no alternate filter:', wide.length, count(wide, 'alternate_subcategory'));

// Characters outside plain prose, with an example of each.
const odd = new Map();
const texts = [...tossups.map(t => t.question_sanitized + ' || ' + t.answer_sanitized), ...bonuses.flatMap(b => [b.leadin_sanitized, ...b.parts_sanitized, ...b.answers_sanitized])];
for (const t of texts) {
  for (const m of String(t).matchAll(/[^A-Za-z0-9 .,;:'"?!()\[\]\-–—“”‘’/&%$*]/g)) {
    const ch = m[0];
    if (!odd.has(ch)) odd.set(ch, { n: 0, eg: String(t).slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ') });
    odd.get(ch).n++;
  }
}
console.log('\nunusual characters:');
for (const [ch, v] of [...odd].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${JSON.stringify(ch)} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} x${v.n}  …${v.eg}…`);

// Notation patterns worth pronouncing properly.
const patterns = { caret: /\w\^\S+/g, subscript: /\b[a-zA-Z]_\S+/g, bigO: /\bO\([^)]*\)/g, fnCall: /\b[a-zA-Z]\([a-zA-Z0-9, +\-]*\)/g, equals: /\S+ ?= ?\S+/g, slashFrac: /\b\d+\/\d+\b/g, plusMinus: /\S+ ?[+] ?\S+/g, times: /\d ?[x×] ?\d/g, factorial: /\b[a-zA-Z0-9]+!/g, sqrt: /sqrt|√/gi, ndash: /\d[–-]\d/g };
console.log('\nnotation examples:');
for (const [name, re] of Object.entries(patterns)) {
  const hits = [];
  for (const t of texts) for (const m of String(t).matchAll(re)) hits.push(m[0]);
  console.log(`  ${name}: ${hits.length}  ${[...new Set(hits)].slice(0, 14).join(' | ')}`);
}

console.log('\nanswer lines:');
for (const t of tossups.slice(0, 40)) console.log('  ' + t.answer_sanitized.slice(0, 110));

if (save) {
  const dir = path.join(here, '..', '..', 'test', 'fixtures');
  const tagged = q => q.alternate_subcategory === 'Math' || q.alternate_subcategory === 'Computer Science';
  fs.writeFileSync(path.join(dir, 'tossups-mathcs.json'), JSON.stringify({ tossups: tossups.filter(tagged).slice(0, 40) }, null, 1));
  fs.writeFileSync(path.join(dir, 'bonuses-mathcs.json'), JSON.stringify({ bonuses: bonuses.filter(tagged).slice(0, 25) }, null, 1));
  console.log('\nsaved fixtures');
}
