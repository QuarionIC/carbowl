// Shared pieces of the sound-path measurements (see sound-path.mjs): reading and writing WAV files,
// levels, band spectra, and lining a recording up with the clip that was played.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fft } = require('./voice-measures.cjs');
export { fft };

export const db = x => 20 * Math.log10(Math.max(1e-12, x));
export const db10 = x => 10 * Math.log10(Math.max(1e-24, x));

/** @returns {{ rate: number, channels: Float32Array[] }} 16-bit integer or 32-bit float WAV */
export function readWav (file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file: ' + file);
  let at = 12; let fmt = null; let data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4); const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(at + 8), ch: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === 'data') { data = b.subarray(at + 8, Math.min(b.length, at + 8 + size)); break; }
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('no audio in ' + file);
  const bytes = fmt.bits / 8; const n = Math.floor(data.length / (bytes * fmt.ch));
  const channels = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
    const o = (i * fmt.ch + c) * bytes;
    channels[c][i] = fmt.tag === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : data.readInt32LE(o) / 2147483648;
  }
  return { rate: fmt.rate, channels };
}

export function writeWav (file, channels, rate) {
  const ch = channels.length; const n = channels[0].length;
  const b = Buffer.alloc(44 + n * ch * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * ch * 4, 28); b.writeUInt16LE(ch * 4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(n * ch * 4, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) b.writeFloatLE(channels[c][i], 44 + (i * ch + c) * 4);
  fs.writeFileSync(file, b);
}

export function rms (x, from = 0, to = x.length) {
  let s = 0; const a = Math.max(0, from); const z = Math.min(x.length, to);
  for (let i = a; i < z; i++) s += x[i] * x[i];
  return z > a ? Math.sqrt(s / (z - a)) : 0;
}

export const mid = (l, r) => { const o = new Float32Array(l.length); for (let i = 0; i < o.length; i++) o[i] = (l[i] + r[i]) / 2; return o; };
export const side = (l, r) => { const o = new Float32Array(l.length); for (let i = 0; i < o.length; i++) o[i] = (l[i] - r[i]) / 2; return o; };

export function correlation (a, b, from = 0, to = a.length) {
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = from; i < to; i++) { sab += a[i] * b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; }
  return sab / Math.sqrt(saa * sbb + 1e-30);
}

const hann = n => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

/** Average power spectrum (Welch, Hann, half overlap): Float64Array of n/2 bins, in units of amplitude squared per bin. */
export function powerSpectrum (x, n = 4096, from = 0, to = x.length) {
  const w = hann(n); const re = new Float64Array(n); const im = new Float64Array(n); const p = new Float64Array(n / 2);
  let frames = 0; let wsum = 0; for (let i = 0; i < n; i++) wsum += w[i] * w[i];
  for (let t = from; t + n <= to; t += n / 2) {
    for (let i = 0; i < n; i++) { re[i] = x[t + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) p[k] += (re[k] * re[k] + im[k] * im[k]);
    frames++;
  }
  // Scaled so that the sum over bins is the mean square of the signal.
  for (let k = 0; k < n / 2; k++) p[k] = frames ? 2 * p[k] / (frames * wsum * n) : 0;
  return p;
}

export const THIRD_OCTAVES = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

/** Level in each third-octave band, dB re full scale. */
export function bandLevels (x, rate, from = 0, to = x.length, n = 8192) {
  const p = powerSpectrum(x, n, from, to); const out = [];
  for (const fc of THIRD_OCTAVES) {
    const lo = fc / 2 ** (1 / 6); const hi = fc * 2 ** (1 / 6);
    let s = 0;
    for (let k = Math.max(1, Math.ceil(lo * n / rate)); k <= Math.min(n / 2 - 1, Math.floor(hi * n / rate)); k++) s += p[k];
    out.push(db10(s));
  }
  return out;
}

/** Short-time level, dB, one value per `ms` milliseconds. */
export function envelope (x, rate, ms = 20, from = 0, to = x.length) {
  const f = Math.max(1, Math.round(rate * ms / 1000)); const out = [];
  for (let t = from; t + f <= to; t += f) out.push(db(rms(x, t, t + f)));
  return out;
}

/**
 * Where `ref` starts inside `rec`: cross-correlation of the two by FFT, searched over the whole
 * recording. Returns the sample offset and the correlation there (1 = identical up to gain).
 */
export function locate (rec, ref, { from = 0, to = rec.length } = {}) {
  const span = to - from;
  let n = 1; while (n < span + ref.length) n <<= 1;
  const ar = new Float64Array(n); const ai = new Float64Array(n); const br = new Float64Array(n); const bi = new Float64Array(n);
  for (let i = 0; i < span; i++) ar[i] = rec[from + i];
  for (let i = 0; i < ref.length; i++) br[i] = ref[i];
  fft(ar, ai); fft(br, bi);
  // rec * conj(ref), then back (an inverse transform by conjugating twice).
  for (let k = 0; k < n; k++) { const xr = ar[k] * br[k] + ai[k] * bi[k]; const xi = ai[k] * br[k] - ar[k] * bi[k]; ar[k] = xr; ai[k] = -xi; }
  fft(ar, ai);
  let best = -Infinity; let at = 0;
  for (let i = 0; i <= span - Math.min(span, ref.length); i++) { if (ar[i] > best) { best = ar[i]; at = i; } }
  const offset = from + at;
  return { offset, corr: correlation(rec.subarray(offset, offset + ref.length), ref, 0, Math.min(ref.length, rec.length - offset)) };
}

/**
 * How one signal (y, what came out) relates to another (x, what went in), frame by frame:
 *   gainDb     level of y over x
 *   response   y over x in third-octave bands (dB), the tone the path adds
 *   coherence  share of y's power that is a fixed filtering of x (1 = nothing else was added)
 *   added      everything that is NOT a fixed filtering of x, in dB below the signal
 */
export function relate (x, y, rate, n = 2048) {
  const len = Math.min(x.length, y.length);
  const w = hann(n); const xr = new Float64Array(n); const xi = new Float64Array(n); const yr = new Float64Array(n); const yi = new Float64Array(n);
  const sxx = new Float64Array(n / 2); const syy = new Float64Array(n / 2); const cr = new Float64Array(n / 2); const ci = new Float64Array(n / 2);
  let frames = 0;
  for (let t = 0; t + n <= len; t += n / 4) {
    for (let i = 0; i < n; i++) { xr[i] = x[t + i] * w[i]; xi[i] = 0; yr[i] = y[t + i] * w[i]; yi[i] = 0; }
    fft(xr, xi); fft(yr, yi);
    for (let k = 0; k < n / 2; k++) {
      sxx[k] += xr[k] * xr[k] + xi[k] * xi[k]; syy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      cr[k] += yr[k] * xr[k] + yi[k] * xi[k]; ci[k] += yi[k] * xr[k] - yr[k] * xi[k];
    }
    frames++;
  }
  let sy = 0; let sx = 0; let explained = 0;
  const k0 = Math.ceil(80 * n / rate); const k1 = Math.floor(Math.min(16000, rate / 2 - 500) * n / rate);
  for (let k = k0; k <= k1; k++) {
    const coh = (cr[k] * cr[k] + ci[k] * ci[k]) / (sxx[k] * syy[k] + 1e-30);
    sy += syy[k]; sx += sxx[k]; explained += coh * syy[k];
  }
  const response = THIRD_OCTAVES.map(fc => {
    const lo = Math.max(1, Math.ceil(fc / 2 ** (1 / 6) * n / rate)); const hi = Math.min(n / 2 - 1, Math.floor(fc * 2 ** (1 / 6) * n / rate));
    let a = 0; let b = 0; for (let k = lo; k <= hi; k++) { a += syy[k]; b += sxx[k]; }
    return b > 0 && hi >= lo ? db10(a / b) : NaN;
  });
  const coherence = explained / (sy + 1e-30);
  return { frames, gainDb: db10(sy / (sx + 1e-30)), response, coherence, added: db10(Math.max(1e-12, 1 - coherence)) };
}

/**
 * What the path does to the waveform itself, once a fixed change of tone AND a volume that rides
 * up and down (a leveller, in several bands, frame by frame) have both been allowed for. What is
 * left is clipping, fast limiting, artefacts and added noise: the part that sounds like damage.
 * @returns {number} dB relative to what came out (more negative = cleaner)
 */
export function damage (x, y, rate, n = 1024) {
  const len = Math.min(x.length, y.length);
  const w = hann(n); const h = n / 2;
  const xr = new Float64Array(n); const xi = new Float64Array(n); const yr = new Float64Array(n); const yi = new Float64Array(n);
  const sxx = new Float64Array(h); const cr = new Float64Array(h); const ci = new Float64Array(h);
  const frames = [];
  for (let t = 0; t + n <= len; t += n / 4) {
    for (let i = 0; i < n; i++) { xr[i] = x[t + i] * w[i]; xi[i] = 0; yr[i] = y[t + i] * w[i]; yi[i] = 0; }
    fft(xr, xi); fft(yr, yi);
    for (let k = 0; k < h; k++) { sxx[k] += xr[k] * xr[k] + xi[k] * xi[k]; cr[k] += yr[k] * xr[k] + yi[k] * xi[k]; ci[k] += yi[k] * xr[k] - yr[k] * xi[k]; }
    frames.push({ xr: xr.slice(0, h), xi: xi.slice(0, h), yr: yr.slice(0, h), yi: yi.slice(0, h) });
  }
  // The fixed filter (tone and delay) that best turns x into y.
  const hr = new Float64Array(h); const hi = new Float64Array(h);
  for (let k = 0; k < h; k++) { hr[k] = cr[k] / (sxx[k] + 1e-30); hi[k] = ci[k] / (sxx[k] + 1e-30); }
  const edges = [80, 250, 500, 1000, 2000, 4000, 8000, 16000].map(f => Math.min(h - 1, Math.round(f * n / rate)));
  let err = 0; let tot = 0;
  for (const f of frames) {
    for (let b = 0; b + 1 < edges.length; b++) {
      let num = 0; let den = 0;
      const pr = []; const pi = [];
      for (let k = edges[b]; k < edges[b + 1]; k++) {
        const a = hr[k] * f.xr[k] - hi[k] * f.xi[k]; const c = hr[k] * f.xi[k] + hi[k] * f.xr[k];
        pr.push(a); pi.push(c); num += f.yr[k] * a + f.yi[k] * c; den += a * a + c * c;
      }
      const g = Math.max(0, num / (den + 1e-30));
      for (let k = edges[b], j = 0; k < edges[b + 1]; k++, j++) {
        const er = f.yr[k] - g * pr[j]; const ei = f.yi[k] - g * pi[j];
        err += er * er + ei * ei; tot += f.yr[k] * f.yr[k] + f.yi[k] * f.yi[k];
      }
    }
  }
  return db10(err / (tot + 1e-30));
}

/** Peak, how far the peak stands above the average level, and the share of samples pinned at full scale. */
export function peaks (x, from = 0, to = x.length) {
  let pk = 0; let pinned = 0;
  for (let i = from; i < to; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; if (a >= 0.985) pinned++; }
  return { peak: pk, crestDb: db(pk) - db(rms(x, from, to)), pinned: pinned / Math.max(1, to - from) };
}

export const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
export const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / Math.max(1, a.length - 1)); };
export const se = a => sd(a) / Math.sqrt(a.length || 1);
export const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
