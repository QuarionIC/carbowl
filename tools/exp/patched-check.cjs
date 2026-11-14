// Verifies the memory-patched runtime in site/vendor: synthesis, recognition and VAD must work and
// agree with the unpatched runtime; prints how far the heap grew.
'use strict';
const fs = require('fs'); const path = require('path'); const NodeModule = require('module');
const { ROOT, DL, resample } = require('./sherpa-node.cjs');
const V = path.join(ROOT, 'docs', 'vendor', 'sherpa');
function requireCjs (file) { const m = new NodeModule(file); m.filename = file; m.paths = NodeModule._nodeModulePaths(path.dirname(file)); m._compile(fs.readFileSync(file, 'utf8'), file); return m.exports; }
const put = (M, src, dst) => { try { M.FS.mkdirTree(path.posix.dirname(dst)); } catch (e) {} M.FS.writeFile(dst, fs.readFileSync(src)); };
(async () => {
  const factory = requireCjs(path.join(V, 'sherpa-onnx-wasm-web.js'));
  const heap = M => (M.HEAPU8.length / 1048576).toFixed(0) + ' MiB';
  // --- speech worker equivalent
  const T = await factory({ locateFile: f => path.join(V, f), print: () => {}, printErr: () => {} });
  console.log('fresh heap', heap(T));
  const S = path.join(ROOT, 'docs', 'models', 'tts-supertonic');
  const files = ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin'];
  for (const f of files) put(T, path.join(S, f), '/tts/' + f);
  const { createOfflineTts } = requireCjs(path.join(V, 'sherpa-onnx-tts.js'));
  const tts = createOfflineTts(T, { offlineTtsModelConfig: { offlineTtsSupertonicModelConfig: { durationPredictor: '/tts/duration_predictor.int8.onnx', textEncoder: '/tts/text_encoder.int8.onnx', vectorEstimator: '/tts/vector_estimator.int8.onnx', vocoder: '/tts/vocoder.int8.onnx', ttsJson: '/tts/tts.json', unicodeIndexer: '/tts/unicode_indexer.bin', voiceStyle: '/tts/voice.bin' }, numThreads: 1, debug: 0, provider: 'cpu' }, maxNumSentences: 1 });
  console.log('voice created; heap', heap(T));
  for (const f of files) T.FS.unlink('/tts/' + f);   // model bytes are in the session now; drop the file copies
  const audio = tts.generateWithConfig('This book argues that we cannot know the noumenon, which consists of things in themselves.', { sid: 0, speed: 1.05, numSteps: 5, extra: { lang: 'en' } });
  console.log('generated', (audio.samples.length / audio.sampleRate).toFixed(2), 's after unlinking model files; heap', heap(T));
  // --- listening worker equivalent
  const L = await factory({ locateFile: f => path.join(V, f), print: () => {}, printErr: () => {} });
  const A = path.join(ROOT, 'docs', 'models', 'asr-moonshine-base');
  put(L, path.join(A, 'encoder_model.ort'), '/asr/encoder_model.ort'); put(L, path.join(A, 'tokens.txt'), '/asr/tokens.txt');
  const parts = fs.readdirSync(A).filter(f => f.startsWith('decoder_model_merged.ort.part')).sort((a, b) => Number(a.split('part')[1]) - Number(b.split('part')[1]));
  L.FS.writeFile('/asr/decoder_model_merged.ort', Buffer.concat(parts.map(f => fs.readFileSync(path.join(A, f)))));
  console.log('decoder reassembled from', parts.length, 'parts:', L.FS.stat('/asr/decoder_model_merged.ort').size, 'bytes (original', fs.statSync(path.join(DL, 'asr-moonshine-base-en', 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27', 'decoder_model_merged.ort')).size + ')');
  const { OfflineRecognizer } = requireCjs(path.join(V, 'sherpa-onnx-asr.js'));
  const rec = new OfflineRecognizer({ modelConfig: { moonshine: { preprocessor: '', encoder: '/asr/encoder_model.ort', uncachedDecoder: '', cachedDecoder: '', mergedDecoder: '/asr/decoder_model_merged.ort' }, tokens: '/asr/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelingUnit: '', bpeVocab: '' }, decodingMethod: 'greedy_search' }, L);
  console.log('recogniser created; heap', heap(L));
  for (const f of ['encoder_model.ort', 'decoder_model_merged.ort']) L.FS.unlink('/asr/' + f);
  put(L, path.join(ROOT, 'docs', 'models', 'vad', 'silero_vad.onnx'), '/vad/silero_vad.onnx');
  const { createVad } = requireCjs(path.join(V, 'sherpa-onnx-vad.js'));
  const vad = createVad(L, { sileroVad: { model: '/vad/silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.1, maxSpeechDuration: 8, windowSize: 512 }, tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30 });
  const s16 = resample(audio.samples, audio.sampleRate, 16000); const sig = new Float32Array(16000 + s16.length + 16000); sig.set(s16, 16000);
  const segs = [];
  for (let i = 0; i + 512 <= sig.length; i += 512) { vad.acceptWaveform(sig.subarray(i, i + 512)); while (!vad.isEmpty()) { const g = vad.front(); vad.pop(); segs.push({ start: g.start, n: g.samples.length, at: i + 512 }); } }
  console.log('VAD segments', JSON.stringify(segs.map(g => ({ startSec: +(g.start / 16000).toFixed(2), durSec: +(g.n / 16000).toFixed(2), availableAtSec: +(g.at / 16000).toFixed(2) }))));
  vad.reset(); let after = [];
  for (let i = 0; i + 512 <= sig.length; i += 512) { vad.acceptWaveform(sig.subarray(i, i + 512)); while (!vad.isEmpty()) { const g = vad.front(); vad.pop(); after.push(+(g.start / 16000).toFixed(2)); } }
  console.log('after reset(), segment starts (seconds):', JSON.stringify(after), '(same as before means reset() restarts the sample counter)');
  const st = rec.createStream(); st.acceptWaveform(16000, sig); rec.decode(st); console.log('heard:', rec.getResult(st).text); st.free();
  console.log('final heaps: speech', heap(T), ' listening', heap(L));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
