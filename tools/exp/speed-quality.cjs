// Two ways of reading fast, compared on the same sentences:
//   native    the voice model is asked for the faster pace itself (its "speed" setting);
//   stretched the model speaks at a moderate pace and the result is compressed in time (dsp.js,
//             timeScale), which leaves every sound in but shortens it.
// For each: word error rate through the recogniser, the acoustic measures, and the pace reached.
// Usage: node tools/exp/speed-quality.cjs [--n 18] [--sid 5] [--steps 5] [--bases 1,1.3] [--targets 1.3,1.5,1.65,2] [--native 1.5] [--out name]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe, wer } = require('./models.cjs');
const { voiceMeasures } = require('./voice-measures.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const nums = s => String(s).split(',').filter(Boolean).map(Number);
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

(async () => {
  const n = Number(arg('n', 18)); const sid = Number(arg('sid', 5)); const steps = Number(arg('steps', 5));
  const bases = nums(arg('bases', '1,1.3')); const targets = nums(arg('targets', '1.3,1.5,1.65,2')); const natives = nums(arg('native', '1.5'));
  const st = await import('../../docs/js/speechtext.js');
  const dsp = await import('../../docs/js/dsp.js');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'tossups-philosophy.json'), 'utf8')).tossups;
  const sentences = [];
  for (let q = 0; q < fx.length && sentences.length < n; q += 3) { const chunks = st.chunkForSpeech(st.cleanForSpeech(fx[q].question_sanitized).text); for (const c of chunks.slice(0, 3)) if (sentences.length < n) sentences.push(c.text); }
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 });
  const chars = sentences.join(' ').length;
  const rows = [];
  const score = (label, clips, genMs, extraMs = 0) => {
    let errors = 0; let words = 0; let sec = 0; const hnr = []; const cpp = []; let bad = 0; const per = [];
    clips.forEach((c, i) => {
      const fin = dsp.finishClip(c.samples, c.sampleRate);
      const w = wer(sentences[i], hear(fin.samples, fin.sampleRate)); errors += w.errors; words += w.words; if (w.errors / Math.max(1, w.words) > 0.25) bad++;
      const m = voiceMeasures(fin.samples, fin.sampleRate); hnr.push(m.hnr); cpp.push(m.cpp); sec += fin.samples.length / fin.sampleRate;
      per.push({ wer: w.errors / Math.max(1, w.words), hnr: m.hnr, cpp: m.cpp, sec: fin.samples.length / fin.sampleRate });
    });
    const r = { label, wer: errors / words, bad, hnr: mean(hnr), cpp: mean(cpp), charsPerSec: chars / sec, factor: (genMs + extraMs) / (sec * 1000), stretchMs: extraMs, per };
    rows.push(r);
    console.log(`${label.padEnd(26)} WER ${(100 * r.wer).toFixed(1).padStart(5)}% (${String(bad).padStart(2)}/${clips.length} over 25%); HNR ${r.hnr.toFixed(2)} dB, CPP ${r.cpp.toFixed(2)} dB; ${r.charsPerSec.toFixed(1)} chars/s; made in ${r.factor.toFixed(2)} of real time${extraMs ? ` (${(extraMs / clips.length).toFixed(0)} ms per sentence of that is the compressing)` : ''}`);
  };
  console.log(`${sentences.length} sentences, voice ${sid}, quality ${steps}`);
  for (const sp of natives) {
    let genMs = 0; const clips = sentences.map(t => { const t0 = performance.now(); const a = speak(tts, t, { sid, speed: sp, steps }); genMs += performance.now() - t0; return a; });
    score(`native ${sp}x`, clips, genMs);
  }
  for (const base of bases) {
    let genMs = 0; const clips = sentences.map(t => { const t0 = performance.now(); const a = speak(tts, t, { sid, speed: base, steps }); genMs += performance.now() - t0; return a; });
    score(`native ${base}x`, clips, genMs);
    for (const target of targets) {
      if (target <= base + 1e-6) continue;
      let ms = 0;
      const stretched = clips.map(c => { const t0 = performance.now(); const s = dsp.timeScale(c.samples, c.sampleRate, target / base); ms += performance.now() - t0; return { samples: s, sampleRate: c.sampleRate }; });
      score(`${base}x compressed to ${target}x`, stretched, genMs, ms);
    }
  }
  const outFile = path.join(OUT, arg('out', 'speed-quality') + '.json');
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), sid, steps, sentences, rows }, null, 1));
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
