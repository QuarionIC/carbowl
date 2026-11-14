// Shared helpers for running the sherpa-onnx browser runtime under Node for experiments.
// The same .wasm file ships in the web app, so model behaviour measured here carries over;
// timing on a phone will differ.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DL = path.join(ROOT, 'downloads');
const ASSETS = path.join(DL, 'sherpa_onnx_web', 'assets');
const OUT = path.join(DL, 'out');

async function loadSherpa ({ verbose = false } = {}) {
  const factory = require(path.join(ASSETS, 'sherpa-onnx-wasm-web.js'));
  const logs = [];
  const Module = await factory({
    locateFile: f => path.join(ASSETS, f),
    print: s => { logs.push(String(s)); if (verbose) console.log('[wasm] ' + s); },
    printErr: s => { logs.push(String(s)); if (verbose) console.error('[wasm] ' + s); }
  });
  Module.__logs = logs;
  return Module;
}

function putFile (Module, src, dst) {
  const dir = path.posix.dirname(dst);
  if (dir && dir !== '/' && dir !== '.') { try { Module.FS.mkdirTree(dir); } catch (e) { /* exists */ } }
  Module.FS.writeFile(dst, fs.readFileSync(src));
}

function writeWav (file, samples, sampleRate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

function readWav (file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file: ' + file);
  let pos = 12; let fmt = null; let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') { data = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size)); break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('bad WAV: ' + file);
  const frames = Math.floor(data.length / (fmt.bits / 8) / fmt.channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * (fmt.bits / 8);
      acc += fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 32 && fmt.format === 3 ? data.readFloatLE(o) : fmt.bits === 32 ? data.readInt32LE(o) / 2147483648 : (data.readUInt8(o) - 128) / 128;
    }
    out[i] = acc / fmt.channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** Band-limited resampling (windowed sinc); quality matters more than speed here. */
function resample (samples, from, to) {
  if (from === to) return samples;
  const ratio = to / from;
  const n = Math.floor(samples.length * ratio);
  const out = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.95;
  const half = 16;
  for (let i = 0; i < n; i++) {
    const center = i / ratio;
    const lo = Math.max(0, Math.ceil(center - half / cutoff)); const hi = Math.min(samples.length - 1, Math.floor(center + half / cutoff));
    let acc = 0; let norm = 0;
    for (let j = lo; j <= hi; j++) {
      const x = (j - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos(Math.PI * (j - center) * cutoff / half);
      const k = sinc * w;
      acc += samples[j] * k; norm += k;
    }
    out[i] = norm ? acc / norm : 0;
  }
  return out;
}

function rms (samples) { let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]; return Math.sqrt(s / Math.max(1, samples.length)); }

/** Deterministic PRNG so experiments repeat exactly. */
function mulberry32 (seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Road-like noise: brown noise plus a little wide-band hiss, normalised to unit RMS. */
function roadNoise (n, rand) {
  const out = new Float32Array(n);
  let b = 0; let lp = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    b = 0.985 * b + 0.12 * w;           // strong low-frequency rumble
    lp = 0.7 * lp + 0.3 * w;            // mid-band hiss (tyres, wind)
    out[i] = b + 0.25 * lp + 0.05 * w;
  }
  const r = rms(out) || 1;
  for (let i = 0; i < n; i++) out[i] /= r;
  return out;
}

/** Mixes noise into speech at the given signal-to-noise ratio (dB, relative to the speech RMS). */
function addNoise (speech, snrDb, rand) {
  const noise = roadNoise(speech.length, rand);
  const active = rmsActive(speech);
  const g = active / Math.pow(10, snrDb / 20);
  const out = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) out[i] = speech[i] + g * noise[i];
  return out;
}

/** RMS over the louder half of 20 ms frames, so leading/trailing silence does not dilute it. */
function rmsActive (samples, sampleRate = 16000) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const e = [];
  for (let i = 0; i + frame <= samples.length; i += frame) { let s = 0; for (let j = 0; j < frame; j++) s += samples[i + j] * samples[i + j]; e.push(s / frame); }
  if (!e.length) return rms(samples);
  e.sort((a, b) => b - a);
  const top = e.slice(0, Math.max(1, e.length >> 1));
  return Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length);
}

module.exports = { ROOT, DL, ASSETS, OUT, loadSherpa, putFile, writeWav, readWav, resample, rms, rmsActive, mulberry32, roadNoise, addNoise };
