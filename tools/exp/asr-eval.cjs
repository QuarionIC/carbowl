// Transcribes every WAV in a folder and reports word error rate against the matching .txt files.
// Used as an intelligibility check for a synthesised voice, and as a recogniser comparison.
// Usage: node tools/exp/asr-eval.cjs <asr-model> <folder under downloads/out> [--show]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav } = require('./sherpa-node.cjs');
const { makeRecognizer, transcribe, wer } = require('./models.cjs');

(async () => {
  const model = process.argv[2]; const dir = path.join(OUT, process.argv[3]);
  const show = process.argv.includes('--show');
  const Module = await loadSherpa();
  const t0 = Date.now();
  const rec = makeRecognizer(Module, model);
  console.log(`recogniser ${model} ready in ${Date.now() - t0} ms`);
  let errors = 0; let words = 0; let audio = 0; let ms = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.wav')).sort()) {
    const { samples, sampleRate } = readWav(path.join(dir, f));
    const ref = fs.readFileSync(path.join(dir, f.replace(/\.wav$/, '.txt')), 'utf8');
    const a = Date.now(); const hyp = transcribe(rec, samples, sampleRate); const took = Date.now() - a;
    const w = wer(ref, hyp); errors += w.errors; words += w.words; audio += samples.length / sampleRate; ms += took;
    if (show || w.errors / Math.max(1, w.words) > 0.25) console.log(`${f} WER ${(100 * w.errors / Math.max(1, w.words)).toFixed(0)}% (${took} ms)\n   REF: ${ref}\n   HYP: ${hyp}`);
  }
  console.log(`${model} on ${process.argv[3]}: WER ${(100 * errors / words).toFixed(1)}% (${errors}/${words} words); ${audio.toFixed(1)} s audio decoded in ${(ms / 1000).toFixed(1)} s (RTF ${(ms / 1000 / audio).toFixed(3)})`);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
