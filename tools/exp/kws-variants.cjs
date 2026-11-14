// Which token spellings does the keyword model actually fire on when it hears "buzz"?
// Every candidate gets its own label; we count first hits per sample, then false hits on questions/words.
// Usage: node tools/exp/kws-variants.cjs [--score X] [--threshold X]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav } = require('./sherpa-node.cjs');
const { makeKws } = require('./models.cjs');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const SR = 16000;
const U = '▁';
const CANDIDATES = ['BU Z Z', 'BU S', 'BU Z', 'BU S S', 'BU ZE', 'B U S', 'B U Z', 'BO S S', 'BA S', 'B A S', 'BU Z Z ES', 'BU Z Z ED', 'BU T', 'B E S', 'BU S T', 'BA S E', 'BO Z', 'B UR S', 'BU ST', 'B US', 'BU SE', 'BI Z', 'BU Y S'];

function spot (kws, signal) {
  const stream = kws.createStream(); const hits = []; const step = SR / 10;
  for (let i = 0; i < signal.length; i += step) {
    stream.acceptWaveform(SR, signal.subarray(i, Math.min(signal.length, i + step)));
    while (kws.isReady(stream)) { kws.decode(stream); const r = kws.getResult(stream); if (r.keyword) { hits.push(r.keyword); kws.reset(stream); } }
  }
  stream.free();
  return hits;
}
const pad = (s, a = 1, b = 1.5) => { const o = new Float32Array(Math.round(a * SR) + s.length + Math.round(b * SR)); o.set(s, Math.round(a * SR)); return o; };
const load = dir => fs.readdirSync(path.join(OUT, dir)).filter(f => f.endsWith('.wav')).sort().map(f => ({ name: f, samples: readWav(path.join(OUT, dir, f)).samples, meta: JSON.parse(fs.readFileSync(path.join(OUT, dir, f.replace(/\.wav$/, '.json')), 'utf8')) }));

(async () => {
  const Module = await loadSherpa();
  const tokens = new Set(fs.readFileSync(path.join(require('./models.cjs').KWS_DIR, 'tokens.txt'), 'utf8').split('\n').map(l => l.split(' ')[0]));
  const valid = CANDIDATES.filter(c => (U + c).split(' ').every(t => tokens.has(t)));
  console.log('valid candidates:', valid.join(' | '), '  (dropped:', CANDIDATES.filter(c => !valid.includes(c)).join(' | ') + ')');
  const keywords = valid.map(c => `${U}${c} @${c.replace(/ /g, '_')}`).join('\n');
  const kws = makeKws(Module, keywords, { score: Number(arg('score', 1.5)), threshold: Number(arg('threshold', 0.15)) });
  const count = (items, label) => {
    const first = {}; let any = 0; const missed = [];
    for (const it of items) { const hits = spot(kws, pad(it.samples)); if (hits.length) { any++; first[hits[0]] = (first[hits[0]] || 0) + 1; } else missed.push(it.name); }
    console.log(`${label}: ${any}/${items.length} fired; first hit by label: ${JSON.stringify(first)}`);
    return missed;
  };
  const missed = count(load('buzz'), 'buzz samples');
  console.log('  missed:', missed.join(' '));
  const words = load('words'); const byText = {};
  for (const w of words) { const hits = spot(kws, pad(w.samples)); if (hits.length) byText[w.meta.text] = (byText[w.meta.text] || []).concat(hits); }
  console.log('words that fired:', JSON.stringify(byText));
  let fa = 0; let sec = 0; const which = {};
  for (const q of load('questions')) { const hits = spot(kws, pad(q.samples, 0.3, 0.5)); sec += q.samples.length / SR; for (const h of hits) { fa++; which[h] = (which[h] || 0) + 1; } }
  console.log(`question audio: ${fa} hits in ${(sec / 60).toFixed(1)} min: ${JSON.stringify(which)}`);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
