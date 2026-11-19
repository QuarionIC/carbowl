/* Signal processing for the reader's voice, shared by the speech worker (which loads this file with
 * importScripts) and the page (through ../dsp.js, which hands the same functions out as a module).
 * Samples in, samples out: nothing here touches the page or the sound system, so all of it can be
 * tested as plain code.
 *
 * Why it exists. The voice model produces 44.1 kHz audio; the sound system runs at whatever rate
 * the output device has (48 kHz on most computers and phones, 16 or 24 kHz on a car or headset
 * link while the microphone is open). Left to the browser, the conversion is done by drawing
 * straight lines between samples, with no filtering: measured in Chromium, a 10 kHz component
 * played into a 16 kHz system comes out as a 6 kHz one at nearly full strength. Speech then
 * sounds harsh and lispy. So the conversion is done here, properly, and the browser is always
 * handed audio already at its own rate.
 */
(function (root) {
  'use strict';

  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

  /** Zeroth-order modified Bessel function of the first kind (for the Kaiser window). */
  function besselI0 (x) {
    let sum = 1; let term = 1; const q = x * x / 4;
    for (let k = 1; k < 60; k++) { term *= q / (k * k); sum += term; if (term < 1e-13 * sum) break; }
    return sum;
  }

  const BETA = 9;            // Kaiser window: about 90 dB between what is kept and what is removed
  const MAX_PHASES = 1024;   // rate pairs with no small common ratio fall back to the nearest of this many steps
  const banks = new Map();

  /**
   * The filter for one pair of rates: for each of `phases` positions of an output sample between
   * two input samples, `taps` weights for the input samples around it.
   */
  function filterBank (from, to, zeros) {
    const key = `${from}>${to}/${zeros}`;
    let bank = banks.get(key);
    if (bank) return bank;
    const g = gcd(from, to);
    const up = to / g; const down = from / g;
    const exact = up <= MAX_PHASES;
    const phases = exact ? up : MAX_PHASES;
    // Everything below this share of the input's top frequency is kept. Going down in rate, the top
    // of the new range is what limits it; a little is given away at the edge so that nothing folds back.
    const cutoff = Math.min(1, to / from) * 0.94;
    const half = Math.ceil(zeros / cutoff);
    const taps = 2 * half;
    const table = new Float32Array(phases * taps);
    const i0 = besselI0(BETA);
    for (let p = 0; p < phases; p++) {
      const frac = p / phases; let sum = 0;
      for (let j = 0; j < taps; j++) {
        const u = (j - half + 1) - frac;                 // distance from the output instant, in input samples
        const x = u * cutoff;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const r = u / half;
        const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0;
        const v = sinc * w; table[p * taps + j] = v; sum += v;
      }
      for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;   // a steady level stays exactly that level
    }
    bank = { up, down, exact, phases, taps, half, table };
    banks.set(key, bank);
    if (banks.size > 12) banks.delete(banks.keys().next().value);
    return bank;
  }

  /**
   * Band-limited sample-rate conversion (windowed-sinc, polyphase).
   * @param {Float32Array} samples @param {number} from rate of `samples` @param {number} to wanted rate
   * @returns {Float32Array} the same array when the rates are equal
   */
  function resample (samples, from, to, { zeros = 16 } = {}) {
    from = Math.round(from); to = Math.round(to);
    if (!(from > 0) || !(to > 0) || from === to || !samples.length) return samples;
    const { up, down, exact, phases, taps, half, table } = filterBank(from, to, zeros);
    const n = samples.length;
    const outLen = Math.max(1, Math.round(n * to / from));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let n0; let p;
      if (exact) { const num = i * down; n0 = Math.floor(num / up); p = num - n0 * up; } else {
        const pos = i * from / to; n0 = Math.floor(pos); p = Math.round((pos - n0) * phases);
        if (p >= phases) { p = 0; n0++; }
      }
      const base = p * taps; const first = n0 - half + 1;
      let acc = 0;
      if (first >= 0 && first + taps <= n) {
        for (let j = 0; j < taps; j++) acc += samples[first + j] * table[base + j];
      } else {
        const lo = Math.max(0, -first); const hi = Math.min(taps, n - first);
        for (let j = lo; j < hi; j++) acc += samples[first + j] * table[base + j];
      }
      out[i] = acc;
    }
    return out;
  }

  /**
   * How loud the spoken parts are: RMS over the 20 ms frames within 30 dB of the loudest one (so
   * pauses and the quiet ends do not count), and the highest peak.
   * @returns {{ rms: number, peak: number }}
   */
  function speechLevel (samples, rate) {
    const n = samples.length;
    let peak = 0; let total = 0;
    for (let i = 0; i < n; i++) { const v = samples[i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; total += v * v; }
    if (!n) return { rms: 0, peak: 0 };
    const frame = Math.max(1, Math.round(rate * 0.02));
    const count = Math.floor(n / frame);
    if (count < 2) return { rms: Math.sqrt(total / n), peak };
    const energy = new Float64Array(count); let top = 0;
    for (let f = 0; f < count; f++) { let s = 0; const at = f * frame; for (let j = 0; j < frame; j++) s += samples[at + j] * samples[at + j]; energy[f] = s / frame; if (energy[f] > top) top = energy[f]; }
    const gate = top * 1e-3; let sum = 0; let used = 0;
    for (let f = 0; f < count; f++) if (energy[f] >= gate) { sum += energy[f]; used++; }
    return { rms: used ? Math.sqrt(sum / used) : 0, peak };
  }

  /**
   * Multiplies by `gain` and keeps every sample within ±`ceiling`, in place. Peaks that would go
   * over are turned down smoothly: the gain starts falling `lookaheadMs` before a peak, is exactly
   * low enough when the peak arrives, and comes back over `releaseMs`. Unlike clipping (which is
   * what a sound system does to samples over full scale) this adds no harshness.
   * @returns {{ samples: Float32Array, limited: number }} limited: the deepest turn-down, as a factor (1 = untouched)
   */
  function limit (samples, rate, { gain = 1, ceiling = 0.89, lookaheadMs = 3, releaseMs = 80 } = {}) {
    const n = samples.length;
    let over = false;
    if (gain !== 1) { for (let i = 0; i < n; i++) { const v = samples[i] * gain; samples[i] = v; if (v > ceiling || v < -ceiling) over = true; } } else { for (let i = 0; i < n; i++) { const v = samples[i]; if (v > ceiling || v < -ceiling) { over = true; break; } } }
    if (!over) return { samples, limited: 1 };
    const L = Math.max(1, Math.round(rate * lookaheadMs / 1000));
    // The gain each sample needs, spread back over the samples leading up to it.
    const need = new Float32Array(n).fill(1);
    let deepest = 1;
    for (let i = 0; i < n; i++) {
      const a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a <= ceiling) continue;
      const want = ceiling / a;
      if (want < deepest) deepest = want;
      for (let j = Math.max(0, i - L); j <= i; j++) if (need[j] > want) need[j] = want;
    }
    // Release: once past a peak the gain climbs back gradually (never above what the next peak needs).
    const keep = Math.exp(-1 / (rate * releaseMs / 1000));
    let g = 1;
    for (let i = 0; i < n; i++) { g = 1 - (1 - g) * keep; if (need[i] < g) g = need[i]; need[i] = g; }
    // Attack: a running mean over the look-ahead window turns each step down into a ramp that ends
    // on the peak. Every value averaged is already low enough for that peak, so the mean is too.
    let sum = 0;
    const win = L + 1;
    const ring = new Float32Array(win).fill(1); sum = win;
    for (let i = 0; i < n; i++) {
      const k = i % win; sum += need[i] - ring[k]; ring[k] = need[i];
      samples[i] *= sum / win;
    }
    // Rounding in the running mean can leave a sample a hair over; never let that through.
    for (let i = 0; i < n; i++) { if (samples[i] > ceiling) samples[i] = ceiling; else if (samples[i] < -ceiling) samples[i] = -ceiling; }
    return { samples, limited: deepest };
  }

  /**
   * Changes the pace of speech without changing its pitch (waveform-similarity overlap-add): short
   * stretches of the input are laid over one another at a new spacing, each shifted by up to a few
   * milliseconds to where its waveform lines up with what came before, so that no beat or echo is
   * heard at the joins.
   * @param {number} speed above 1 is faster (1.5: the same words in two thirds of the time)
   * @returns {Float32Array} the same array when there is nothing to do
   */
  function timeScale (samples, rate, speed, { frameMs = 40, tolMs = 10 } = {}) {
    const n = samples.length;
    const N = 2 * Math.round(rate * frameMs / 2000);   // the length of each stretch
    if (!(speed > 0) || Math.abs(speed - 1) < 0.004 || n < 3 * N) return samples;
    const hop = N / 2;                               // spacing in the output
    const tol = Math.round(rate * tolMs / 1000);       // how far early or late a stretch may be taken
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N);
    const outLen = Math.max(N, Math.round(n / speed));
    const out = new Float32Array(outLen);
    const frames = Math.max(1, Math.ceil((outLen - N) / hop) + 1);
    const last = n - N;
    let prev = 0;
    const STEP = 3;                                  // the search looks at every third sample first
    for (let k = 0; k < frames; k++) {
      let pos = 0;
      if (k > 0) {
        const target = Math.min(last, Math.round(k * hop * speed));
        const natural = prev + hop;                  // where the input itself carries on from the last stretch
        if (natural > last) pos = target; else {
          const lo = Math.max(0, target - tol); const hi = Math.min(last, target + tol);
          let best = -Infinity; let at = target;
          for (let c = lo; c <= hi; c += STEP) {
            let dot = 0; let e = 1e-9;
            for (let i = 0; i < N; i += STEP) { const v = samples[c + i]; dot += samples[natural + i] * v; e += v * v; }
            const score = dot / Math.sqrt(e);
            if (score > best) { best = score; at = c; }
          }
          const lo2 = Math.max(lo, at - STEP + 1); const hi2 = Math.min(hi, at + STEP - 1);
          best = -Infinity; let fine = at;
          for (let c = lo2; c <= hi2; c++) {
            let dot = 0; let e = 1e-9;
            for (let i = 0; i < N; i++) { const v = samples[c + i]; dot += samples[natural + i] * v; e += v * v; }
            const score = dot / Math.sqrt(e);
            if (score > best) { best = score; fine = c; }
          }
          pos = fine;
        }
      }
      const o = k * hop;
      const count = Math.min(N, outLen - o);
      // The very first half stretch has nothing fading out under it: take it as it is.
      if (k === 0) { for (let i = 0; i < Math.min(hop, count); i++) out[i] = samples[i]; for (let i = hop; i < count; i++) out[i] += samples[i] * win[i]; } else for (let i = 0; i < count; i++) out[o + i] += samples[pos + i] * win[i];
      prev = pos;
    }
    return out;
  }

  // The fastest the voice model itself is asked to speak. Measured on real question sentences (see
  // the README): up to 1.5x its speech is as clear as at its normal pace; at 1.65x a recogniser
  // mishears twice as many words and at 2x eight times as many, because the model starts to drop
  // and slur sounds. Any pace above this is reached by having the model speak at this pace and
  // compressing the result in time, which keeps every sound and only shortens it.
  const MODEL_PACE_MAX = 1.5;

  /** Splits a wanted pace into the pace asked of the voice model and the compression applied to what it says. */
  function splitPace (speed) {
    const want = speed > 0 ? speed : 1;
    const model = Math.min(want, MODEL_PACE_MAX);
    return { model, stretch: want / model };
  }

  // The level every piece of speech is brought to (RMS of the spoken parts, -19 dB below full
  // scale) and the highest any sample may go. Sentences used to be set by their single loudest
  // peak, which left some of them 3 dB quieter than their neighbours.
  const SPEECH_LEVEL = 0.1122;
  const CEILING = 0.89;
  const MAX_PRESS = 1.41;    // the limiter is never asked for more than 3 dB; a sentence with wilder peaks is left a little quieter instead

  /**
   * Finishes a freshly generated clip: trims near-silence at both ends (keeping a short margin),
   * brings the speech to the standard loudness, fades the ends, and converts to the output rate.
   * @param {Float32Array} samples @param {number} rate
   * @param {{ outRate?: number, level?: number, ceiling?: number }} [o]
   * @returns {{ samples: Float32Array, sampleRate: number, gain: number, limited: number }}
   */
  function finishClip (samples, rate, { outRate = 0, level = SPEECH_LEVEL, ceiling = CEILING } = {}) {
    const empty = { samples: new Float32Array(0), sampleRate: outRate || rate, gain: 1, limited: 1 };
    const n = samples.length;
    if (!n) return empty;
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > peak) peak = a; }
    if (peak < 1e-4) return empty;
    const floor = peak * 0.02;
    let a = 0; let b = n - 1;
    while (a < n && Math.abs(samples[a]) < floor) a++;
    while (b > a && Math.abs(samples[b]) < floor) b--;
    a = Math.max(0, a - Math.round(rate * 0.03)); b = Math.min(n - 1, b + Math.round(rate * 0.08));
    let out = samples.slice(a, b + 1);
    let sr = rate;
    if (outRate && outRate !== rate) { out = resample(out, rate, outRate); sr = outRate; }
    const lv = speechLevel(out, sr);
    let gain = lv.rms > 0 ? level / lv.rms : 1;
    if (gain * lv.peak > ceiling * MAX_PRESS) gain = ceiling * MAX_PRESS / lv.peak;
    gain = Math.min(8, gain);
    const { limited } = limit(out, sr, { gain, ceiling });
    const fade = Math.min(out.length >> 1, Math.round(sr * 0.008));
    for (let i = 0; i < fade; i++) { const f = i / fade; out[i] *= f; out[out.length - 1 - i] *= f; }
    return { samples: out, sampleRate: sr, gain, limited };
  }

  root.CarbowlDsp = { resample, speechLevel, limit, timeScale, splitPace, finishClip, SPEECH_LEVEL, CEILING, MODEL_PACE_MAX };
})(typeof globalThis !== 'undefined' ? globalThis : self);
