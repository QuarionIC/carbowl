// What is the reader actually given to say? Runs every fixture question (and, with --more <file>,
// a larger sample saved from QBReader) through the app's own text clean-up and sentence splitting
// and counts the things a voice model can trip over: characters outside the model's alphabet,
// Roman numerals, digits, abbreviations, initials, capitals, symbols, and where long sentences are cut.
// Usage: node tools/exp/text-audit.mjs [--more downloads/out/lab/sample.json] [--show class] [--limit 12]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanForSpeech, chunkForSpeech, splitSentences, mainAnswer } from '../../docs/js/speechtext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const show = arg('show', ''); const limit = Number(arg('limit', 12));

// The model's alphabet: one 32-bit index per code point of the Basic Multilingual Plane, -1 = unknown.
const ixBuf = fs.readFileSync(path.join(root, 'downloads', 'tts-supertonic-int8', 'sherpa-onnx-supertonic-tts-int8-2026-03-06', 'unicode_indexer.bin'));
const indexer = new Int32Array(ixBuf.buffer, ixBuf.byteOffset, ixBuf.length / 4);
const known = cp => cp < indexer.length && indexer[cp] >= 0;
export const alphabet = () => { const out = []; for (let cp = 0; cp < indexer.length; cp++) if (indexer[cp] >= 0) out.push(cp); return out; };

const texts = [];   // { kind, id, text }
const add = (kind, id, raw) => { const t = cleanForSpeech(raw).text; if (t) texts.push({ kind, id, text: t }); };
const fxDir = path.join(root, 'test', 'fixtures');
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const take = (j, tag) => {
  for (const t of j.tossups || []) { add('tossup', tag + ':' + (t._id || ''), t.question_sanitized); texts.push({ kind: 'answer', id: tag, text: mainAnswer(t.answer_sanitized) }); }
  for (const b of j.bonuses || []) {
    add('leadin', tag + ':' + (b._id || ''), b.leadin_sanitized || '');
    (b.parts_sanitized || []).forEach(p => add('part', tag + ':' + (b._id || ''), p));
    (b.answers_sanitized || []).forEach(a => texts.push({ kind: 'answer', id: tag, text: mainAnswer(a) }));
  }
};
for (const f of fs.readdirSync(fxDir)) take(load(path.join(fxDir, f)), f.replace('.json', ''));
const more = arg('more', '');
if (more) take(load(path.resolve(more)), 'more');

const chunks = [];
for (const t of texts) {
  if (t.kind === 'answer') { chunks.push({ ...t, text: t.text, whole: true }); continue; }
  const sentences = splitSentences(t.text);
  const cs = chunkForSpeech(t.text);
  let si = 0;
  for (const c of cs) {
    while (si < sentences.length - 1 && c.start >= sentences[si].start + sentences[si].text.length) si++;
    const s = sentences[si];
    const piece = s && s.text.length > 240;
    const lastOfSentence = !s || c.end >= s.start + s.text.replace(/\s+$/, '').length;
    chunks.push({ kind: t.kind, id: t.id, text: c.text, piece, lastOfSentence });
  }
}

const questionChunks = chunks.filter(c => c.kind !== 'answer');
const lens = questionChunks.map(c => c.text.length).sort((a, b) => a - b);
const q = p => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))];
console.log(`${texts.filter(t => t.kind !== 'answer').length} question texts, ${questionChunks.length} pieces to speak, ${chunks.length - questionChunks.length} answers`);
console.log(`piece length: median ${q(0.5)}, 90% under ${q(0.9)}, longest ${lens[lens.length - 1]}; under 25 characters: ${lens.filter(x => x < 25).length}`);
const pieces = questionChunks.filter(c => c.piece);
const cut = pieces.filter(c => !c.lastOfSentence);
const endOf = c => { const m = /([^A-Za-z0-9\s])?\s*$/.exec(c.text); return /[.!?]["')\]]*$/.test(c.text) ? 'stop' : /,["')\]]*$/.test(c.text) ? 'comma' : /[;:]["')\]]*$/.test(c.text) ? 'semicolon/colon' : 'nothing (' + (m && m[1] ? m[1] : 'word') + ')'; };
const tally = (list, f) => { const m = new Map(); for (const x of list) { const k = f(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
console.log(`pieces that come from a sentence over 240 characters: ${pieces.length} (${(100 * pieces.length / questionChunks.length).toFixed(1)}%); of those, cut mid-sentence: ${cut.length}`);
console.log('  a mid-sentence piece ends in: ' + tally(cut, endOf).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('  all pieces end in: ' + tally(questionChunks, endOf).map(([k, v]) => `${k} ${v}`).join(', '));

// Characters.
const chars = new Map();
for (const c of chunks) for (const ch of c.text) chars.set(ch, (chars.get(ch) || 0) + 1);
const classify = ch => {
  const cp = ch.codePointAt(0);
  if (known(cp)) return 'known';
  const d = ch.normalize('NFKD');
  if (d !== ch && [...d].every(x => known(x.codePointAt(0)))) return 'known after NFKD';
  if (d !== ch && known(d.codePointAt(0))) return 'base known, mark unknown';
  return 'unknown';
};
const byClass = new Map();
for (const [ch, n] of chars) { const k = classify(ch); if (!byClass.has(k)) byClass.set(k, []); byClass.get(k).push([ch, n]); }
const fmt = list => list.sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${ch === ' ' ? 'SPACE' : ch}(U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})×${n}`).join(' ');
for (const k of ['known after NFKD', 'base known, mark unknown', 'unknown']) console.log(`characters ${k}: ${byClass.has(k) ? fmt(byClass.get(k)) : 'none'}`);
const affected = k => chunks.filter(c => [...c.text].some(ch => classify(ch) === k)).length;
console.log(`pieces with a character the model does not know even after NFKD: ${chunks.filter(c => [...c.text].some(ch => { const k = classify(ch); return k === 'unknown' || k === 'base known, mark unknown'; })).length} of ${chunks.length}; needing NFKD: ${affected('known after NFKD')}`);
console.log('model alphabet: ' + alphabet().map(cp => String.fromCodePoint(cp)).join(''));
console.log('combining marks in it: ' + alphabet().filter(cp => cp >= 0x300 && cp < 0x370).map(cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')).join(' '));

// Things read wrongly more often than not by voice models.
const CLASSES = {
  roman: /\b(?=[IVXLCDM]{2,}\b)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\b/g,
  romanAfterName: /\b[A-Z][a-z]+ (?:[IVX]{1,5})\b(?!\.)/g,
  year: /\b(?:1[0-9]{3}|20[0-2][0-9])\b/g,
  decade: /\b[0-9]{2,4}s\b/g,
  ordinal: /\b[0-9]+(?:st|nd|rd|th)\b/g,
  numberWithComma: /\b[0-9]{1,3}(?:,[0-9]{3})+\b/g,
  decimal: /\b[0-9]+\.[0-9]+\b/g,
  otherNumber: /\b[0-9]+\b/g,
  percentMoney: /[$£€¥%]/g,
  abbrevDot: /\b(?:[A-Za-z]{1,5})\.(?= [a-z0-9])/g,
  abbrevDotCap: /\b(?:Mr|Mrs|Ms|Dr|St|Sr|Jr|Prof|Gen|Col|Lt|Sgt|Rev|Fr|Mt|Ft|Op|No|Vol|Ch|Bk|Pt|vs|etc|ca|c|fl|cf|ed|pp|viz|esp)\./g,
  initials: /\b[A-Z]\.(?: ?[A-Z]\.)*(?= [A-Z])/g,
  dotted: /\b(?:[A-Za-z]\.){2,}/g,
  capsWord: /\b[A-Z]{2,}\b/g,
  lettersDigits: /\b[A-Za-z]+[0-9]+[A-Za-z0-9]*\b|\b[0-9]+[A-Za-z]+\b/g,
  slash: /\S*\/\S*/g,
  paren: /\([^)]*\)/g,
  quote: /"[^"]{1,60}"/g,
  colonSemi: /[;:]/g,
  hyphenated: /\b\w+(?:-\w+)+\b/g,
  apostropheS: /\b\w+'s\b/g,
  ellipsis: /\.{3}/g,
  symbols: /[^\sA-Za-z0-9.,;:!?'"()\-À-ɏ]/g
};
const found = {};
for (const [name, re] of Object.entries(CLASSES)) {
  const hits = new Map(); let n = 0; let inPieces = 0;
  for (const c of chunks) { const m = c.text.match(re); if (!m) continue; inPieces++; for (const x of m) { hits.set(x, (hits.get(x) || 0) + 1); n++; } }
  found[name] = { n, inPieces, hits };
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, show === name ? 400 : limit).map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(' | ');
  console.log(`${name}: ${n} in ${inPieces} pieces (${(100 * inPieces / chunks.length).toFixed(1)}%), ${hits.size} different: ${top}`);
}
if (show === 'cuts') for (const c of cut.slice(0, limit)) console.log('CUT ' + JSON.stringify(c.text.slice(-70)) + '  [' + c.text.length + ']');
if (show && CLASSES[show]) { let k = 0; for (const c of chunks) { if (k >= limit) break; if (CLASSES[show].test(c.text)) { console.log('  e.g. ' + c.text); k++; } CLASSES[show].lastIndex = 0; } }
