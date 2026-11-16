// Shows what the notation rules change, on every fixture question: the raw snippet around each
// place where the spoken text differs from the text with the rules switched off.
// Usage: node tools/exp/notation-check.mjs [fixture files...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notationForSpeech, cleanForSpeech } from '../../docs/js/speechtext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '..', 'test', 'fixtures');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let texts = 0; let changed = 0;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const list = [...(data.tossups || []).map(t => t.question_sanitized), ...(data.bonuses || []).flatMap(b => [b.leadin_sanitized, ...(b.parts_sanitized || [])])].filter(Boolean);
  const seen = new Set();
  for (const raw of list) {
    texts++;
    // Sentence by sentence, so that a change is shown with its surroundings.
    for (const piece of String(raw).split(/(?<=[.?!])\s+/)) {
      const after = notationForSpeech(piece).replace(/\s+/g, ' ');
      const before = piece.replace(/\s+/g, ' ');
      if (after === before) continue;
      changed++;
      // Print only the changed stretch with some context.
      let a = 0; while (a < before.length && before[a] === after[a]) a++;
      let b = 0; while (b < before.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
      const key = before.slice(Math.max(0, a - 12), before.length - b + 12);
      if (seen.has(key)) continue; seen.add(key);
      console.log(`[${f}] …${before.slice(Math.max(0, a - 28), before.length - b + 18)}…\n      -> …${after.slice(Math.max(0, a - 28), after.length - b + 18)}…`);
    }
    cleanForSpeech(raw); // must not throw
  }
}
console.log(`\n${texts} texts, ${changed} sentences changed by the notation rules`);
