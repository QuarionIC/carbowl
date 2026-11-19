// The reader's signal processing: rate conversion that removes what must not fold back, loudness
// that is the same from sentence to sentence, and volume above 1x without clipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resample, speechLevel, limit, timeScale, splitPace, finishClip, SPEECH_LEVEL, CEILING, MODEL_PACE_MAX } from '../docs/js/dsp.js';

const db = x => 20 * Math.log10(Math.max(1e-12, x));

/** Amplitude (dB re full scale) of one frequency in a signal. */
function toneLevel (x, rate, f) {
  const w = 2 * Math.PI * f / rate; const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return db(2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length);
}
function tone (rate, f, seconds = 1, amp = 0.5) {
  const x = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / rate);
  return x;
}
const middle = (x, rate) => x.slice(Math.floor(rate * 0.2), Math.floor(rate * 0.8));
function rand (seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/** Something shaped like speech: voiced syllables (harmonics under a rising and falling envelope), pauses, hissy bursts, and sharp peaks. */
function voiceLike (rate, seconds, { f0 = 140, seed = 1, amp = 0.2, spikes = 0, spike = 0.9 } = {}) {
  const r = rand(seed); const n = Math.round(rate * seconds); const x = new Float32Array(n);
  let t = Math.round(rate * 0.25);
  while (t < n - rate * 0.3) {
    const len = Math.round(rate * (0.12 + 0.25 * r())); const hiss = r() < 0.25; const a = amp * (0.5 + r());
    for (let i = 0; i < len && t + i < n; i++) {
      const env = Math.sin(Math.PI * i / len) ** 2;
      let v = 0;
      if (hiss) v = (r() * 2 - 1) * 0.6; else for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * (t + i) / rate + h) / h;
      x[t + i] += a * env * v;
    }
    t += len + Math.round(rate * 0.03 * r());
    if (r() < 0.2) t += Math.round(rate * 0.2);
  }
  for (let k = 0; k < spikes; k++) { const at = Math.floor(rate * 0.3 + r() * (n - rate * 0.6)); for (let i = 0; i < 40; i++) x[at + i] += spike * Math.exp(-i / 8) * (i % 2 ? -1 : 1); }
  return x;
}

test('rate conversion keeps what is there and leaves out what the browser lets through', () => {
  // Measured in Chromium 156 with the browser's own conversion: a 10 kHz tone played at 48 kHz
  // comes with an unwanted 13.9 kHz one at -28.8 dB, a 5 kHz tone with one at 8.9 kHz at -42.1 dB.
  for (const [f, image] of [[1000, 4900], [5000, 8900], [10000, 13900]]) {
    const y = middle(resample(tone(44100, f), 44100, 48000), 48000);
    assert.ok(Math.abs(toneLevel(y, 48000, f) - db(0.5)) < 0.05, `${f} Hz keeps its level (${toneLevel(y, 48000, f).toFixed(2)} dB)`);
    assert.ok(toneLevel(y, 48000, image) < -80, `no ${image} Hz image beside ${f} Hz (${toneLevel(y, 48000, image).toFixed(1)} dB)`);
  }
});

test('going down to a phone-call rate, nothing from above the new range folds back into it', () => {
  // The browser's own conversion turns 10 kHz into 6 kHz at -7.5 dB in a 16 kHz system (measured).
  const down16 = middle(resample(tone(44100, 10000), 44100, 16000), 16000);
  assert.ok(toneLevel(down16, 16000, 6000) < -75, `10 kHz does not come back as 6 kHz (${toneLevel(down16, 16000, 6000).toFixed(1)} dB)`);
  const down24 = middle(resample(tone(44100, 15000), 44100, 24000), 24000);
  assert.ok(toneLevel(down24, 24000, 9000) < -75, `15 kHz does not come back as 9 kHz (${toneLevel(down24, 24000, 9000).toFixed(1)} dB)`);
  const down8 = middle(resample(tone(44100, 5000), 44100, 8000), 8000);
  assert.ok(toneLevel(down8, 8000, 3000) < -75, '5 kHz does not come back as 3 kHz at 8 kHz');
  // What belongs in the new range is untouched.
  for (const [rate, f] of [[16000, 300], [16000, 3000], [16000, 6000], [24000, 9000], [8000, 2500]]) {
    const y = middle(resample(tone(44100, f), 44100, rate), rate);
    assert.ok(Math.abs(toneLevel(y, rate, f) - db(0.5)) < 0.1, `${f} Hz keeps its level at ${rate} Hz (${toneLevel(y, rate, f).toFixed(2)} dB)`);
  }
});

test('rate conversion keeps length, timing and level', () => {
  const x = new Float32Array(44100); x[22050] = 1;
  const y = resample(x, 44100, 48000);
  assert.equal(y.length, 48000);
  let at = 0; for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
  assert.equal(at, 24000, 'a click stays at the same moment');
  const flat = resample(new Float32Array(4410).fill(0.25), 44100, 16000);
  for (let i = 200; i < flat.length - 200; i++) assert.ok(Math.abs(flat[i] - 0.25) < 1e-5, 'a steady level stays that level');
  assert.equal(flat.length, 1600);
  const same = new Float32Array(10);
  assert.equal(resample(same, 48000, 48000), same, 'nothing is done when the rates already match');
  // The voice model's other rate (the plain voice is 22.05 kHz) and going up by a lot.
  const up = middle(resample(tone(22050, 3000), 22050, 48000), 48000);
  assert.ok(Math.abs(toneLevel(up, 48000, 3000) - db(0.5)) < 0.05);
  assert.ok(toneLevel(up, 48000, 19050) < -80, 'no image at 22050 - 3000 Hz');
});

test('rate pairs with no small common ratio still convert cleanly', () => {
  const y = middle(resample(tone(44100, 1000), 44100, 47999), 47999);
  assert.ok(Math.abs(toneLevel(y, 47999, 1000) - db(0.5)) < 0.05);
  // The image of 1 kHz sits at 44100 - 1000 Hz, which a 47999 Hz system would show at 47999 - 43100.
  assert.ok(toneLevel(y, 47999, 47999 - 43100) < -55, `no image near 4.9 kHz (${toneLevel(y, 47999, 47999 - 43100).toFixed(1)} dB)`);
});

test('converting a sentence takes a small fraction of the time it takes to say', () => {
  const x = voiceLike(44100, 6);
  const t0 = performance.now(); const y = resample(x, 44100, 48000); const ms = performance.now() - t0;
  assert.equal(y.length, Math.round(x.length * 48000 / 44100));
  assert.ok(ms < 1500, `6 s of speech converted in ${ms.toFixed(0)} ms`);
});

test('speech level measures the spoken parts, not the pauses', () => {
  const rate = 44100; const x = new Float32Array(rate * 3);
  for (let i = rate; i < 2 * rate; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / rate);
  const lv = speechLevel(x, rate);
  assert.ok(Math.abs(db(lv.rms) - db(0.3 / Math.SQRT2)) < 0.1, `rms ${db(lv.rms).toFixed(2)} dB`);
  assert.ok(Math.abs(lv.peak - 0.3) < 1e-3);
  assert.deepEqual(speechLevel(new Float32Array(0), rate), { rms: 0, peak: 0 });
});

test('the limiter leaves alone what already fits', () => {
  const x = voiceLike(44100, 2, { amp: 0.1 }); const before = Float32Array.from(x);
  const r = limit(x, 44100, { gain: 1, ceiling: 0.89 });
  assert.equal(r.limited, 1);
  assert.deepEqual(x, before);
});

test('the limiter never lets a sample over the ceiling, whatever comes in', () => {
  for (const seed of [1, 2, 3, 4]) {
    const x = voiceLike(48000, 3, { seed, amp: 0.35, spikes: 12 });
    const r = limit(x, 48000, { gain: 2.5, ceiling: 0.9 });
    let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak <= 0.9 + 1e-6, `peak ${peak}`);
    assert.ok(r.limited < 1);
  }
});

test('louder through the limiter is a clean louder; clipping is not', () => {
  const rate = 48000; const f = 200;
  const loud = tone(rate, f, 1, 0.8);
  limit(loud, rate, { gain: 1.5, ceiling: 0.97 });
  const y = middle(loud, rate);
  const fundamental = toneLevel(y, rate, f);
  assert.ok(Math.abs(fundamental - db(0.97)) < 0.3, `a steady tone settles just under the ceiling (${fundamental.toFixed(2)} dB)`);
  const worst = Math.max(...[2, 3, 4, 5, 7].map(h => toneLevel(y, rate, f * h)));
  assert.ok(worst - fundamental < -40, `harmonics ${(worst - fundamental).toFixed(1)} dB below the tone`);
  // The same tone clipped at the same ceiling, which is what a sound system does to samples over full scale.
  const clipped = middle(tone(rate, f, 1, 1.2).map(v => Math.max(-0.97, Math.min(0.97, v))), rate);
  assert.ok(toneLevel(clipped, rate, 3 * f) - toneLevel(clipped, rate, f) > -30, 'clipping puts a third harmonic within 30 dB of the tone');
  // A quiet passage after a loud one comes back to its own level: the turn-down is let go.
  const x = new Float32Array(rate); for (let i = 0; i < rate / 4; i++) x[i] = 0.8 * Math.sin(2 * Math.PI * f * i / rate); for (let i = rate / 2; i < rate; i++) x[i] = 0.1 * Math.sin(2 * Math.PI * f * i / rate);
  limit(x, rate, { gain: 1.5, ceiling: 0.97 });
  assert.ok(Math.abs(toneLevel(x.slice(rate * 0.75), rate, f) - db(0.15)) < 0.2);
});

test('every clip leaves at the same loudness, under the ceiling, whatever the model produced', () => {
  const levels = [];
  // Quiet and loud, low and high voices; the last three with plosive-like peaks standing 18 to 21 dB
  // above the speech, as the model's own sentences do (measured: 16.8 to 20.1 dB).
  for (const [seed, amp, f0, spike] of [[1, 0.05, 140, 0], [2, 0.2, 110, 0], [3, 0.6, 200, 0], [4, 0.1, 90, 0.25], [5, 0.3, 170, 0.9], [6, 0.04, 240, 0.12]]) {
    const raw = voiceLike(44100, 4, { seed, amp, f0, spikes: spike ? 5 : 0, spike });
    const before = Float32Array.from(raw);
    const clip = finishClip(raw, 44100);
    assert.deepEqual(raw, before, 'the input is not written to');
    const lv = speechLevel(clip.samples, clip.sampleRate);
    assert.ok(lv.peak <= CEILING + 1e-6, `peak ${lv.peak.toFixed(3)} under the ceiling`);
    levels.push(db(lv.rms));
  }
  const want = db(SPEECH_LEVEL);
  // Limiting takes a little off the measured level of the clips with sharp peaks; none is far out.
  for (const l of levels) assert.ok(Math.abs(l - want) < 0.6, `level ${l.toFixed(2)} dB against ${want.toFixed(2)} dB`);
  assert.ok(Math.max(...levels) - Math.min(...levels) < 0.8, `spread ${(Math.max(...levels) - Math.min(...levels)).toFixed(2)} dB`);
});

test('a clip with wild peaks is left a little quieter rather than pressed hard', () => {
  // Clicks standing 30 dB above the speech: bringing this to the standard loudness would mean
  // squashing them by 10 dB or more. The limiter is never asked for more than 3 dB.
  const raw = voiceLike(44100, 4, { seed: 4, amp: 0.05, spikes: 3 });
  const clip = finishClip(raw, 44100);
  const lv = speechLevel(clip.samples, clip.sampleRate);
  assert.ok(lv.peak <= CEILING + 1e-6);
  assert.ok(clip.limited >= 1 / 1.41 - 0.01, `deepest turn-down ${db(clip.limited).toFixed(1)} dB`);
  assert.ok(db(lv.rms) < db(SPEECH_LEVEL) - 1, 'quieter than standard');
});

test('a clip is trimmed, faded at both ends, and delivered at the rate asked for', () => {
  const rate = 44100;
  const raw = new Float32Array(rate * 3);
  const body = voiceLike(rate, 1.5, { seed: 9 });
  raw.set(body, rate); // one second of nothing before and half a second after
  const at = finishClip(raw, rate);
  assert.equal(at.sampleRate, rate);
  assert.ok(at.samples.length < rate * 1.5 && at.samples.length > rate * 0.9, `trimmed to ${(at.samples.length / rate).toFixed(2)} s`);
  assert.equal(at.samples[0], 0); assert.equal(at.samples[at.samples.length - 1], 0);
  const out = finishClip(raw, rate, { outRate: 48000 });
  assert.equal(out.sampleRate, 48000);
  assert.ok(Math.abs(out.samples.length / 48000 - at.samples.length / rate) < 0.002, 'the same length in seconds at the new rate');
  assert.ok(Math.abs(db(speechLevel(out.samples, 48000).rms) - db(speechLevel(at.samples, rate).rms)) < 0.3, 'and the same loudness');
  const low = finishClip(raw, rate, { outRate: 16000 });
  assert.equal(low.sampleRate, 16000);
  assert.ok(speechLevel(low.samples, 16000).peak <= CEILING + 1e-6);
  assert.equal(finishClip(new Float32Array(1000), rate).samples.length, 0, 'silence comes back empty');
  assert.equal(finishClip(new Float32Array(0), rate).samples.length, 0);
});

// ---------- pace ----------

test('a wanted pace is split into what the voice model speaks clearly and compression for the rest', () => {
  assert.equal(MODEL_PACE_MAX, 1.5);
  assert.deepEqual(splitPace(1.3), { model: 1.3, stretch: 1 });
  assert.deepEqual(splitPace(1.5), { model: 1.5, stretch: 1 });
  assert.deepEqual(splitPace(0.8), { model: 0.8, stretch: 1 });
  assert.deepEqual(splitPace(undefined), { model: 1, stretch: 1 });
  for (const want of [1.55, 1.65, 2]) {
    const p = splitPace(want);
    assert.equal(p.model, 1.5, 'the model is never asked for more than it speaks clearly');
    assert.ok(Math.abs(p.model * p.stretch - want) < 1e-12, 'the two together are the pace asked for');
  }
});

test('a change of pace shortens the clip by exactly that much and leaves pitch and level alone', () => {
  const rate = 44100;
  const x = new Float32Array(rate * 3);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 180 * i / rate) + 0.2 * Math.sin(2 * Math.PI * 1260 * i / rate);
  for (const speed of [1.1, 1.2, 4 / 3, 2]) {
    const y = timeScale(x, rate, speed);
    assert.equal(y.length, Math.round(x.length / speed));
    const mid = y.slice(Math.floor(y.length * 0.2), Math.floor(y.length * 0.8));
    assert.ok(Math.abs(toneLevel(mid, rate, 180) - db(0.5)) < 0.1, `180 Hz is still 180 Hz at its level (${toneLevel(mid, rate, 180).toFixed(2)} dB) at ${speed.toFixed(2)}x`);
    assert.ok(Math.abs(toneLevel(mid, rate, 1260) - db(0.2)) < 0.1);
    let peak = 0; for (const v of y) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 0.72, 'no build-up where the stretches overlap');
  }
  assert.equal(timeScale(x, rate, 1), x, 'nothing to do at 1x');
  const tiny = new Float32Array(1000);
  assert.equal(timeScale(tiny, rate, 1.3), tiny, 'too short to work on: left alone');
});

test('compressed speech keeps every syllable, in order, at the new spacing', () => {
  const rate = 44100; const speed = 4 / 3; // from the model's 1.5x to a 2x reading
  const x = new Float32Array(Math.round(rate * 2.8)); const starts = [];
  for (let k = 0; k < 16; k++) {
    const t = 0.2 + 0.15 * k; starts.push(t); const len = Math.round(rate * 0.06); const at = Math.round(rate * t);
    for (let i = 0; i < len; i++) { let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 200 * h * i / rate) / h; x[at + i] = 0.3 * Math.sin(Math.PI * i / len) ** 2 * v; }
  }
  const y = timeScale(x, rate, speed);
  // Loudness contour in 5 ms steps; a syllable is a stretch above a tenth of the loudest.
  const step = Math.round(rate * 0.005); const env = [];
  for (let i = 0; i + step <= y.length; i += step) { let s = 0; for (let j = 0; j < step; j++) s += y[i + j] * y[i + j]; env.push(Math.sqrt(s / step)); }
  const top = Math.max(...env); const found = [];
  for (let i = 0; i < env.length; i++) if (env[i] > top * 0.1 && (i === 0 || env[i - 1] <= top * 0.1)) found.push(i * 0.005);
  assert.equal(found.length, 16, `sixteen syllables in, ${found.length} out`);
  found.forEach((t, k) => assert.ok(Math.abs(t - starts[k] / speed) < 0.02, `syllable ${k + 1} starts at ${t.toFixed(3)} s, expected about ${(starts[k] / speed).toFixed(3)} s`));
  const loud = env.filter(v => v > top * 0.5).length * 0.005;
  assert.ok(Math.abs(loud - 16 * 0.03 / speed) < 0.12, 'and each is shorter, not cut away');
});
