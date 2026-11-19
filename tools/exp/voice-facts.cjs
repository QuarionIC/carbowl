// Two facts about the voice model as the speech runtime runs it, checked rather than assumed:
//   1. which speaker numbers are the women's voices and which the men's (by the pitch of each);
//   2. whether a fixed "seed" makes the same sentence come out as the same audio every time.
// Usage: node tools/exp/voice-facts.cjs
'use strict';
const { loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic } = require('./models.cjs');

/** Median pitch in Hz over the voiced 10 ms frames (autocorrelation on a 16 kHz copy, 60 to 400 Hz). */
function medianPitch (samples, rate) {
  const x = resample(samples, rate, 16000);
  const W = 640; const hop = 160; const minLag = 40; const maxLag = 267;
  let peak = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const gate = (peak * 0.05) ** 2; const f0 = [];
  for (let t = 0; t + W + maxLag < x.length; t += hop) {
    let e0 = 0; for (let i = 0; i < W; i++) e0 += x[t + i] * x[t + i];
    if (e0 / W < gate) continue;
    let best = 0; let at = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0; let e1 = 0;
      for (let i = 0; i < W; i++) { num += x[t + i] * x[t + i + lag]; e1 += x[t + i + lag] * x[t + i + lag]; }
      const r = num / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best * 1.02) { best = r; at = lag; }       // the shortest lag among near-equal peaks: the pitch, not half of it
    }
    if (best >= 0.7 && at > 0) f0.push(16000 / at);
  }
  f0.sort((a, b) => a - b);
  return f0.length ? f0[f0.length >> 1] : 0;
}

(async () => {
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const say = (text, cfg) => tts.generateWithConfig(text, { sid: 0, speed: 1, numSteps: 5, ...cfg, extra: { lang: 'en', ...(cfg.extra || {}) } });
  say('Ready.', { numSteps: 3 });
  const text = 'This thinker argued that the mind is a blank slate at birth, and wrote an essay about human understanding.';
  console.log(`${tts.numSpeakers} speakers, ${tts.sampleRate} Hz`);
  for (let sid = 0; sid < tts.numSpeakers; sid++) {
    const a = say(text, { sid });
    const hz = medianPitch(a.samples, a.sampleRate);
    console.log(`speaker ${sid}: median pitch ${hz.toFixed(0)} Hz (${hz > 150 ? 'a woman\'s range' : 'a man\'s range'}), ${(a.samples.length / a.sampleRate).toFixed(2)} s`);
  }
  const same = (a, b) => { if (a.length !== b.length) return { same: false, why: `lengths ${a.length} and ${b.length}` }; let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return { same: d === 0, why: `largest difference ${d}` }; };
  const s1 = say(text, { sid: 5, extra: { seed: 1234 } }); const s2 = say(text, { sid: 5, extra: { seed: 1234 } }); const s3 = say(text, { sid: 5, extra: { seed: 99 } });
  const n1 = say(text, { sid: 5 }); const n2 = say(text, { sid: 5 });
  console.log('seed 1234 twice: ' + JSON.stringify(same(s1.samples, s2.samples)));
  console.log('seed 1234 against seed 99: ' + JSON.stringify(same(s1.samples, s3.samples)));
  console.log('no seed, twice: ' + JSON.stringify(same(n1.samples, n2.samples)));
  // Does a seeded call leave the unseeded stream alone, and does the order of calls matter?
  const s4 = say('A different sentence in between.', { sid: 5, extra: { seed: 5 } }); void s4;
  const s5 = say(text, { sid: 5, extra: { seed: 1234 } });
  console.log('seed 1234 again after another call: ' + JSON.stringify(same(s1.samples, s5.samples)));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
