// The same sentences before and after the sound system (pairs exported by sound-path.mjs compare
// --export), through the instruments used for the voice itself: words the recogniser gets wrong,
// HNR and CPP. Each sentence is compared with itself, so the differences are paired.
// Usage: node tools/exp/sound-clarity.cjs <dir> [<dir> ...]
'use strict';
const fs = require('fs');
const path = require('path');
const { loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeRecognizer, transcribe, wer } = require('./models.cjs');
const { voiceMeasures } = require('./voice-measures.cjs');

const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const se = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1) / a.length) : NaN; };

function readFloatWav (file) {
  const b = fs.readFileSync(file); const rate = b.readUInt32LE(24); const n = (b.length - 44) >> 2;
  const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b.readFloatLE(44 + i * 4);
  return { samples: x, rate };
}

(async () => {
  const Module = await loadSherpa();
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  for (const dir of process.argv.slice(2)) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const by = new Map();
    for (const e of index) {
      const a = readFloatWav(path.join(dir, e.tag + '.in.wav')); const b = readFloatWav(path.join(dir, e.tag + '.out.wav'));
      // The recogniser and the measures are level-blind only up to a point: bring the output to the input's level first.
      const ra = Math.sqrt(a.samples.reduce((s, v) => s + v * v, 0) / a.samples.length); const rb = Math.sqrt(b.samples.reduce((s, v) => s + v * v, 0) / b.samples.length);
      const out = b.samples.map(v => v * ra / (rb || 1));
      const wi = wer(e.text, hear(a.samples, a.rate)); const wo = wer(e.text, hear(out, b.rate));
      const mi = voiceMeasures(a.samples, a.rate); const mo = voiceMeasures(out, b.rate);
      const row = { clip: e.clip, werIn: wi.errors / Math.max(1, wi.words), werOut: wo.errors / Math.max(1, wo.words), errIn: wi.errors, errOut: wo.errors, words: wi.words, hnr: mo.hnr - mi.hnr, cpp: mo.cpp - mi.cpp, hnrIn: mi.hnr, cppIn: mi.cpp };
      if (!by.has(e.label)) by.set(e.label, []);
      by.get(e.label).push(row);
    }
    console.log(path.basename(dir));
    for (const [label, rows] of by) {
      const words = rows.reduce((s, r) => s + r.words, 0);
      console.log(`  ${label.padEnd(14)} ${rows.length} sentence(s), ${words} words: misheard going in ${rows.reduce((s, r) => s + r.errIn, 0)}, coming out ${rows.reduce((s, r) => s + r.errOut, 0)}; HNR ${mean(rows.map(r => r.hnr)) >= 0 ? '+' : ''}${mean(rows.map(r => r.hnr)).toFixed(2)} dB (se ${se(rows.map(r => r.hnr)).toFixed(2)}), CPP ${mean(rows.map(r => r.cpp)) >= 0 ? '+' : ''}${mean(rows.map(r => r.cpp)).toFixed(2)} dB (se ${se(rows.map(r => r.cpp)).toFixed(2)})`);
    }
  }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
