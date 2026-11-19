// Is a higher quality setting (more refinement steps) heard more clearly? The same sentences, with
// the same seeds, at each setting; a recogniser's word error rate against the text as it is said.
// The seed fixes the noise the model starts from, so two settings differ only in the number of
// steps taken from it. (The earlier, unseeded comparison in voice-quality.cjs could not tell 3, 5
// and 8 apart on 18 sentences.)
// Usage: node tools/exp/steps-paired.cjs [--n 80] [--seeds 2] [--steps 3,5,8,12] [--part 0/6] [--out steps-paired]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe } = require('./models.cjs');
const { voiceMeasures } = require('./voice-measures.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
function wer (a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], words: a.length };
}

(async () => {
  const n = Number(arg('n', 80)); const seeds = Number(arg('seeds', 2)); const [part, parts] = String(arg('part', '0/1')).split('/').map(Number);
  const stepList = String(arg('steps', '3,5,8,12')).split(',').map(Number);
  const reading = await import('../../docs/js/reading.js');
  const st = await import('../../docs/js/speechtext.js');
  const num = await import('../../docs/js/numbers.js');
  const Dsp = await import('../../docs/js/dsp.js');
  const fxDir = path.join(__dirname, '..', '..', 'test', 'fixtures');
  const all = [];
  for (const f of ['tossups-mixed.json', 'tossups-philosophy.json', 'tossups-mathcs.json']) {
    for (const q of JSON.parse(fs.readFileSync(path.join(fxDir, f), 'utf8')).tossups) for (const c of st.chunkForSpeech(st.cleanForSpeech(q.question_sanitized).text)) all.push(c.text);
  }
  const step = Math.max(1, Math.floor(all.length / n));
  const sentences = []; for (let i = 3; i < all.length && sentences.length < n; i += step) sentences.push(all[i]);
  const canon = text => st.wordsOf(num.canonNumbers(reading.speakable(String(text)).replace(/-/g, ' ')));
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid: 5, speed: 1, steps: 3 });
  const rows = [];
  for (let i = 0; i < sentences.length; i++) {
    if (i % parts !== part) continue;
    const said = reading.speakable(sentences[i]); const ref = canon(said);
    const row = { i, text: sentences[i], takes: [] };
    for (let k = 0; k < seeds; k++) {
      const take = { seed: 900 + k };
      for (const steps of stepList) {
        const t0 = performance.now();
        const raw = speak(tts, said, { sid: 5, speed: 1.3, steps, seed: 900 + k });
        const ms = performance.now() - t0;
        const clip = Dsp.finishClip(raw.samples.slice(), raw.sampleRate, {});
        const heard = hear(clip.samples, raw.sampleRate);
        const w = wer(ref, canon(heard)); const m = voiceMeasures(clip.samples, raw.sampleRate);
        take[steps] = { errors: w.errors, words: w.words, sec: +(clip.samples.length / raw.sampleRate).toFixed(2), ms: Math.round(ms), hnr: +m.hnr.toFixed(2), cpp: +m.cpp.toFixed(2), heard };
      }
      row.takes.push(take);
    }
    rows.push(row);
    console.log(`${String(i).padStart(3)} ` + stepList.map(s => `q${s}: ${row.takes.map(t => t[s].errors + '/' + t[s].words).join(' ')}`).join(' | '));
  }
  const outFile = path.join(OUT, 'lab', `${arg('out', 'steps-paired')}-${part}of${parts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), stepList, seeds, rows }, null, 1));
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
