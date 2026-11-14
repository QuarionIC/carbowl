// Keyword-spotting experiment for the word "buzz".
// Positives: synthetic "buzz" utterances, clean / with road noise / spoken over the app's own voice.
// Negatives: quizbowl sentences read aloud, confusable words, noise.
// Usage: node tools/exp/kws-exp.cjs [--keywords "..."] [--score X] [--threshold X] [--blanks N] [--fp32] [--quick]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav, mulberry32, roadNoise, rmsActive } = require('./sherpa-node.cjs');
const { makeKws } = require('./models.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes('--' + name);
const SR = 16000;
const DEFAULT_KEYWORDS = '▁BU Z Z @BUZZ';

const load = dir => !fs.existsSync(path.join(OUT, dir)) ? [] : fs.readdirSync(path.join(OUT, dir)).filter(f => f.endsWith('.wav') && fs.existsSync(path.join(OUT, dir, f.replace(/\.wav$/, '.json')))).sort().map(f => ({ name: f.replace(/\.wav$/, ''), samples: readWav(path.join(OUT, dir, f)).samples, meta: JSON.parse(fs.readFileSync(path.join(OUT, dir, f.replace(/\.wav$/, '.json')), 'utf8')) }));

/** Runs the spotter over a signal in 100 ms steps; returns detections as { keyword, at (seconds) }. */
function spot (kws, signal) {
  const stream = kws.createStream();
  const hits = []; const step = SR / 10;
  for (let i = 0; i < signal.length; i += step) {
    stream.acceptWaveform(SR, signal.subarray(i, Math.min(signal.length, i + step)));
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r.keyword) { hits.push({ keyword: r.keyword, at: (i + step) / SR }); kws.reset(stream); }
    }
  }
  stream.free();
  return hits;
}

function pad (samples, before, after) {
  const out = new Float32Array(Math.round(before * SR) + samples.length + Math.round(after * SR));
  out.set(samples, Math.round(before * SR));
  return out;
}
function scaleTo (samples, targetRms) { const r = rmsActive(samples) || 1e-9; const g = targetRms / r; const out = new Float32Array(samples.length); for (let i = 0; i < samples.length; i++) out[i] = samples[i] * g; return out; }
function mixAt (base, add, offsetSec) { const out = new Float32Array(base); const o = Math.round(offsetSec * SR); for (let i = 0; i < add.length && o + i < out.length; i++) out[o + i] += add[i]; return out; }
function noisy (signal, speechRms, snrDb, rand) { if (snrDb === Infinity) return signal; const n = roadNoise(signal.length, rand); const g = speechRms / Math.pow(10, snrDb / 20); const out = new Float32Array(signal.length); for (let i = 0; i < signal.length; i++) out[i] = signal[i] + g * n[i]; return out; }

(async () => {
  const keywords = arg('keywords', DEFAULT_KEYWORDS).replace(/\\n/g, '\n');
  const opts = { score: Number(arg('score', 1.0)), threshold: Number(arg('threshold', 0.25)), trailingBlanks: Number(arg('blanks', 1)), int8: !has('fp32') };
  const Module = await loadSherpa();
  const kws = makeKws(Module, keywords, opts);
  const rand = mulberry32(20261113);
  const LEVEL = 0.08; // nominal speech RMS at the microphone

  const buzz = load('buzz'); const questions = load('questions'); const words = load('words');
  const quick = has('quick');
  const out = { keywords: keywords.replace(/\n/g, ' | '), ...opts };

  // 1. Positives: buzz alone at several noise levels.
  out.detect = {};
  for (const snr of quick ? [Infinity, 10] : [Infinity, 20, 10, 5, 0]) {
    let hit = 0; let latency = 0;
    for (const b of buzz) {
      const speech = scaleTo(b.samples, LEVEL);
      const sig = noisy(pad(speech, 1.0, 1.5), LEVEL, snr, rand);
      const hits = spot(kws, sig).filter(h => h.keyword === 'BUZZ');
      if (hits.length) { hit++; latency += hits[0].at - (1.0 + speech.length / SR); }
    }
    out.detect[snr === Infinity ? 'clean' : snr + 'dB'] = `${hit}/${buzz.length}` + (hit ? ` (+${(latency / hit).toFixed(2)}s after word end)` : '');
  }

  // 2. Positives over the app's own voice: buzz mixed onto a question at a given user-to-echo level ratio.
  out.overEcho = {};
  for (const ratio of quick ? [10, 0] : [20, 10, 5, 0, -5]) {
    let hit = 0; let falseBefore = 0;
    for (let i = 0; i < buzz.length; i++) {
      const q = questions[i % questions.length];
      const echo = scaleTo(q.samples, LEVEL / Math.pow(10, ratio / 20));
      const speech = scaleTo(buzz[i].samples, LEVEL);
      const at = Math.min(2.0, Math.max(0.5, q.samples.length / SR - 2.0));
      const sig = mixAt(pad(echo, 0, 1.0), speech, at);
      const hits = spot(kws, sig).filter(h => h.keyword === 'BUZZ');
      if (hits.some(h => h.at >= at && h.at <= at + speech.length / SR + 1.2)) hit++;
      if (hits.some(h => h.at < at)) falseBefore++;
    }
    out.overEcho[(ratio >= 0 ? '+' : '') + ratio + 'dB'] = `${hit}/${buzz.length}` + (falseBefore ? ` (false before buzz: ${falseBefore})` : '');
  }

  // 3. Negatives: question audio alone (false alarms per hour), clean and with noise.
  out.falseAlarms = {};
  for (const snr of quick ? [Infinity] : [Infinity, 10]) {
    let fa = 0; let sec = 0; const which = [];
    for (const q of questions) {
      const sig = noisy(pad(scaleTo(q.samples, LEVEL), 0.3, 0.5), LEVEL, snr, rand);
      const hits = spot(kws, sig); fa += hits.length; sec += sig.length / SR;
      if (hits.length) which.push(q.meta.text.slice(0, 60));
    }
    out.falseAlarms[snr === Infinity ? 'questions clean' : `questions ${snr}dB`] = `${fa} in ${(sec / 60).toFixed(1)} min` + (which.length ? ' :: ' + which.slice(0, 3).join(' / ') : '');
  }
  // 4. Negatives: confusable words and command phrases.
  const conf = {};
  for (const w of words) { const hits = spot(kws, pad(scaleTo(w.samples, LEVEL), 0.5, 1.0)); if (hits.length) conf[w.meta.text] = (conf[w.meta.text] || 0) + 1; }
  out.confusable = Object.keys(conf).length ? Object.entries(conf).map(([k, v]) => `${k}x${v}`).join(' ') : 'none';
  // 5. Negatives: noise only.
  { const n = roadNoise(SR * 120, rand); for (let i = 0; i < n.length; i++) n[i] *= LEVEL; out.noiseOnly = `${spot(kws, n).length} in 2.0 min`; }

  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
