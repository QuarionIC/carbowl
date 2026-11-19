// Has the reader's voice say given texts and reports what came out: what a recogniser hears, how
// long it took to say, and where it paused. For comparing two ways of writing the same thing
// ("Henry VIII" against "Henry the Eighth") on the voice model itself.
// Usage: node tools/exp/say-probe.cjs --file texts.json [--takes 2] [--speed 1.3] [--steps 5] [--sid 5] [--seed 1] [--no-asr] [--out name] [--save dir] [--raw]
//   texts.json: [ "text", ... ] or [ { id, text, expect?: ["phrase the transcript should contain", ...] }, ... ]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample, writeWav } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe, wer } = require('./models.cjs');
let Dsp = null;   // docs/js/dsp.js, loaded in main (it is a module)

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = name => process.argv.includes('--' + name);
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Stretches of near-silence inside a clip: [{ at, dur }] in seconds (10 ms frames, 35 dB under the speech level). */
function pauses (samples, rate, minSec = 0.09) {
  const frame = Math.round(rate * 0.01);
  const n = Math.floor(samples.length / frame);
  const e = new Float64Array(n); let top = 0;
  for (let f = 0; f < n; f++) { let s = 0; for (let j = 0; j < frame; j++) { const v = samples[f * frame + j]; s += v * v; } e[f] = s / frame; if (e[f] > top) top = e[f]; }
  const sorted = Array.from(e).sort((a, b) => a - b);
  const level = sorted[Math.floor(n * 0.9)] || top;       // roughly the level of the louder speech frames
  const gate = level * Math.pow(10, -35 / 10);
  const out = []; let run = 0;
  for (let f = 0; f <= n; f++) {
    if (f < n && e[f] < gate) { run++; continue; }
    if (run * 0.01 >= minSec && f - run > 0 && f < n) out.push({ at: +((f - run) * 0.01).toFixed(2), dur: +(run * 0.01).toFixed(2) });
    run = 0;
  }
  return out;
}


/**
 * How a clip's pitch ends: the pitch of its last voiced stretch against the clip's median pitch, in
 * semitones (a sentence that is over falls well below the median; one that goes on stays near it),
 * and the slope over the last 300 ms of voiced speech. Autocorrelation on a 16 kHz copy, 10 ms steps.
 */
function pitchEnd (samples, rate, { lo = 90, hi = 420 } = {}) {
  const x = rate === 16000 ? samples : resample(samples, rate, 16000);
  const W = 640; const hop = 160; const minLag = Math.floor(16000 / hi); const maxLag = Math.ceil(16000 / lo);
  let peak = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const gate = (peak * 0.03) ** 2; const track = [];
  for (let t = 0; t + W + maxLag < x.length; t += hop) {
    let e0 = 0; for (let i = 0; i < W; i++) e0 += x[t + i] * x[t + i];
    if (e0 / W < gate) continue;
    let best = 0; let at = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0; let e1 = 0;
      for (let i = 0; i < W; i++) { num += x[t + i] * x[t + i + lag]; e1 += x[t + i + lag] * x[t + i + lag]; }
      const r = num / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; at = lag; }
    }
    if (best >= 0.6 && at > 0) track.push({ t: t / 16000, f: 16000 / at });
  }
  if (track.length < 8) return { median: 0, endRel: 0, slope: 0, voiced: track.length };
  const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const median = med(track.map(p => p.f));
  const st = f => 12 * Math.log2(f / median);
  const lastT = track[track.length - 1].t;
  const tail = track.filter(p => p.t >= lastT - 0.3 && Math.abs(st(p.f)) < 14);   // octave slips are left out
  const end = med(tail.slice(-6).map(p => st(p.f)));
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const p of tail) { const y = st(p.f); sx += p.t; sy += y; sxx += p.t * p.t; sxy += p.t * y; }
  const m = tail.length; const den = m * sxx - sx * sx;
  return { median: +median.toFixed(1), endRel: +end.toFixed(2), slope: den > 1e-9 ? +((m * sxy - sx * sy) / den).toFixed(1) : 0, voiced: track.length, lastVoicedFromEnd: +(x.length / 16000 - lastT).toFixed(2) };
}

(async () => {
  Dsp = await import('../../docs/js/dsp.js');
  const file = arg('file');
  if (!file) throw new Error('--file texts.json is required');
  const items = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')).map((x, i) => typeof x === 'string' ? { id: String(i), text: x } : x);
  const takes = Number(arg('takes', 2)); const speed = Number(arg('speed', 1.3)); const steps = Number(arg('steps', 5)); const sid = Number(arg('sid', 5));
  const saveDir = arg('save', ''); const seed0 = arg('seed', '') === '' ? null : Number(arg('seed'));
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = flag('no-asr') ? null : makeRecognizer(Module, arg('asr', 'moonshine-base'));
  const hear = (samples, rate) => { if (!rec) return ''; const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 });
  const rows = [];
  for (const it of items) {
    const row = { id: it.id, text: it.text, takes: [] };
    for (let k = 0; k < takes; k++) {
      const pace = Dsp.splitPace(speed);
      const raw = speak(tts, it.text, { sid, speed: pace.model, steps, seed: seed0 === null ? undefined : seed0 + k });
      let samples = raw.samples; const rate = raw.sampleRate;
      if (pace.stretch > 1.004) samples = Dsp.timeScale(samples, rate, pace.stretch);
      const rawLen = samples.length / rate;
      const clip = flag('raw') ? { samples: samples.slice() } : Dsp.finishClip(samples.slice(), rate, {});
      const heard = hear(clip.samples, rate);
      const w = wer(it.spoken || it.text, heard);
      const expect = (it.expect || []).map(x => norm(heard).includes(norm(x)));
      const take = { heard, sec: +(clip.samples.length / rate).toFixed(2), rawSec: +rawLen.toFixed(2), pauses: pauses(clip.samples, rate), pitch: pitchEnd(clip.samples, rate), wer: +(w.errors / Math.max(1, w.words)).toFixed(3), expect };
      row.takes.push(take);
      if (saveDir) writeWav(path.join(path.resolve(saveDir), `${String(it.id).replace(/[^A-Za-z0-9_-]+/g, '_')}-${k}.wav`), clip.samples, rate);
    }
    rows.push(row);
    console.log(`\n[${it.id}] ${it.text}`);
    for (const t of row.takes) console.log(`   ${t.sec.toFixed(2)} s  pauses ${t.pauses.map(p => `${p.dur}@${p.at}`).join(' ') || '-'}  ${it.expect ? '[' + t.expect.map(x => x ? 'ok' : 'NO').join(',') + '] ' : ''}pitch end ${t.pitch.endRel} st, slope ${t.pitch.slope} st/s => ${t.heard}`);
  }
  const outFile = path.join(OUT, 'lab', (arg('out', 'say-probe')) + '.result.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), sid, speed, steps, takes, rows }, null, 1));
  console.log('\nwritten ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
