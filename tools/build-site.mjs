// Assembles third-party runtime and model files from downloads/ into docs/ so the site folder is
// self-contained and can be served as-is (GitHub Pages).
//   - copies the sherpa-onnx browser runtime and lowers its initial memory reservation
//   - copies the phonemizer bundle and the speech models
//   - splits files larger than 45 MB into parts (GitHub rejects files over 100 MB)
//   - writes docs/models/manifest.json with exact sizes for the in-app downloader
// Usage: node tools/build-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DL = path.join(ROOT, 'downloads');
const SITE = path.join(ROOT, 'docs');
const WITH_PIPER = process.argv.includes('--with-piper'); // the Piper voice needs the GPL-licensed espeak-ng phonemizer; left out by default
const PART_BYTES = 45 * 1024 * 1024;
const INITIAL_PAGES = 1024; // 64 MiB; the runtime grows its memory on demand (maximum stays 2 GiB)

const rel = p => path.relative(SITE, p).split(path.sep).join('/');
function copy (src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return dst; }

/** Rewrites the "initial pages" field of the wasm memory section in place (same byte length). */
function patchInitialMemory (buf, pages) {
  let pos = 8;
  const leb = () => { let r = 0; let s = 0; let b; do { b = buf[pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  while (pos < buf.length) {
    const id = buf[pos++]; const size = leb(); const start = pos;
    if (id === 5) {
      const count = leb(); if (count !== 1) throw new Error('expected exactly one memory');
      const flags = buf[pos++]; const at = pos; const initial = leb(); const len = pos - at;
      const max = (flags & 1) ? leb() : null;
      if (max === null) throw new Error('memory has no maximum; refusing to shrink the initial size');
      if (pages > initial) throw new Error('refusing to raise initial memory');
      // Encode `pages` as LEB128 padded to the original length so no offsets shift.
      const enc = []; let v = pages;
      for (let i = 0; i < len; i++) { let byte = v & 0x7f; v = Math.floor(v / 128); if (i < len - 1) byte |= 0x80; enc.push(byte); }
      if (v !== 0) throw new Error('value does not fit');
      for (let i = 0; i < len; i++) buf[at + i] = enc[i];
      return { was: initial, now: pages, max };
    }
    pos = start + size;
  }
  throw new Error('no memory section found');
}

const manifest = { generated: new Date().toISOString().slice(0, 10), bundles: {} };
function addFile (bundle, src, dstRel) {
  const size = fs.statSync(src).size;
  const entry = { path: dstRel, size };
  const dstAbs = path.join(SITE, dstRel);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  // Remove stale copies (whole file or parts) before writing.
  for (const f of fs.readdirSync(path.dirname(dstAbs))) if (f === path.basename(dstAbs) || f.startsWith(path.basename(dstAbs) + '.part')) fs.rmSync(path.join(path.dirname(dstAbs), f));
  if (size > PART_BYTES) {
    const data = fs.readFileSync(src); entry.parts = [];
    for (let i = 0, n = 0; i < size; i += PART_BYTES, n++) {
      const partRel = `${dstRel}.part${n}`;
      fs.writeFileSync(path.join(SITE, partRel), data.subarray(i, Math.min(size, i + PART_BYTES)));
      entry.parts.push({ path: partRel, size: Math.min(size, i + PART_BYTES) - i });
    }
  } else fs.copyFileSync(src, dstAbs);
  entry.sha256 = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16);
  (manifest.bundles[bundle] ||= { files: [], bytes: 0 }).files.push(entry);
  manifest.bundles[bundle].bytes += size;
}

// 1. Runtime.
const assets = path.join(DL, 'sherpa_onnx_web', 'assets');
const vendor = path.join(SITE, 'vendor', 'sherpa');
for (const f of ['sherpa-onnx-wasm-web.js', 'sherpa-onnx-asr.js', 'sherpa-onnx-tts.js', 'sherpa-onnx-vad.js']) copy(path.join(assets, f), path.join(vendor, f));
copy(path.join(DL, 'sherpa_onnx_web', 'LICENSE'), path.join(vendor, 'LICENSE'));
const wasm = fs.readFileSync(path.join(assets, 'sherpa-onnx-wasm-web.wasm'));
const patched = patchInitialMemory(wasm, INITIAL_PAGES);
fs.writeFileSync(path.join(vendor, 'sherpa-onnx-wasm-web.wasm'), wasm);
console.log(`runtime: initial memory ${patched.was / 16} MiB -> ${patched.now / 16} MiB (max ${patched.max / 16} MiB)`);
manifest.bundles.runtime = { files: [{ path: 'vendor/sherpa/sherpa-onnx-wasm-web.wasm', size: wasm.length }], bytes: wasm.length };

// 2. Voice activity detection.
addFile('vad', path.join(DL, 'silero-vad', 'silero_vad.onnx'), 'models/vad/silero_vad.onnx');

// 3. Recognition models.
for (const [bundle, dir] of [['asr-moonshine-tiny', 'asr-moonshine-tiny-en/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27'], ['asr-moonshine-base', 'asr-moonshine-base-en/sherpa-onnx-moonshine-base-en-quantized-2026-02-27']]) {
  const src = path.join(DL, dir);
  if (!fs.existsSync(src)) { console.log('skip (not downloaded):', bundle); continue; }
  for (const f of ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt']) addFile(bundle, path.join(src, f), `models/${bundle}/${f}`);
  copy(path.join(src, 'LICENSE'), path.join(SITE, 'models', bundle, 'LICENSE'));
}

// 4. Voices.
const supertonic = path.join(DL, 'tts-supertonic-int8', 'sherpa-onnx-supertonic-tts-int8-2026-03-06');
if (fs.existsSync(supertonic)) {
  for (const f of ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin']) addFile('tts-supertonic', path.join(supertonic, f), `models/tts-supertonic/${f}`);
  copy(path.join(supertonic, 'LICENSE'), path.join(SITE, 'models', 'tts-supertonic', 'LICENSE'));
}
const lessac = path.join(DL, 'tts-lessac-medium-int8', 'vits-piper-en_US-lessac-medium-int8');
if (WITH_PIPER && fs.existsSync(lessac)) {
  addFile('tts-piper-lessac', path.join(lessac, 'en_US-lessac-medium.onnx'), 'models/tts-piper-lessac/model.onnx');
  addFile('tts-piper-lessac', path.join(lessac, 'tokens.txt'), 'models/tts-piper-lessac/tokens.txt');
  copy(path.join(lessac, 'MODEL_CARD'), path.join(SITE, 'models', 'tts-piper-lessac', 'MODEL_CARD'));
}

// 5. Phonemizer (needed by the Piper voice only).
const pp = path.join(DL, 'piper-phonemize', 'browser');
if (WITH_PIPER && fs.existsSync(pp)) {
  for (const f of ['piper-phonemize.js', 'piper-phonemize-wasm-main.js']) copy(path.join(pp, f), path.join(SITE, 'vendor', 'piper-phonemize', f));
  addFile('phonemizer', path.join(pp, 'piper-phonemize-wasm-main.wasm'), 'vendor/piper-phonemize/piper-phonemize-wasm-main.wasm');
  addFile('phonemizer', path.join(pp, 'piper-phonemize-wasm-main.data'), 'vendor/piper-phonemize/piper-phonemize-wasm-main.data');
}

if (!WITH_PIPER) { fs.rmSync(path.join(SITE, 'models', 'tts-piper-lessac'), { recursive: true, force: true }); fs.rmSync(path.join(SITE, 'vendor', 'piper-phonemize'), { recursive: true, force: true }); }
fs.mkdirSync(path.join(SITE, 'models'), { recursive: true });
fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
fs.writeFileSync(path.join(SITE, 'models', 'manifest.json'), JSON.stringify(manifest, null, 1));
for (const [name, b] of Object.entries(manifest.bundles)) console.log(`${name.padEnd(22)} ${(b.bytes / 1048576).toFixed(1).padStart(7)} MB  ${b.files.map(f => path.basename(f.path) + (f.parts ? ` (${f.parts.length} parts)` : '')).join(', ')}`);
let total = 0; let biggest = 0;
const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { const s = fs.statSync(p).size; total += s; biggest = Math.max(biggest, s); } } };
walk(SITE);
console.log(`site total ${(total / 1048576).toFixed(1)} MB; largest file ${(biggest / 1048576).toFixed(1)} MB`);
