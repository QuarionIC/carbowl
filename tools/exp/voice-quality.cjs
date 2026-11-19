// Measures what the reader's voice sounds like at different settings, on real question sentences:
//   - how long speech takes to generate (as a share of its own duration),
//   - how well a recogniser understands it (word error rate: a stand-in for clarity),
//   - how clean the voice is (harmonics-to-noise ratio and cepstral peak prominence over voiced
//     frames: both fall when a voice turns rough, buzzy or noisy),
//   - how even the loudness is from one sentence to the next,
//   - whether the same sentence comes out the same twice.
// Usage: node tools/exp/voice-quality.cjs [--n 24] [--sid 5] [--configs "5@1.3,3@1.3,2@1.3,8@1.3,5@1,5@1.65,5@2"] [--repeat 3] [--out name]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe, wer } = require('./models.cjs');
const { voiceMeasures, activeLevel, tidyLikeWorker, db } = require('./voice-measures.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

(async () => {
  const n = Number(arg('n', 24)); const sid = Number(arg('sid', 5)); const repeat = Number(arg('repeat', 3));
  const configs = String(arg('configs', '5@1.3,3@1.3,2@1.3,8@1.3,5@1,5@1.65,5@2')).split(',').map(s => { const [steps, speed] = s.split('@').map(Number); return { steps, speed }; });
  const st = await import('../../docs/js/speechtext.js');
  const sentences = [];
  for (const f of ['tossups-philosophy.json']) {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', f), 'utf8')).tossups;
    // Every third question, so the sentences come from many different questions.
    for (let q = 0; q < fx.length && sentences.length < n; q += 3) { const chunks = st.chunkForSpeech(st.cleanForSpeech(fx[q].question_sanitized).text); for (const c of chunks.slice(0, 3)) if (sentences.length < n) sentences.push(c.text); }
  }
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = audio => { const s = resample(audio.samples, audio.sampleRate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 }); // first inference is slow
  console.log(`${sentences.length} sentences, voice ${sid}, ${tts.sampleRate} Hz`);
  const results = [];
  for (const c of configs) {
    let genMs = 0; let audioMs = 0; let errors = 0; let words = 0; const perSentence = [];
    for (const text of sentences) {
      const t0 = performance.now(); const raw = speak(tts, text, { sid, ...c }); const ms = performance.now() - t0;
      const samples = tidyLikeWorker(raw.samples, raw.sampleRate);
      const dur = 1000 * samples.length / raw.sampleRate;
      genMs += ms; audioMs += dur;
      const w = wer(text, hear({ samples, sampleRate: raw.sampleRate })); errors += w.errors; words += w.words;
      const m = voiceMeasures(samples, raw.sampleRate);
      perSentence.push({ chars: text.length, ms: Math.round(ms), dur: Math.round(dur), wer: w.errors / Math.max(1, w.words), level: activeLevel(samples, raw.sampleRate), ...m });
    }
    const r = {
      ...c, rtf: genMs / audioMs, wer: errors / words, badSentences: perSentence.filter(p => p.wer > 0.25).length,
      hnr: mean(perSentence.map(p => p.hnr)), cpp: mean(perSentence.map(p => p.cpp)), voiced: mean(perSentence.map(p => p.voiced)),
      hf: mean(perSentence.map(p => p.hfDb)), levelMean: mean(perSentence.map(p => p.level.rmsDb)), levelSd: sd(perSentence.map(p => p.level.rmsDb)),
      levelMin: Math.min(...perSentence.map(p => p.level.rmsDb)), levelMax: Math.max(...perSentence.map(p => p.level.rmsDb)),
      crest: mean(perSentence.map(p => p.level.crestDb)), charsPerSec: sentences.join(' ').length / (audioMs / 1000),
      rtfP90: pct(perSentence.map(p => p.ms / p.dur), 0.9), perSentence
    };
    results.push(r);
    console.log(`steps ${c.steps} speed ${c.speed}: generated in ${r.rtf.toFixed(3)} of real time (90th pct ${r.rtfP90.toFixed(3)}); ${r.charsPerSec.toFixed(1)} chars/s; WER ${(100 * r.wer).toFixed(1)}% (${r.badSentences}/${sentences.length} sentences over 25%); HNR ${r.hnr.toFixed(2)} dB, CPP ${r.cpp.toFixed(2)} dB, voiced ${(100 * r.voiced).toFixed(0)}%, above 8 kHz ${r.hf.toFixed(1)} dB; level ${r.levelMean.toFixed(1)} dBFS sd ${r.levelSd.toFixed(2)} (min ${r.levelMin.toFixed(1)}, max ${r.levelMax.toFixed(1)}), crest ${r.crest.toFixed(1)} dB`);
  }
  // The same sentence several times: is the result the same audio, and how much does clarity vary?
  if (repeat > 1) {
    const probe = sentences.slice(0, 6);
    let identical = 0; let total = 0; const spread = [];
    for (const text of probe) {
      const takes = [];
      for (let k = 0; k < repeat; k++) { const raw = speak(tts, text, { sid, speed: 1.3, steps: 5 }); takes.push(raw); }
      for (let k = 1; k < repeat; k++) {
        total++;
        const a = takes[0].samples; const b = takes[k].samples;
        let same = a.length === b.length; let maxDiff = 0;
        if (same) for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > maxDiff) maxDiff = d; }
        if (same && maxDiff < 1e-6) identical++;
      }
      const ws = takes.map(t => { const s = tidyLikeWorker(t.samples, t.sampleRate); const w = wer(text, hear({ samples: s, sampleRate: t.sampleRate })); return w.errors / Math.max(1, w.words); });
      const ds = takes.map(t => t.samples.length / t.sampleRate);
      spread.push({ wer: ws.map(x => +x.toFixed(2)), durations: ds.map(x => +x.toFixed(2)) });
    }
    console.log(`repeat check: ${identical}/${total} repeated takes are sample-for-sample identical`);
    for (const s of spread) console.log(`   WER per take ${JSON.stringify(s.wer)}; seconds per take ${JSON.stringify(s.durations)}`);
    results.push({ repeat: { identical, total, spread } });
  }
  const outFile = path.join(OUT, (arg('out', 'voice-quality')) + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), sid, sentences, results }, null, 1));
  console.log('written ' + outFile);
  void db;
})().catch(e => { console.error('FAILED', e); process.exit(1); });
