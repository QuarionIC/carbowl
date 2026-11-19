// Does wording the text for the voice (docs/js/reading.js) make it come out better? Every piece of
// the sample questions that reading.js rewrites is a candidate; a fixed selection of them, grouped
// by the kind of rewrite, is spoken both ways (as written, and as rewritten) with the same seeds,
// played to a recogniser, and both transcripts are scored against the intended reading: the share
// of its words that were not heard (word error rate, after numbers and abbreviations in both are
// put in one form). Pieces that reading.js does not touch reach the voice unchanged, so they
// cannot come out differently and are not tested.
// Usage: node tools/exp/say-confirm.cjs [--per 14] [--seeds 2] [--kind numbers] [--part 0/6] [--out say-confirm] [--list]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe } = require('./models.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = name => process.argv.includes('--' + name);

function wer (ref, hyp) {
  const a = ref; const b = hyp;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], words: a.length };
}

(async () => {
  const per = Number(arg('per', 14)); const seeds = Number(arg('seeds', 2)); const [part, parts] = String(arg('part', '0/1')).split('/').map(Number);
  const reading = await import('../../docs/js/reading.js');
  const st = await import('../../docs/js/speechtext.js');
  const num = await import('../../docs/js/numbers.js');
  const Dsp = await import('../../docs/js/dsp.js');
  const { corpus } = await import('./text-diff.mjs');
  const { raws, answers } = corpus();
  const pieces = [];
  for (const raw of raws) for (const c of st.chunkForSpeech(st.cleanForSpeech(raw).text)) pieces.push(c.text);
  for (const a of answers) { const m = st.mainAnswer(a); if (m) pieces.push(`The answer is ${m}.`); }
  // The kind of a rewrite: the first step of reading.js that changes the piece (accents and odd
  // letters first, then the rest in the order they are applied). A slash turned into a space is
  // what the runtime does anyway, so a piece changed in no other way is not a candidate.
  const kindOf = text => {
    const base = reading.STAGES.characters(text);
    if (base.replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ')) return 'letters';
    for (const k of ['romanNumerals', 'numbers', 'abbreviations', 'initials', 'quotes']) if (reading.STAGES[k](base) !== base) return k;
    return null;
  };
  const byKind = {};
  const seen = new Set();
  for (const p of pieces) {
    if (seen.has(p)) continue; seen.add(p);
    const said = reading.speakable(p);
    if (said === p) continue;
    const k = kindOf(p);
    if (!k) continue;
    (byKind[k] = byKind[k] || []).push({ written: p, said, kind: k });
  }
  const chosen = [];
  const only = arg('kind', '');
  for (const [k, list] of Object.entries(byKind)) {
    if (only && k !== only) continue;
    // Spread over the list, shortest pieces left out (a one-word answer says little about a sentence).
    const usable = list.filter(x => x.written.length >= 24);
    const step = Math.max(1, usable.length / per);
    for (let i = 0; i < per && Math.floor(i * step) < usable.length; i++) chosen.push(usable[Math.floor(i * step)]);
    console.log(`${k}: ${list.length} pieces rewritten, ${Math.min(per, usable.length)} taken`);
  }
  if (flag('list')) { for (const c of chosen) console.log(`[${c.kind}] ${c.written}\n      => ${c.said}`); return; }
  const canon = text => st.wordsOf(num.canonNumbers(reading.speakable(String(text)).replace(/-/g, ' ')));
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid: 5, speed: 1, steps: 3 });
  const rows = [];
  for (let i = 0; i < chosen.length; i++) {
    if (i % parts !== part) continue;
    const c = chosen[i];
    const ref = canon(c.said);
    const row = { kind: c.kind, written: c.written, said: c.said, takes: [] };
    for (let k = 0; k < seeds; k++) {
      const one = text => {
        const raw = speak(tts, text, { sid: 5, speed: 1.3, steps: 5, seed: 500 + k });
        const clip = Dsp.finishClip(raw.samples.slice(), raw.sampleRate, {});
        const heard = hear(clip.samples, raw.sampleRate);
        const w = wer(ref, canon(heard));
        return { heard, sec: +(clip.samples.length / raw.sampleRate).toFixed(2), errors: w.errors, words: w.words };
      };
      row.takes.push({ seed: 500 + k, written: one(c.written), said: one(c.said) });
    }
    rows.push(row);
    const e = side => row.takes.map(t => `${t[side].errors}/${t[side].words}`).join(' ');
    console.log(`[${c.kind}] as written ${e('written')} | rewritten ${e('said')} | ${c.written.slice(0, 90)}`);
  }
  const outFile = path.join(OUT, 'lab', `${arg('out', 'say-confirm')}-${part}of${parts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), per, seeds, rows }, null, 1));
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
