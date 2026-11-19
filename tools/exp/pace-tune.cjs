// Tunes the change of pace (dsp.js, timeScale): the model speaks the sentences once at a base pace,
// and every setting of stretch length and search range is tried on those same clips.
// Usage: node tools/exp/pace-tune.cjs [--base 1.5] [--targets 1.65,2] [--frames 20,25,30,40] [--tols 5,8,12] [--asr] [--n 18]
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
  const n = Number(arg('n', 18)); const sid = Number(arg('sid', 5)); const steps = Number(arg('steps', 5)); const base = Number(arg('base', 1.5));
  const targets = nums(arg('targets', '1.65,2')); const frames = nums(arg('frames', '20,25,30,40')); const tols = nums(arg('tols', '5,8,12'));
  const withAsr = process.argv.includes('--asr');
  const st = await import('../../docs/js/speechtext.js');
  const dsp = await import('../../docs/js/dsp.js');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'tossups-philosophy.json'), 'utf8')).tossups;
  const sentences = [];
  for (let q = 0; q < fx.length && sentences.length < n; q += 3) { const chunks = st.chunkForSpeech(st.cleanForSpeech(fx[q].question_sanitized).text); for (const c of chunks.slice(0, 3)) if (sentences.length < n) sentences.push(c.text); }
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = withAsr ? makeRecognizer(Module, 'moonshine-base') : null;
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 });
  const clips = sentences.map(t => speak(tts, t, { sid, speed: base, steps }));
  const rows = [];
  const score = (label, list, ms) => {
    const hnr = []; const cpp = []; let errors = 0; let words = 0; let bad = 0;
    list.forEach((c, i) => {
      const fin = dsp.finishClip(c.samples, c.sampleRate); const m = voiceMeasures(fin.samples, fin.sampleRate); hnr.push(m.hnr); cpp.push(m.cpp);
      if (withAsr) { const w = wer(sentences[i], hear(fin.samples, fin.sampleRate)); errors += w.errors; words += w.words; if (w.errors / Math.max(1, w.words) > 0.25) bad++; }
    });
    const r = { label, hnr: mean(hnr), cpp: mean(cpp), wer: withAsr ? errors / words : null, bad, perHnr: hnr, ms };
    rows.push(r);
    console.log(`${label.padEnd(34)} HNR ${r.hnr.toFixed(2)} dB, CPP ${r.cpp.toFixed(2)} dB${withAsr ? `, WER ${(100 * r.wer).toFixed(1)}% (${bad}/${list.length} over 25%)` : ''}${ms ? `; ${(ms / list.length).toFixed(0)} ms per sentence` : ''}`);
  };
  console.log(`${sentences.length} sentences at base ${base}x, voice ${sid}, quality ${steps}`);
  score(`native ${base}x`, clips, 0);
  for (const target of targets) for (const frameMs of frames) for (const tolMs of tols) {
    let ms = 0;
    const list = clips.map(c => { const t0 = performance.now(); const s = dsp.timeScale(c.samples, c.sampleRate, target / base, { frameMs, tolMs }); ms += performance.now() - t0; return { samples: s, sampleRate: c.sampleRate }; });
    score(`${base}x -> ${target}x, ${frameMs} ms, +-${tolMs} ms`, list, ms);
  }
  fs.writeFileSync(path.join(OUT, arg('out', 'pace-tune') + '.json'), JSON.stringify({ when: new Date().toISOString(), base, sentences, rows }, null, 1));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
