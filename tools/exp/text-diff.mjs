// Every difference the current text handling makes, over all the sample questions, so that each
// one can be read and judged before it ships:
//   --clean   texts that are cleaned differently from the released version (what is shown AND said)
//   --asides  every bracketed aside: kept or removed, and how much it sounds like the words before it
//   --say     every place where what is said differs from what is shown (reading.js), grouped by kind
// Usage: node tools/exp/text-diff.mjs --clean|--asides|--say [--old downloads/out/lab/old/speechtext-head.mjs] [--more downloads/out/lab/sample.json] [--limit 400]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanForSpeech, chunkForSpeech, mainAnswer, isReaderNote, echoOfBefore } from '../../docs/js/speechtext.js';
import { speakable } from '../../docs/js/reading.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = name => process.argv.includes('--' + name);
const limit = Number(arg('limit', 400));

export function corpus (more = path.join(root, 'downloads', 'out', 'lab', 'sample.json')) {
  const raws = []; const answers = [];
  const take = j => {
    for (const t of j.tossups || []) { raws.push(t.question_sanitized); answers.push(t.answer_sanitized); }
    for (const b of j.bonuses || []) { raws.push(b.leadin_sanitized || ''); for (const p of b.parts_sanitized || []) raws.push(p); for (const a of b.answers_sanitized || []) answers.push(a); }
  };
  const fx = path.join(root, 'test', 'fixtures');
  for (const f of fs.readdirSync(fx)) take(JSON.parse(fs.readFileSync(path.join(fx, f), 'utf8')));
  if (more && fs.existsSync(more)) take(JSON.parse(fs.readFileSync(more, 'utf8')));
  return { raws: raws.filter(Boolean), answers: answers.filter(Boolean) };
}

/** The part of two strings that differs, with a few characters either side. */
function changed (a, b, pad = 28) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const from = Math.max(0, i - pad);
  return [a.slice(from, Math.min(a.length, a.length - j + pad)), b.slice(from, Math.min(b.length, b.length - j + pad))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { raws, answers } = corpus(arg('more', undefined));
  if (flag('clean')) {
    const old = await import(pathToFileURL(path.resolve(arg('old', path.join(root, 'downloads', 'out', 'lab', 'old', 'speechtext-head.mjs')))).href);
    let n = 0; let power = 0;
    for (const raw of raws) {
      const a = old.cleanForSpeech(raw); const b = cleanForSpeech(raw);
      if (a.powerOffset !== b.powerOffset && a.text === b.text) power++;
      if (a.text === b.text) continue;
      n++;
      if (n <= limit) { const [x, y] = changed(a.text, b.text); console.log(`WAS  …${x}…\nNOW  …${y}…\n`); }
    }
    let ans = 0;
    for (const raw of answers) { const a = old.mainAnswer(raw); const b = mainAnswer(raw); if (a !== b) { ans++; console.log(`ANSWER WAS ${a}\nANSWER NOW ${b}\n`); } }
    console.log(`${n} of ${raws.length} texts are cleaned differently; ${power} more differ only in where the power mark is; ${ans} of ${answers.length} answers differ`);
  }
  if (flag('asides')) {
    const rows = [];
    for (const raw of raws) {
      const t = raw.replace(/[‘’‚‛′ʼʻʹʽʾʿ´]/g, "'").replace(/[“”„‟″«»]/g, '"').replace(/\[\[\s*([^\[\]]{1,160}?)\s*\]\]/g, '[$1]');
      for (const m of t.matchAll(/\s*\(([^()]{1,90})\)/g)) { if (/^\s*[*+$#^~§†‡]{1,3}\s*$/.test(m[1])) continue; const before = t.slice(0, m.index); rows.push({ kind: '(', inner: m[1], before: before.split(/\s+/).slice(-3).join(' '), note: isReaderNote(m[1], false, before), echo: echoOfBefore(m[1].replace(/^["']|["']$/g, ''), before) }); }
      for (const m of t.matchAll(/(\s*)\[([^\[\]]{1,160})\]/g)) { const before = t.slice(0, m.index); rows.push({ kind: '[', inner: m[2], before: before.split(/\s+/).slice(-3).join(' '), note: isReaderNote(m[2], true, before), echo: echoOfBefore(m[2].replace(/^["']|["']$/g, ''), before) }); }
    }
    rows.sort((a, b) => a.echo - b.echo);
    const show = r => `${r.echo.toFixed(2)} ${r.note ? 'removed' : 'KEPT   '} ${r.before} ${r.kind}${r.inner}${r.kind === '(' ? ')' : ']'}`;
    console.log(`${rows.length} asides: ${rows.filter(r => r.note).length} removed, ${rows.filter(r => !r.note).length} kept`);
    console.log('\nKEPT, by how much they sound like what is before them:'); for (const r of rows.filter(r => !r.note)) console.log('  ' + show(r));
    console.log('\nREMOVED, the least alike first:'); for (const r of rows.filter(r => r.note).slice(0, limit)) console.log('  ' + show(r));
  }
  if (flag('say')) {
    const pieces = [];
    for (const raw of raws) for (const c of chunkForSpeech(cleanForSpeech(raw).text)) pieces.push(c.text);
    for (const a of answers) { const m = mainAnswer(a); if (m) pieces.push(`The answer is ${m}.`); }
    const seen = new Map(); let touched = 0;
    for (const p of pieces) {
      const s = speakable(p);
      if (s === p) continue;
      touched++;
      // Word by word, the stretches that differ.
      const a = p.split(' '); const b = s.split(' ');
      const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0; let j = 0;
      while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
        const i0 = i; const j0 = j;
        while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) { if (j >= b.length || (i < a.length && dp[i + 1][j] >= dp[i][j + 1])) i++; else j++; }
        const key = `${a.slice(Math.max(0, i0 - 1), i).join(' ')}  =>  ${b.slice(Math.max(0, j0 - 1), j).join(' ')}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    console.log(`${touched} of ${pieces.length} pieces are said differently from how they are shown; ${seen.size} different rewrites:`);
    for (const [k, v] of [...seen.entries()].sort((x, y) => x[0].localeCompare(y[0])).slice(0, limit)) console.log(`  ${v > 1 ? v + '× ' : ''}${k}`);
  }
}
