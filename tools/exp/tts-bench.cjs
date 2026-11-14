// Measures a text-to-speech model on real quizbowl sentences: load time, speed (real-time factor),
// and writes WAV files for the recognition round trip.
// Usage: node tools/exp/tts-bench.cjs <supertonic|kitten> [--sid N] [--speed X] [--steps N] [--n sentences] [--tag name]
'use strict';
const fs = require('fs');
const path = require('path');
const { DL, ASSETS, OUT, loadSherpa, putFile, writeWav } = require('./sherpa-node.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const kind = process.argv[2] || 'supertonic';
const sid = Number(arg('sid', 0)); const speed = Number(arg('speed', 1)); const steps = Number(arg('steps', 5));
const nSentences = Number(arg('n', 12)); const tag = arg('tag', `${kind}-sid${sid}-sp${speed}-st${steps}`);

(async () => {
  const { cleanForSpeech, chunkForSpeech } = await import('../../docs/js/speechtext.js');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'tossups-philosophy.json'), 'utf8')).tossups;
  const sentences = [];
  for (const t of fx) { for (const c of chunkForSpeech(cleanForSpeech(t.question_sanitized).text)) sentences.push(c.text); if (sentences.length >= nSentences) break; }
  sentences.length = Math.min(sentences.length, nSentences);

  const t0 = Date.now();
  const Module = await loadSherpa();
  const { createOfflineTts } = require(path.join(ASSETS, 'sherpa-onnx-tts.js'));
  const tLoaded = Date.now();
  let config;
  if (kind === 'supertonic') {
    const dir = path.join(DL, 'tts-supertonic-int8', 'sherpa-onnx-supertonic-tts-int8-2026-03-06');
    for (const f of ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin']) putFile(Module, path.join(dir, f), '/tts/' + f);
    config = { offlineTtsModelConfig: { offlineTtsSupertonicModelConfig: { durationPredictor: '/tts/duration_predictor.int8.onnx', textEncoder: '/tts/text_encoder.int8.onnx', vectorEstimator: '/tts/vector_estimator.int8.onnx', vocoder: '/tts/vocoder.int8.onnx', ttsJson: '/tts/tts.json', unicodeIndexer: '/tts/unicode_indexer.bin', voiceStyle: '/tts/voice.bin' }, numThreads: 1, debug: 0, provider: 'cpu' }, maxNumSentences: 1 };
  } else throw new Error('unknown kind ' + kind);
  const tts = createOfflineTts(Module, config);
  const tReady = Date.now();
  console.log(`runtime ${tLoaded - t0} ms, model init ${tReady - tLoaded} ms; sampleRate ${tts.sampleRate}, speakers ${tts.numSpeakers}, lang "${tts.lang}"`);

  let audioSec = 0; let genMs = 0; const rows = [];
  for (let i = 0; i < sentences.length; i++) {
    const a = Date.now();
    const audio = tts.generateWithConfig(sentences[i], { sid, speed, numSteps: steps, extra: { lang: 'en' } });
    const ms = Date.now() - a;
    const sec = audio.samples.length / (audio.sampleRate || 1);
    audioSec += sec; genMs += ms;
    rows.push({ i, chars: sentences[i].length, sec: +sec.toFixed(2), ms, rtf: +(ms / 1000 / (sec || 1)).toFixed(3) });
    const file = path.join(OUT, 'tts-' + tag, String(i).padStart(3, '0') + '.wav');
    writeWav(file, audio.samples, audio.sampleRate);
    fs.writeFileSync(file.replace(/\.wav$/, '.txt'), sentences[i]);
  }
  for (const r of rows) console.log(`  #${r.i} ${String(r.chars).padStart(3)} chars -> ${r.sec}s audio in ${r.ms} ms (RTF ${r.rtf})`);
  console.log(`TOTAL ${audioSec.toFixed(1)} s audio in ${(genMs / 1000).toFixed(1)} s => RTF ${(genMs / 1000 / audioSec).toFixed(3)}; ${(sentences.join(' ').length / audioSec).toFixed(1)} chars/s spoken; heap ${(Module.HEAPU8.length / 1048576).toFixed(0)} MiB`);
  const errs = Module.__logs.filter(l => /error|fail|warn/i.test(l)).slice(0, 8);
  if (errs.length) console.log('runtime messages:\n  ' + errs.join('\n  '));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
