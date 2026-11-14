// Sanity checks for the keyword spotter: the model's own test files, then our "buzz" samples under
// several token spellings, boosts and thresholds. Also transcribes the buzz samples.
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav, resample } = require('./sherpa-node.cjs');
const { makeKws, makeRecognizer, transcribe, KWS_DIR } = require('./models.cjs');
const SR = 16000;

function spot (kws, signal, sr = SR) {
  const stream = kws.createStream(); const hits = []; const step = sr / 10;
  for (let i = 0; i < signal.length; i += step) {
    stream.acceptWaveform(sr, signal.subarray(i, Math.min(signal.length, i + step)));
    while (kws.isReady(stream)) { kws.decode(stream); const r = kws.getResult(stream); if (r.keyword) { hits.push(r.keyword + '@' + ((i + step) / sr).toFixed(1)); kws.reset(stream); } }
  }
  // Flush with trailing silence so the last chunk is decoded.
  stream.acceptWaveform(sr, new Float32Array(sr));
  while (kws.isReady(stream)) { kws.decode(stream); const r = kws.getResult(stream); if (r.keyword) { hits.push(r.keyword + '@end'); kws.reset(stream); } }
  stream.free();
  return hits;
}

(async () => {
  const Module = await loadSherpa();
  // 1. The model's own test files.
  const own = makeKws(Module, fs.readFileSync(path.join(KWS_DIR, 'test_wavs', 'test_keywords.txt'), 'utf8').trim());
  for (const f of ['0.wav', '1.wav']) { const w = readWav(path.join(KWS_DIR, 'test_wavs', f)); console.log('own test', f, w.sampleRate + 'Hz', (w.samples.length / w.sampleRate).toFixed(1) + 's', '->', spot(own, w.samples, w.sampleRate).join(' ') || '(nothing)'); }
  console.log('  transcripts:', fs.readFileSync(path.join(KWS_DIR, 'test_wavs', 'trans.txt'), 'utf8').trim().replace(/\n/g, ' | '));
  own.free();

  // 2. What do our buzz samples sound like to a recogniser?
  const rec = makeRecognizer(Module, 'moonshine-tiny');
  const files = fs.readdirSync(path.join(OUT, 'buzz')).filter(f => f.endsWith('.wav')).sort();
  const heard = {};
  for (const f of files) { const w = readWav(path.join(OUT, 'buzz', f)); const t = transcribe(rec, w.samples, w.sampleRate) || '(empty)'; heard[t] = (heard[t] || 0) + 1; }
  console.log('buzz samples as heard by moonshine-tiny:', JSON.stringify(heard));
  const first = readWav(path.join(OUT, 'buzz', files[0]));
  console.log('first sample:', files[0], (first.samples.length / first.sampleRate).toFixed(2) + 's');

  // 3. Token spellings x boost x threshold.
  const pad = s => { const o = new Float32Array(SR + s.length + SR * 2); o.set(s, SR); return o; };
  const spellings = { 'BU Z Z': '▁BU Z Z', 'B U Z Z': '▁B U Z Z' };
  for (const [label, toks] of Object.entries(spellings)) {
    for (const [score, th] of [[1, 0.25], [1, 0.1], [2, 0.25], [2, 0.1], [3, 0.1], [4, 0.05], [6, 0.02]]) {
      const kws = makeKws(Module, `${toks} @BUZZ`, { score, threshold: th });
      let hit = 0;
      for (const f of files) { const w = readWav(path.join(OUT, 'buzz', f)); if (spot(kws, pad(w.samples)).length) hit++; }
      console.log(`  "${label}" score ${score} threshold ${th}: ${hit}/${files.length}`);
      kws.free();
    }
  }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
