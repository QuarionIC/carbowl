/* Listening worker: receives 16 kHz microphone audio, finds utterances with a voice-activity
 * detector, transcribes each with an on-device recogniser, and reports them. It does not decide
 * what an utterance means; the game does.
 *
 * Messages in:  { type: 'init', base, manifest, asr: 'moonshine-base' | 'moonshine-tiny', vadThreshold }
 *               { type: 'port', port }                 audio frames { samples: Float32Array, t } arrive on the port
 *               { type: 'mode', mode: 'off' | 'spot' | 'answer', id, since? }
 *                    spot   = short end-of-speech pause (0.3 s): quick reaction to a single word
 *                    answer = longer pause (0.8 s): lets a spoken answer finish
 *                    since  = microphone time (seconds) from which audio should be re-examined
 *               { type: 'feed', samples, t }            test hook: same as a frame on the port
 *               { type: 'transcribe', id, samples }     one-off transcription (self-tests)
 * Messages out: { type: 'ready', asr, heapMiB, initMs }
 *               { type: 'speechstart', modeId, t }      speech has lasted about a quarter second
 *               { type: 'speechend', modeId, t, dropped }
 *               { type: 'utterance', modeId, text, start, end, dur, level, asrMs, t }
 *               { type: 'level', rms, peak, speaking, t }   about ten times a second
 *               { type: 'transcript', id, text, asrMs } | { type: 'error', error } | { type: 'log', text }
 * All times are AudioContext seconds as stamped on the frames by the capture worklet.
 */
/* global importScripts, loadBundle, unlinkAll, startRuntime, heapMiB, describeError, OfflineRecognizer, createVad */
'use strict';
importScripts('common.js');

const SR = 16000;
const WIN = 512;
const RING = SR * 40;
const PAD_BEFORE = Math.round(0.25 * SR);
const PAD_AFTER = Math.round(0.1 * SR);
const ONSET_WINDOWS = 7; // about 0.22 s of continuous speech before "speechstart" is reported

let runtime = null;
let rec = null;
const vads = { spot: null, answer: null };
let mode = 'off';
let modeId = 0;

const ring = new Float32Array(RING);
let total = 0;               // samples received so far
let lastT = 0;               // AudioContext time of the newest sample
let carry = new Float32Array(0);
let vad = null;
let vadBase = 0;             // global sample index at which the active detector was last reset
let detectedRun = 0;
let reportedStart = false;
let levelAcc = 0; let levelPeak = 0; let levelN = 0;
let busy = false;            // true while a transcription blocks the thread; frames queue up meanwhile

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = text => post({ type: 'log', text });
const timeOf = sample => lastT - (total - sample) / SR;
const sampleAt = t => Math.round(total - (lastT - t) * SR);

function ringSlice (from, to) {
  from = Math.max(from, total - RING + 1, 0); to = Math.min(to, total);
  const n = Math.max(0, to - from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[(from + i) % RING];
  return out;
}

function transcribe (samples, sampleRate = SR) {
  const stream = rec.createStream();
  try {
    stream.acceptWaveform(sampleRate, samples);
    rec.decode(stream);
    return String(rec.getResult(stream).text || '').trim();
  } finally { stream.free(); }
}

function makeVad (path, threshold, minSilence, minSpeech, maxSpeech) {
  return createVad(runtime, {
    sileroVad: { model: path, threshold, minSilenceDuration: minSilence, minSpeechDuration: minSpeech, maxSpeechDuration: maxSpeech, windowSize: WIN },
    tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
    sampleRate: SR, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 60
  });
}

async function init ({ base, manifest, asr, vadThreshold }) {
  const t0 = Date.now();
  runtime = await startRuntime(base, log, manifest);
  importScripts(new URL('vendor/sherpa/sherpa-onnx-asr.js', base).href, new URL('vendor/sherpa/sherpa-onnx-vad.js', base).href);
  const bundle = manifest.bundles['asr-' + asr];
  if (!bundle) throw new Error('recognition model not available: ' + asr);
  const p = await loadBundle(runtime, base, bundle, '/asr');
  rec = new OfflineRecognizer({
    modelConfig: { moonshine: { preprocessor: '', encoder: p['encoder_model.ort'], uncachedDecoder: '', cachedDecoder: '', mergedDecoder: p['decoder_model_merged.ort'] }, tokens: p['tokens.txt'], numThreads: 1, provider: 'cpu', debug: 0, modelingUnit: '', bpeVocab: '' },
    decodingMethod: 'greedy_search'
  }, runtime);
  if (!rec.handle) throw new Error('the recognition model failed to load');
  unlinkAll(runtime, p, ['tokens.txt']);
  const v = await loadBundle(runtime, base, manifest.bundles.vad, '/vad');
  const th = vadThreshold || 0.5;
  vads.spot = makeVad(v['silero_vad.onnx'], th, 0.3, 0.1, 8);
  vads.answer = makeVad(v['silero_vad.onnx'], th, 0.8, 0.1, 14);
  if (!vads.spot.handle || !vads.answer.handle) throw new Error('the voice-activity model failed to load');
  try { transcribe(new Float32Array(SR)); } catch (e) { log('warm-up failed: ' + describeError(e, runtime)); }
  post({ type: 'ready', asr, heapMiB: heapMiB(runtime), initMs: Date.now() - t0 });
}

function setMode (m) {
  mode = m.mode; modeId = m.id || 0;
  vad = vads[mode] || null;
  carry = new Float32Array(0);
  detectedRun = 0; reportedStart = false;
  if (!vad) return;
  vad.reset(); vad.clear();
  vadBase = total;
  // Re-examine recent audio: after a buzz the answer may already be under way.
  if (typeof m.since === 'number') {
    const from = Math.max(sampleAt(m.since), total - SR * 12, total - RING + 1, 0);
    if (from < total) { const past = ringSlice(from, total); vadBase = from; runVad(past); }
  }
}

function emitSegment (seg) {
  const start = vadBase + seg.start;
  const end = start + seg.samples.length;
  const audio = ringSlice(start - PAD_BEFORE, end + PAD_AFTER);
  let sum = 0;
  for (let i = 0; i < seg.samples.length; i++) sum += seg.samples[i] * seg.samples[i];
  const t0 = performance.now();
  let text = '';
  try { text = transcribe(audio.length ? audio : seg.samples); } catch (e) { log('transcription failed: ' + describeError(e, runtime)); }
  post({ type: 'utterance', modeId, text, start: timeOf(start), end: timeOf(end), dur: seg.samples.length / SR, level: Math.sqrt(sum / Math.max(1, seg.samples.length)), asrMs: Math.round(performance.now() - t0), t: lastT });
}

function runVad (samples) {
  let buf = samples;
  if (carry.length) { buf = new Float32Array(carry.length + samples.length); buf.set(carry); buf.set(samples, carry.length); }
  let i = 0;
  const id = modeId;
  for (; i + WIN <= buf.length; i += WIN) {
    vad.acceptWaveform(buf.subarray(i, i + WIN));
    const detected = vad.isDetected();
    if (detected) {
      detectedRun++;
      if (detectedRun === ONSET_WINDOWS && !reportedStart) { reportedStart = true; post({ type: 'speechstart', modeId, t: lastT }); }
    } else if (detectedRun > 0) {
      const hadSegment = !vad.isEmpty();
      if (reportedStart || !hadSegment) post({ type: 'speechend', modeId, t: lastT, dropped: !hadSegment });
      detectedRun = 0; reportedStart = false;
    }
    while (!vad.isEmpty()) {
      const seg = vad.front(); vad.pop();
      emitSegment(seg);
      if (modeId !== id || !vad) return; // the mode changed while we were transcribing
    }
  }
  carry = buf.slice(i);
}

function onFrame (samples, t) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    ring[(total + i) % RING] = v;
    levelAcc += v * v; const a = v < 0 ? -v : v; if (a > levelPeak) levelPeak = a;
  }
  total += n; lastT = t; levelN += n;
  if (levelN >= SR / 10) {
    post({ type: 'level', rms: Math.sqrt(levelAcc / levelN), peak: levelPeak, speaking: detectedRun > 0, t });
    levelAcc = 0; levelPeak = 0; levelN = 0;
  }
  if (vad && rec && !busy) {
    busy = true;
    try { runVad(samples); } catch (e) { post({ type: 'error', error: describeError(e, runtime) }); } finally { busy = false; }
  }
}

self.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'init': init(m).catch(err => post({ type: 'error', error: describeError(err, runtime), fatal: true })); break;
    case 'port': m.port.onmessage = ev => onFrame(ev.data.samples, ev.data.t); break;
    case 'feed': onFrame(m.samples, m.t); break;
    case 'mode': try { setMode(m); } catch (err) { post({ type: 'error', error: describeError(err, runtime) }); } break;
    case 'transcribe': {
      const t0 = performance.now();
      try { post({ type: 'transcript', id: m.id, text: transcribe(m.samples, m.sampleRate || SR), asrMs: Math.round(performance.now() - t0) }); } catch (err) { post({ type: 'transcript', id: m.id, text: '', error: describeError(err, runtime) }); }
      break;
    }
    default: break;
  }
};
