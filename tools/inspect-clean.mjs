// Development aid: shows what cleanForSpeech removes or keeps on real QBReader text.
// Usage: node tools/inspect-clean.mjs [--samples N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanForSpeech, chunkForSpeech, isReaderNote, mainAnswer } from '../docs/js/speechtext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => JSON.parse(fs.readFileSync(path.join(here, '..', 'test', 'fixtures', f), 'utf8'));
const tossups = [...fx('tossups-philosophy.json').tossups, ...fx('tossups-mixed.json').tossups];
const bonuses = [...fx('bonuses-philosophy.json').bonuses, ...fx('bonuses-mixed.json').bonuses];
const texts = [
  ...tossups.map(t => t.question_sanitized),
  ...bonuses.flatMap(b => [b.leadin_sanitized, ...b.parts_sanitized])
];

const removed = new Map(); const kept = new Map();
for (const t of texts) {
  for (const m of String(t).matchAll(/\(([^()]{1,90})\)|\[([^\[\]]{1,160})\]/g)) {
    const inner = m[1] !== undefined ? m[1] : m[2];
    const kind = m[1] !== undefined ? '()' : '[]';
    if (/^\s*[*+]\s*$/.test(inner)) continue;
    const bucket = isReaderNote(inner, kind === '[]') ? removed : kept;
    const key = kind[0] + inner + kind[1];
    bucket.set(key, (bucket.get(key) || 0) + 1);
  }
}
console.log(`=== ${texts.length} texts; REMOVED as reader notes (${removed.size} distinct) ===`);
console.log([...removed.keys()].join('  |  '));
console.log(`\n=== KEPT (${kept.size} distinct) ===`);
console.log([...kept.keys()].join('  |  '));

let maxChunk = 0; let totalChunks = 0; const lens = [];
let powerCount = 0;
for (const t of tossups) {
  const { text, powerOffset } = cleanForSpeech(t.question_sanitized);
  if (powerOffset >= 0) powerCount++;
  const chunks = chunkForSpeech(text);
  totalChunks += chunks.length;
  for (const c of chunks) { lens.push(c.text.length); maxChunk = Math.max(maxChunk, c.text.length); }
  if (/[\u0001]/.test(text)) console.log('SENTINEL LEFT IN TEXT', t._id);
  if (chunks.map(c => c.text).join(' ').replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ')) console.log('CHUNKS DO NOT REASSEMBLE', t._id);
}
lens.sort((a, b) => a - b);
console.log(`\n=== chunks: ${totalChunks} over ${tossups.length} tossups; median ${lens[lens.length >> 1]} chars, p95 ${lens[Math.floor(lens.length * 0.95)]}, max ${maxChunk}; with power mark: ${powerCount} ===`);

const n = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 3;
for (const t of tossups.slice(0, n)) {
  const { text, powerOffset } = cleanForSpeech(t.question_sanitized);
  console.log('\n--- RAW:   ' + t.question_sanitized);
  console.log('--- CLEAN: ' + (powerOffset >= 0 ? text.slice(0, powerOffset) + '<<POWER>>' + text.slice(powerOffset) : text));
  console.log('--- CHUNKS: ' + chunkForSpeech(text).map(c => `[${c.start}] ${c.text}`).join('\n            '));
  console.log('--- ANSWER: ' + t.answer_sanitized + '   =>   SAY: ' + mainAnswer(t.answer_sanitized));
}
console.log('\n=== spoken answers (sample) ===');
for (const b of bonuses.slice(0, 12)) for (const a of b.answers_sanitized) console.log('  ' + mainAnswer(a) + '      <=  ' + a);
