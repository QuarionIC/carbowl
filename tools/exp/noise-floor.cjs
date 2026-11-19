// How much sound does the voice model put out when it is not speaking? Before the first word and
// after the last one a clip should be silent; this measures what is there instead, against the
// level of the speech itself, and how that depends on the quality setting (the model's number of
// refinement steps) and the speaker.
// Usage: node tools/exp/noise-floor.cjs [--n 10] [--configs "5:5,8:5,5:0"] (steps:speaker) [--speed 1.3] [--out noise-floor] [--save dir]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, writeWav } = require('./sherpa-node.cjs');
const { makeSupertonic, speak } = require('./models.cjs');
const { fft } = require('./voice-measures.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const db = x => 20 * Math.log10(Math.max(1e-12, x));
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function rms (x, from, to) { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); }

/** Mean power per octave band over [from, to), as RMS amplitudes. */
function bands (x, rate, from, to) {
  const N = 1024; const hop = 256; const acc = new Float64Array(N / 2); let frames = 0;
  const re = new Float64Array(N); const im = new Float64Array(N);
  for (let t = from; t + N <= to; t += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[t + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return null;
  // Window power 0.375 * N; two-sided spectrum: amplitude^2 of a band = 2 * sum(|X|^2) / (N^2 * 0.375).
  return BANDS.map(fc => { let s = 0; const lo = fc / Math.SQRT2; const hi = fc * Math.SQRT2; for (let k = 1; k < N / 2; k++) { const f = k * rate / N; if (f >= lo && f < hi) s += acc[k]; } return Math.sqrt(2 * s / frames / (N * N * 0.375)); });
}

function measure (x, rate) {
  const n = x.length;
  // Speech level as dsp.js defines it: RMS over the 20 ms frames within 30 dB of the loudest.
  const F = Math.round(rate * 0.02); const cnt = Math.floor(n / F); const e = new Float64Array(cnt); let top = 0;
  for (let f = 0; f < cnt; f++) { let s = 0; for (let j = 0; j < F; j++) s += x[f * F + j] * x[f * F + j]; e[f] = s / F; if (e[f] > top) top = e[f]; }
  let sum = 0; let used = 0; for (let f = 0; f < cnt; f++) if (e[f] >= top * 1e-3) { sum += e[f]; used++; }
  const speech = Math.sqrt(sum / Math.max(1, used));
  let peak = 0; for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  // Where speech starts and ends, as the worker's trim sees it (first and last sample within 34 dB of the peak).
  let a = 0; let b = n - 1; const thr = peak * 0.02;
  while (a < n && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  const guard = Math.round(rate * 0.012);
  const leadTo = Math.max(0, a - guard); const tailFrom = Math.min(n, b + Math.round(rate * 0.06));
  const lead = leadTo > rate * 0.015 ? rms(x, 0, leadTo) : null;
  const tail = n - tailFrom > rate * 0.015 ? rms(x, tailFrom, n) : null;
  // The quietest 60 ms inside the speech (a pause at a comma), in 20 ms frames.
  let inner = null;
  const f0 = Math.ceil(a / F) + 5; const f1 = Math.floor(b / F) - 5;
  for (let f = f0; f + 3 <= f1; f++) { const v = Math.sqrt((e[f] + e[f + 1] + e[f + 2]) / 3); if (inner === null || v < inner) inner = v; }
  return {
    speechDb: db(speech), leadMs: 1000 * leadTo / rate, tailMs: 1000 * (n - tailFrom) / rate,
    lead: lead === null ? null : db(lead / speech), tail: tail === null ? null : db(tail / speech), inner: inner === null ? null : db(inner / speech),
    leadBands: leadTo > 1100 ? bands(x, rate, 0, leadTo).map(v => db(v / speech)) : null,
    speechBands: bands(x, rate, a, b).map(v => db(v / speech)),
    dc: db(Math.abs(mean(Array.from(x.subarray(0, Math.min(n, 4096))))) / speech)
  };
}

(async () => {
  const n = Number(arg('n', 10)); const speed = Number(arg('speed', 1.3)); const saveDir = arg('save', '');
  const configs = String(arg('configs', '2:5,3:5,5:5,8:5,12:5,16:5')).split(',').map(s => { const [steps, sid] = s.split(':').map(Number); return { steps, sid }; });
  const st = await import('../../docs/js/speechtext.js');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'tossups-mixed.json'), 'utf8')).tossups;
  const sentences = [];
  for (let q = 1; q < fx.length && sentences.length < n; q += 5) { const c = st.chunkForSpeech(st.cleanForSpeech(fx[q].question_sanitized).text); if (c[1]) sentences.push(c[1].text); }
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  speak(tts, 'Ready.', { sid: 5, speed: 1, steps: 3 });
  const results = [];
  for (const c of configs) {
    const rows = [];
    for (let i = 0; i < sentences.length; i++) {
      const raw = speak(tts, sentences[i], { sid: c.sid, speed, steps: c.steps });
      rows.push(measure(raw.samples, raw.sampleRate));
      if (saveDir && i < 2) writeWav(path.join(path.resolve(saveDir), `nf-s${c.steps}-v${c.sid}-${i}.wav`), raw.samples, raw.sampleRate);
    }
    const col = k => rows.map(r => r[k]).filter(v => v !== null && Number.isFinite(v));
    const avgBands = k => { const list = rows.map(r => r[k]).filter(Boolean); return BANDS.map((_, i) => +median(list.map(l => l[i])).toFixed(1)); };
    const r = { ...c, clips: rows.length, lead: +median(col('lead')).toFixed(1), tail: +median(col('tail')).toFixed(1), inner: +median(col('inner')).toFixed(1), leadMs: +median(col('leadMs')).toFixed(0), tailMs: +median(col('tailMs')).toFixed(0), leadBands: avgBands('leadBands'), speechBands: avgBands('speechBands'), dc: +median(col('dc')).toFixed(1), rows };
    results.push(r);
    console.log(`steps ${String(c.steps).padStart(2)} speaker ${c.sid}: before the first word ${r.lead} dB (over ${r.leadMs} ms), after the last ${r.tail} dB (${r.tailMs} ms), quietest pause inside ${r.inner} dB, relative to the speech level`);
    console.log(`     bands ${BANDS.join(' ')} Hz: noise ${r.leadBands.join(' ')} | speech ${r.speechBands.join(' ')}`);
  }
  const outFile = path.join(OUT, 'lab', arg('out', 'noise-floor') + '.json');
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), speed, sentences, results }, null, 1));
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
