// Shows how text is worded for the voice (reading.js): for texts given on the command line, or
// for every match of a pattern in the sample questions.
// Usage: node tools/exp/say.mjs "Louis XIV built 1,400 rooms"  |  node tools/exp/say.mjs --grep "Oscar II.{0,40}" [--limit 20]
import { speakable } from '../../docs/js/reading.js';
import { cleanForSpeech } from '../../docs/js/speechtext.js';
import { corpus } from './text-diff.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--grep');
const lim = args.indexOf('--limit'); const limit = lim >= 0 ? Number(args[lim + 1]) : 20;
if (at >= 0) {
  const re = new RegExp(args[at + 1], 'g');
  let k = 0;
  for (const raw of corpus().raws) {
    const t = cleanForSpeech(raw).text;
    for (const m of t.match(re) || []) { if (k++ < limit) console.log(`${JSON.stringify(m)}\n   => ${JSON.stringify(speakable(m))}`); }
  }
  console.log(`${k} match(es)`);
} else for (const t of args) { const c = cleanForSpeech(t).text; console.log(`${JSON.stringify(c)}\n   => ${JSON.stringify(speakable(c))}`); }
