// Saves a wider sample of questions from QBReader (every category, a spread of difficulties) for
// the text and voice experiments. Usage: node tools/exp/sample-questions.mjs [--tossups 400] [--bonuses 200] [--out downloads/out/lab/sample.json] [--difficulties 3,4,5,6,7,8,9,10]
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://www.qbreader.org/api';
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const wantT = Number(arg('tossups', 400)); const wantB = Number(arg('bonuses', 200));
const out = path.resolve(arg('out', 'downloads/out/lab/sample.json'));
const difficulties = arg('difficulties', '3,4,5,6,7,8,9,10');

async function get (kind, params) {
  const res = await fetch(`${API}/random-${kind}?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
  const data = await res.json();
  return kind === 'tossup' ? data.tossups : data.bonuses;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = { difficulties, minYear: '2010', maxYear: '2026', number: '50' };
const seen = new Set(); const tossups = []; const bonuses = [];
for (let tries = 0; tossups.length < wantT && tries < 20; tries++) { for (const t of await get('tossup', base)) if (!seen.has(t._id) && tossups.length < wantT) { seen.add(t._id); tossups.push(t); } await sleep(400); }
for (let tries = 0; bonuses.length < wantB && tries < 20; tries++) { for (const b of await get('bonus', { ...base, threePartBonuses: 'true' })) if (!seen.has(b._id) && bonuses.length < wantB) { seen.add(b._id); bonuses.push(b); } await sleep(400); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), difficulties, tossups, bonuses }));
const cats = {}; for (const q of [...tossups, ...bonuses]) cats[q.category] = (cats[q.category] || 0) + 1;
console.log(`saved ${tossups.length} tossups and ${bonuses.length} bonuses to ${out}`);
console.log(Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
