/* Speech synthesis worker: turns text into audio samples with an on-device voice model.
 * Runs apart from the listening worker so that generating a sentence never delays hearing a buzz.
 *
 * Messages in:  { type: 'init', base, manifest, voice: 'supertonic' | 'piper-lessac', outRate? }
 *               { type: 'speak', id, text, sid, speed, steps, priority, group }
 *               { type: 'cancel', group?, ids?, all? }
 *               { type: 'rate', sampleRate }   the rate the sound system runs at: audio is delivered at it
 * Messages out: { type: 'ready', voice, sampleRate, speakers, heapMiB, initMs }
 *               { type: 'audio', id, samples, sampleRate, genMs, audioMs, limited }   (samples transferred)
 *               { type: 'failed', id, error } | { type: 'error', error } | { type: 'log', text }
 */
/* global importScripts, loadBundle, unlinkAll, startRuntime, heapMiB, describeError, createOfflineTts, piperPhonemize, piperPhonemizeInitialize, CarbowlDsp */
'use strict';
importScripts('common.js', 'dsp.js');

let runtime = null;
let tts = null;
let voiceKind = null;
let usesPhonemizer = false;
let outRate = 0;             // 0: deliver at the voice model's own rate
const queue = [];
let pumping = false;
const cancelledGroups = new Set();
const cancelledIds = new Set();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = text => post({ type: 'log', text });

async function loadPhonemizer (base, manifest) {
  // The phonemizer bundle is a classic script that expects a global `Module` and normally downloads
  // its data file itself; hand it the bytes from our cache instead.
  const bundle = manifest.bundles.phonemizer;
  const dataEntry = bundle.files.find(f => f.path.endsWith('.data'));
  const wasmEntry = bundle.files.find(f => f.path.endsWith('.wasm'));
  const [data, wasm] = await Promise.all([fetchBytes(base, dataEntry), fetchBytes(base, wasmEntry)]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phonemizer start timed out')), 30000);
    self.Module = {
      locateFile: p => new URL('vendor/piper-phonemize/' + p, base).href,
      getPreloadedPackage: () => data.buffer,
      wasmBinary: wasm,
      print: () => {},
      printErr: () => {},
      onRuntimeInitialized () {
        try {
          const rate = piperPhonemizeInitialize();
          clearTimeout(timer);
          if (rate < 0) reject(new Error('espeak-ng failed to start')); else resolve();
        } catch (e) { clearTimeout(timer); reject(e); }
      }
    };
    try {
      importScripts(new URL('vendor/piper-phonemize/piper-phonemize.js', base).href, new URL('vendor/piper-phonemize/piper-phonemize-wasm-main.js', base).href);
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

async function init ({ base, manifest, voice }) {
  const t0 = Date.now();
  runtime = await startRuntime(base, log, manifest);
  importScripts(new URL('vendor/sherpa/sherpa-onnx-tts.js', base).href);
  voiceKind = voice;
  const modelConfig = { numThreads: 1, debug: 0, provider: 'cpu' };
  let paths;
  if (voice === 'supertonic') {
    paths = await loadBundle(runtime, base, manifest.bundles['tts-supertonic'], '/tts');
    modelConfig.offlineTtsSupertonicModelConfig = { durationPredictor: paths['duration_predictor.int8.onnx'], textEncoder: paths['text_encoder.int8.onnx'], vectorEstimator: paths['vector_estimator.int8.onnx'], vocoder: paths['vocoder.int8.onnx'], ttsJson: paths['tts.json'], unicodeIndexer: paths['unicode_indexer.bin'], voiceStyle: paths['voice.bin'] };
  } else if (voice === 'piper-lessac') {
    await loadPhonemizer(base, manifest);
    usesPhonemizer = true;
    paths = await loadBundle(runtime, base, manifest.bundles['tts-piper-lessac'], '/tts');
    modelConfig.offlineTtsVitsModelConfig = { model: paths['model.onnx'], lexicon: '', tokens: paths['tokens.txt'], dataDir: '', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 };
  } else throw new Error('unknown voice ' + voice);
  tts = createOfflineTts(runtime, { offlineTtsModelConfig: modelConfig, ruleFsts: '', ruleFars: '', maxNumSentences: 1 });
  if (!tts.handle) throw new Error('the voice model failed to load');
  unlinkAll(runtime, paths); // the sessions hold the weights now; free the file copies
  // First inference is slow (lazy initialisation); do it before anything is waiting on us.
  try { synthesize({ text: 'Ready.', sid: 0, speed: 1, steps: 3 }); } catch (e) { log('warm-up failed: ' + describeError(e, runtime)); }
  post({ type: 'ready', voice, sampleRate: tts.sampleRate, speakers: tts.numSpeakers, heapMiB: heapMiB(runtime), initMs: Date.now() - t0 });
}

function synthesize ({ text, sid, speed, steps }) {
  // The model is asked for a pace it speaks clearly at; a faster reading is made from that by
  // compressing it in time (dsp.js, splitPace: the model's own fast speech loses sounds).
  const pace = CarbowlDsp.splitPace(speed || 1);
  let audio;
  if (usesPhonemizer) {
    const phonemes = (piperPhonemize(text, 'en-us') || []).filter(s => s.length > 0);
    if (!phonemes.length) return { samples: new Float32Array(0), sampleRate: tts.sampleRate };
    audio = tts.generateWithConfig(text, { sid: sid || 0, speed: pace.model, phonemeCodepoints: phonemes });
  } else audio = tts.generateWithConfig(text, { sid: sid || 0, speed: pace.model, numSteps: steps || 5, extra: { lang: 'en' } });
  if (pace.stretch > 1.004 && audio.samples.length) {
    const rate = audio.sampleRate || tts.sampleRate;
    return { samples: CarbowlDsp.timeScale(audio.samples, rate, pace.stretch), sampleRate: rate };
  }
  return audio;
}

async function pump () {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      // Lowest priority number first; first come first served within a priority.
      let best = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i;
      const job = queue.splice(best, 1)[0];
      if (cancelledIds.delete(job.id) || (job.group && cancelledGroups.has(job.group))) { post({ type: 'failed', id: job.id, error: 'cancelled' }); continue; }
      const t0 = performance.now();
      try {
        const audio = synthesize(job);
        // Trimmed, brought to the standard loudness, and converted to the sound system's rate here,
        // off the page's own thread (see dsp.js for why the browser is not left to convert it).
        const clip = CarbowlDsp.finishClip(audio.samples, audio.sampleRate || tts.sampleRate, { outRate });
        const samples = clip.samples; const rate = clip.sampleRate;
        post({ type: 'audio', id: job.id, samples, sampleRate: rate, genMs: Math.round(performance.now() - t0), audioMs: Math.round(1000 * samples.length / rate), limited: clip.limited }, [samples.buffer]);
      } catch (e) {
        post({ type: 'failed', id: job.id, error: describeError(e, runtime) });
      }
      // Yield so that cancel messages arriving meanwhile are seen before the next job starts.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { pumping = false; }
}

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    if (m.outRate > 0) outRate = Math.round(m.outRate);
    init(m).catch(err => post({ type: 'error', error: describeError(err, runtime) }));
  } else if (m.type === 'rate') {
    outRate = m.sampleRate > 0 ? Math.round(m.sampleRate) : 0;
  } else if (m.type === 'speak') {
    if (!tts) { post({ type: 'failed', id: m.id, error: 'voice not ready' }); return; }
    queue.push({ priority: 5, ...m });
    pump();
  } else if (m.type === 'cancel') {
    if (m.all) { for (const j of queue.splice(0)) post({ type: 'failed', id: j.id, error: 'cancelled' }); }
    if (m.group) { cancelledGroups.add(m.group); if (cancelledGroups.size > 64) cancelledGroups.delete(cancelledGroups.values().next().value); }
    if (m.ids) for (const id of m.ids) cancelledIds.add(id);
    for (let i = queue.length - 1; i >= 0; i--) {
      const j = queue[i];
      if ((m.group && j.group === m.group) || (m.ids && m.ids.includes(j.id))) { queue.splice(i, 1); cancelledIds.delete(j.id); post({ type: 'failed', id: j.id, error: 'cancelled' }); }
    }
  }
};
