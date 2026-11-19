// Model set-up shared by the experiments: copies model files into the runtime's in-memory file
// system and builds recognisers / synthesisers / keyword spotters from them.
'use strict';
const fs = require('fs');
const path = require('path');
const { DL, ASSETS, putFile } = require('./sherpa-node.cjs');

const ASR = {
  'moonshine-tiny': {
    dir: path.join(DL, 'asr-moonshine-tiny-en', 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27'),
    files: ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt'],
    config: p => ({ moonshine: { preprocessor: '', encoder: p + 'encoder_model.ort', uncachedDecoder: '', cachedDecoder: '', mergedDecoder: p + 'decoder_model_merged.ort' }, tokens: p + 'tokens.txt' })
  },
  'moonshine-base': {
    dir: path.join(DL, 'asr-moonshine-base-en', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27'),
    files: ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt'],
    config: p => ({ moonshine: { preprocessor: '', encoder: p + 'encoder_model.ort', uncachedDecoder: '', cachedDecoder: '', mergedDecoder: p + 'decoder_model_merged.ort' }, tokens: p + 'tokens.txt' })
  },
  'zipformer-gigaspeech': {
    dir: path.join(DL, 'asr-zipformer-gigaspeech'),
    files: ['encoder-epoch-30-avg-1.int8.onnx', 'decoder-epoch-30-avg-1.int8.onnx', 'joiner-epoch-30-avg-1.int8.onnx', 'tokens.txt'],
    optional: ['bpe.vocab'],
    config: p => ({ transducer: { encoder: p + 'encoder-epoch-30-avg-1.int8.onnx', decoder: p + 'decoder-epoch-30-avg-1.int8.onnx', joiner: p + 'joiner-epoch-30-avg-1.int8.onnx' }, tokens: p + 'tokens.txt' })
  }
};

/**
 * @param {object} [extra] extra recogniser options, e.g. { decodingMethod, hotwordsFile, hotwordsScore, modelingUnit, bpeVocab }
 */
function makeRecognizer (Module, name, extra = {}) {
  const spec = ASR[name];
  if (!spec) throw new Error('unknown ASR model ' + name);
  const prefix = `/asr-${name}/`;
  for (const f of spec.files) putFile(Module, path.join(spec.dir, f), prefix + f);
  for (const f of spec.optional || []) { const src = path.join(spec.dir, f); if (fs.existsSync(src)) putFile(Module, src, prefix + f); }
  const { OfflineRecognizer } = require(path.join(ASSETS, 'sherpa-onnx-asr.js'));
  const { modelingUnit, bpeVocab, ...rest } = extra;
  const modelConfig = { ...spec.config(prefix), numThreads: 1, provider: 'cpu', debug: 0, modelingUnit: modelingUnit || '', bpeVocab: bpeVocab || '' };
  const rec = new OfflineRecognizer({ modelConfig, decodingMethod: 'greedy_search', ...rest }, Module);
  rec.prefix = prefix;
  return rec;
}

function transcribe (rec, samples, sampleRate) {
  const stream = rec.createStream();
  stream.acceptWaveform(sampleRate, samples);
  rec.decode(stream);
  const r = rec.getResult(stream);
  stream.free();
  return String(r.text || '').trim();
}

function makeSupertonic (Module) {
  const dir = path.join(DL, 'tts-supertonic-int8', 'sherpa-onnx-supertonic-tts-int8-2026-03-06');
  for (const f of ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin']) putFile(Module, path.join(dir, f), '/tts/' + f);
  const { createOfflineTts } = require(path.join(ASSETS, 'sherpa-onnx-tts.js'));
  return createOfflineTts(Module, { offlineTtsModelConfig: { offlineTtsSupertonicModelConfig: { durationPredictor: '/tts/duration_predictor.int8.onnx', textEncoder: '/tts/text_encoder.int8.onnx', vectorEstimator: '/tts/vector_estimator.int8.onnx', vocoder: '/tts/vocoder.int8.onnx', ttsJson: '/tts/tts.json', unicodeIndexer: '/tts/unicode_indexer.bin', voiceStyle: '/tts/voice.bin' }, numThreads: 1, debug: 0, provider: 'cpu' }, maxNumSentences: 1 });
}

/** @param {number} [o.seed] a fixed seed gives the same audio for the same text every time (the runtime's own 'seed' option) */
function speak (tts, text, { sid = 0, speed = 1, steps = 5, seed } = {}) {
  return tts.generateWithConfig(text, { sid, speed, numSteps: steps, extra: Number.isInteger(seed) ? { lang: 'en', seed } : { lang: 'en' } });
}

const KWS_DIR = path.join(DL, 'kws-gigaspeech', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01');

/** @param {string} keywords one keyword per line in token form, e.g. "▁BU Z Z :2.0 #0.3 @BUZZ" */
function makeKws (Module, keywords, { int8 = true, score = 1.0, threshold = 0.25, trailingBlanks = 1, maxActivePaths = 4 } = {}) {
  const sfx = int8 ? '.int8.onnx' : '.onnx';
  const names = { encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64' + sfx, decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64' + sfx, joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64' + sfx };
  for (const f of [...Object.values(names), 'tokens.txt']) putFile(Module, path.join(KWS_DIR, f), '/kws/' + f);
  const { createKws } = require(path.join(ASSETS, 'sherpa-onnx-kws.js'));
  // The "keywords" option is a file path inside the runtime's file system, not the text itself.
  makeKws.n = (makeKws.n || 0) + 1;
  const keywordsFile = `/kws/keywords-${makeKws.n}.txt`;
  Module.FS.writeFile(keywordsFile, keywords.trim() + '\n');
  keywords = keywordsFile;
  return createKws(Module, {
    featConfig: { samplingRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: '/kws/' + names.encoder, decoder: '/kws/' + names.decoder, joiner: '/kws/' + names.joiner }, tokens: '/kws/tokens.txt', provider: 'cpu', modelType: '', numThreads: 1, debug: 0, modelingUnit: '', bpeVocab: '' },
    maxActivePaths, numTrailingBlanks: trailingBlanks, keywordsScore: score, keywordsThreshold: threshold, keywords
  });
}

function makeVad (Module, opts = {}) {
  putFile(Module, path.join(DL, 'silero-vad', 'silero_vad.onnx'), '/vad/silero_vad.onnx');
  const { createVad } = require(path.join(ASSETS, 'sherpa-onnx-vad.js'));
  return createVad(Module, {
    sileroVad: { model: '/vad/silero_vad.onnx', threshold: opts.threshold || 0.5, minSilenceDuration: opts.minSilence || 0.5, minSpeechDuration: opts.minSpeech || 0.25, maxSpeechDuration: opts.maxSpeech || 20, windowSize: 512 },
    tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 60
  });
}

/** Word error rate between a reference and a hypothesis, after light normalisation. */
function wer (ref, hyp) {
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const a = norm(ref); const b = norm(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], words: a.length };
}

module.exports = { ASR, makeRecognizer, transcribe, makeSupertonic, speak, makeKws, makeVad, wer, KWS_DIR };
