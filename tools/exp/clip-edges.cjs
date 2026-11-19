// Does trimming the ends of a sentence cut into speech? The speech worker removes near-silence from
// both ends of what the voice model returns (dsp.js finishClip: everything before the first sample
// within 34 dB of the clip's peak, less a 30 ms margin, and everything more than 80 ms after the
// last such sample). Weak sounds (f, th, h, s at the start; s, f, th, t at the end) sit 25 to 45 dB
// under the peak, so they could be what is removed. This measures what the removed parts hold.
// Usage: node tools/exp/clip-edges.cjs [--n 80] [--speed 1.3] [--steps 5] [--sid 5] [--out clip-edges] [--save dir]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, writeWav } = require('./sherpa-node.cjs');
const { makeSupertonic, speak } = require('./models.cjs');
let Dsp = null;   // docs/js/dsp.js, loaded in main (it is a module)

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const db = x => 20 * Math.log10(Math.max(1e-9, x));
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

/** Level of each 5 ms frame, in dB relative to `ref`. */
function frames (samples, rate, ref) {
  const N = Math.round(rate * 0.005); const n = Math.floor(samples.length / N); const out = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; for (let j = 0; j < N; j++) { const v = samples[f * N + j]; s += v * v; } out[f] = db(Math.sqrt(s / N) / ref); }
  return out;
}

/** What finishClip's trim removes: sample indices [0, a) and (b, n). */
function trimPoints (samples, rate, { rel = 0.02, leadMs = 30, tailMs = 80 } = {}) {
  const n = samples.length; let peak = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  const floor = peak * rel; let a = 0; let b = n - 1;
  while (a < n && Math.abs(samples[a]) < floor) a++;
  while (b > a && Math.abs(samples[b]) < floor) b--;
  return { a0: a, b0: b, a: Math.max(0, a - Math.round(rate * leadMs / 1000)), b: Math.min(n - 1, b + Math.round(rate * tailMs / 1000)), peak };
}

function analyse (samples, rate) {
  const lv = Dsp.speechLevel(samples, rate);
  const t = trimPoints(samples, rate);
  const fr = frames(samples, rate, lv.rms);                 // dB relative to the speech level
  const sorted = Array.from(fr).sort((x, y) => x - y);
  const noise = sorted[Math.floor(sorted.length * 0.03)];   // the quietest stretches the model produces
  const fa = Math.floor(t.a / (rate * 0.005)); const fb = Math.ceil((t.b + 1) / (rate * 0.005));
  const count = (from, to, thr) => { let c = 0; for (let f = Math.max(0, from); f < Math.min(fr.length, to); f++) if (fr[f] > thr) c++; return c * 5; };
  const top = (from, to) => { let m = -200; for (let f = Math.max(0, from); f < Math.min(fr.length, to); f++) if (fr[f] > m) m = fr[f]; return m; };
  return {
    sec: samples.length / rate, noiseDb: noise, peakDb: db(t.peak / lv.rms),
    leadSilenceMs: 1000 * t.a0 / rate, leadCutMs: 1000 * t.a / rate, tailCutMs: 1000 * (samples.length - 1 - t.b) / rate, tailSilenceMs: 1000 * (samples.length - 1 - t.b0) / rate,
    lead: { top: top(0, fa), over50: count(0, fa, -50), over45: count(0, fa, -45), over40: count(0, fa, -40), over35: count(0, fa, -35) },
    tail: { top: top(fb, fr.length), over50: count(fb, fr.length, -50), over45: count(fb, fr.length, -45), over40: count(fb, fr.length, -40), over35: count(fb, fr.length, -35) },
    // The level profile around both cut points, 5 ms steps, for looking at single cases.
    leadProfile: Array.from(fr.slice(Math.max(0, fa - 40), fa + 16)).map(x => Math.round(x)),
    tailProfile: Array.from(fr.slice(Math.max(0, fb - 20), Math.min(fr.length, fb + 60))).map(x => Math.round(x))
  };
}

(async () => {
  Dsp = await import('../../docs/js/dsp.js');
  const n = Number(arg('n', 80)); const speed = Number(arg('speed', 1.3)); const steps = Number(arg('steps', 5)); const sid = Number(arg('sid', 5));
  const saveDir = arg('save', '');
  const st = await import('../../docs/js/speechtext.js');
  const fxDir = path.join(__dirname, '..', '..', 'test', 'fixtures');
  const all = [];
  for (const f of ['tossups-mixed.json', 'tossups-philosophy.json', 'tossups-mathcs.json']) {
    for (const q of JSON.parse(fs.readFileSync(path.join(fxDir, f), 'utf8')).tossups) for (const c of st.chunkForSpeech(st.cleanForSpeech(q.question_sanitized).text)) all.push(c.text);
  }
  // Spread over the corpus, a fixed selection so that runs can be compared.
  const step = Math.max(1, Math.floor(all.length / n));
  const sentences = []; for (let i = 3; i < all.length && sentences.length < n; i += step) sentences.push(all[i]);
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 });
  const rows = [];
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const pace = Dsp.splitPace(speed);
    const raw = speak(tts, text, { sid, speed: pace.model, steps });
    let samples = raw.samples; if (pace.stretch > 1.004) samples = Dsp.timeScale(samples, raw.sampleRate, pace.stretch);
    const a = analyse(samples, raw.sampleRate);
    const first = (text.match(/[A-Za-z0-9']+/) || [''])[0]; const last = (text.match(/([A-Za-z0-9']+)[^A-Za-z0-9]*$/) || ['', ''])[1];
    rows.push({ i, first, last, chars: text.length, ...a });
    if (saveDir) writeWav(path.join(path.resolve(saveDir), `raw-${String(i).padStart(3, '0')}.wav`), samples, raw.sampleRate);
    console.log(`${String(i).padStart(3)} ${first.padEnd(12).slice(0, 12)} lead silence ${a.leadSilenceMs.toFixed(0).padStart(4)} ms, cut ${a.leadCutMs.toFixed(0).padStart(4)} ms holding top ${a.lead.top.toFixed(0).padStart(4)} dB, over -45 dB for ${String(a.lead.over45).padStart(3)} ms | ${last.padEnd(12).slice(0, 12)} tail silence ${a.tailSilenceMs.toFixed(0).padStart(4)} ms, cut ${a.tailCutMs.toFixed(0).padStart(4)} ms holding top ${a.tail.top.toFixed(0).padStart(4)} dB, over -45 dB for ${String(a.tail.over45).padStart(3)} ms | floor ${a.noiseDb.toFixed(0)} dB`);
  }
  const sum = side => ({
    cutMs: { median: pct(rows.map(r => side === 'lead' ? r.leadCutMs : r.tailCutMs), 0.5), p90: pct(rows.map(r => side === 'lead' ? r.leadCutMs : r.tailCutMs), 0.9) },
    top: { median: pct(rows.map(r => r[side].top), 0.5), p90: pct(rows.map(r => r[side].top), 0.9), max: Math.max(...rows.map(r => r[side].top)) },
    clipsLosingOver20ms: { over50: rows.filter(r => r[side].over50 >= 20).length, over45: rows.filter(r => r[side].over45 >= 20).length, over40: rows.filter(r => r[side].over40 >= 20).length, over35: rows.filter(r => r[side].over35 >= 20).length },
    meanMsOver45: mean(rows.map(r => r[side].over45))
  });
  const summary = { clips: rows.length, noiseDb: pct(rows.map(r => r.noiseDb), 0.5), lead: sum('lead'), tail: sum('tail') };
  console.log(JSON.stringify(summary, null, 1));
  const outFile = path.join(OUT, 'lab', arg('out', 'clip-edges') + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), sid, speed, steps, summary, rows, sentences }, null, 1));
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
