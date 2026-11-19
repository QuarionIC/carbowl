// Signal measures used by the voice experiments. None of them is a listening test; they are the
// standard acoustic stand-ins for one:
//   HNR  harmonics-to-noise ratio over voiced frames (higher: cleaner, less hoarse or buzzy)
//   CPP  cepstral peak prominence (higher: clearer, more regular voice)
//   level / crest: loudness of the spoken parts, and how far the peaks stand above it
'use strict';
const { resample } = require('./sherpa-node.cjs');

const db = x => 20 * Math.log10(Math.max(1e-9, x));

function fft (re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len; const wr = Math.cos(ang); const wi = Math.sin(ang); const h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k; const b = a + h;
        const vr = re[b] * cr - im[b] * ci; const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** The worker's own clean-up (trim near-silence, peak-normalise to 0.89, short fades), for like-for-like numbers. */
function tidyLikeWorker (samples, sampleRate) {
  const n = samples.length;
  if (!n) return samples;
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak < 1e-4) return new Float32Array(0);
  const floor = peak * 0.02;
  let a = 0; let b = n - 1;
  while (a < n && Math.abs(samples[a]) < floor) a++;
  while (b > a && Math.abs(samples[b]) < floor) b--;
  const lead = Math.round(sampleRate * 0.03); const tail = Math.round(sampleRate * 0.08);
  a = Math.max(0, a - lead); b = Math.min(n - 1, b + tail);
  const out = samples.slice(a, b + 1);
  const gain = Math.min(4, 0.89 / peak);
  const fade = Math.min(out.length >> 1, Math.round(sampleRate * 0.008));
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  for (let i = 0; i < fade; i++) { const g = i / fade; out[i] *= g; out[out.length - 1 - i] *= g; }
  return out;
}

/** Loudness of the spoken parts: RMS over 20 ms frames within 30 dB of the loudest, plus peak and crest factor. */
function activeLevel (samples, sampleRate) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const e = [];
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  for (let i = 0; i + frame <= samples.length; i += frame) { let s = 0; for (let j = 0; j < frame; j++) s += samples[i + j] * samples[i + j]; e.push(s / frame); }
  if (!e.length) return { rmsDb: -120, peakDb: db(peak), crestDb: 0 };
  const top = Math.max(...e); const gate = top * 1e-3;
  const act = e.filter(x => x >= gate);
  const rms = Math.sqrt(act.reduce((x, y) => x + y, 0) / act.length);
  return { rmsDb: db(rms), peakDb: db(peak), crestDb: db(peak) - db(rms) };
}

/** HNR, CPP and voiced share (on a 16 kHz copy), and the level above 8 kHz relative to the whole (at the original rate). */
function voiceMeasures (samples, sampleRate) {
  const x = sampleRate === 16000 ? samples : resample(samples, sampleRate, 16000);
  const fs16 = 16000;
  const W = 480; const hop = 160; const minLag = 40; const maxLag = 267; // 60-400 Hz
  let peak = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  const gate = (peak * 0.03) ** 2;
  const N = 1024; const re = new Float64Array(N); const im = new Float64Array(N); const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  let frames = 0; let voiced = 0; let hnrSum = 0; let cppSum = 0; let cppN = 0;
  for (let t = 0; t + W + maxLag < x.length; t += hop) {
    let e0 = 0; for (let i = 0; i < W; i++) e0 += x[t + i] * x[t + i];
    if (e0 / W < gate) continue;
    frames++;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let num = 0; let e1 = 0;
      for (let i = 0; i < W; i++) { num += x[t + i] * x[t + i + lag]; e1 += x[t + i + lag] * x[t + i + lag]; }
      const r = num / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) best = r;
    }
    if (best < 0.5) continue;
    voiced++;
    const r = Math.min(0.999, best);
    hnrSum += 10 * Math.log10(r / (1 - r));
    // Cepstral peak prominence for this voiced frame.
    if (t + N <= x.length) {
      for (let i = 0; i < N; i++) { re[i] = x[t + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let i = 0; i < N; i++) { re[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12); im[i] = 0; }
      fft(re, im);
      const lo = Math.round(fs16 / 400); const hi = Math.round(fs16 / 60);
      let pk = -Infinity; let pkAt = lo;
      const cep = k => 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / (N * N) + 1e-12);
      for (let k = lo; k <= hi; k++) { const c = cep(k); if (c > pk) { pk = c; pkAt = k; } }
      // Regression line through the cepstrum from 1 ms upward.
      let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let m = 0;
      for (let k = 16; k <= hi + 20; k++) { const c = cep(k); sx += k; sy += c; sxx += k * k; sxy += k * c; m++; }
      const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx); const icpt = (sy - slope * sx) / m;
      cppSum += pk - (icpt + slope * pkAt); cppN++;
    }
  }
  // Share of energy above 8 kHz at the original rate (first-difference-free estimate by FFT of long frames).
  let hfDb = -120;
  if (sampleRate > 16000) {
    const M = 4096; const r2 = new Float64Array(M); const i2 = new Float64Array(M);
    let lowE = 0; let highE = 0; const cut = Math.round(8000 * M / sampleRate);
    for (let t = 0; t + M <= samples.length; t += M) {
      for (let i = 0; i < M; i++) { r2[i] = samples[t + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (M - 1))); i2[i] = 0; }
      fft(r2, i2);
      for (let k = 1; k < M / 2; k++) { const p = r2[k] * r2[k] + i2[k] * i2[k]; if (k < cut) lowE += p; else highE += p; }
    }
    hfDb = 10 * Math.log10((highE + 1e-12) / (lowE + highE + 1e-12));
  }
  return { hnr: voiced ? hnrSum / voiced : 0, cpp: cppN ? cppSum / cppN : 0, voiced: frames ? voiced / frames : 0, hfDb };
}

module.exports = { fft, db, tidyLikeWorker, activeLevel, voiceMeasures };
