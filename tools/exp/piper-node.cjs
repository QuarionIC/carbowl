// Loads the piper-phonemize (espeak-ng) WebAssembly bundle under Node and builds Piper/Kitten voices
// on the sherpa-onnx runtime. The bundle is a browser-style script that expects a global `Module`.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DL, ASSETS, putFile } = require('./sherpa-node.cjs');

const PP_DIR = path.join(DL, 'piper-phonemize', 'browser');

function loadPhonemizer () {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phonemizer did not initialise in 30 s')), 30000);
    global.require = require;
    global.__dirname = PP_DIR;
    global.__filename = path.join(PP_DIR, 'piper-phonemize-wasm-main.js');
    global.Module = {
      locateFile: p => path.join(PP_DIR, p),
      print: () => {},
      printErr: () => {},
      onRuntimeInitialized () {
        try {
          const rate = global.piperPhonemizeInitialize();
          clearTimeout(timer);
          if (rate < 0) reject(new Error('espeak-ng failed to initialise')); else resolve({ phonemize: (text, voice = 'en-us') => global.piperPhonemize(text, voice), toString: (text, voice = 'en-us') => global.piperPhonemizeToString(text, voice) });
        } catch (e) { clearTimeout(timer); reject(e); }
      }
    };
    try {
      vm.runInThisContext(fs.readFileSync(path.join(PP_DIR, 'piper-phonemize.js'), 'utf8'), { filename: 'piper-phonemize.js' });
      vm.runInThisContext(fs.readFileSync(path.join(PP_DIR, 'piper-phonemize-wasm-main.js'), 'utf8'), { filename: 'piper-phonemize-wasm-main.js' });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

const VOICES = {
  'lessac-int8': { kind: 'vits', dir: path.join(DL, 'tts-lessac-medium-int8', 'vits-piper-en_US-lessac-medium-int8'), model: 'en_US-lessac-medium.onnx' },
  'lessac-fp16': { kind: 'vits', dir: path.join(DL, 'tts-lessac-medium-fp16', 'vits-piper-en_US-lessac-medium-fp16'), model: 'en_US-lessac-medium.onnx' },
  'libritts-int8': { kind: 'vits', dir: path.join(DL, 'tts-libritts_r-medium-int8', 'vits-piper-en_US-libritts_r-medium-int8'), model: 'en_US-libritts_r-medium.onnx' },
  'kitten-nano-int8': { kind: 'kitten', dir: path.join(DL, 'tts-kitten-nano-v0_8-int8', 'kitten-nano-en-v0_8-int8'), model: 'model.int8.onnx' }
};

function makeVoice (Module, name) {
  const v = VOICES[name];
  if (!v) throw new Error('unknown voice ' + name);
  const p = `/voice-${name}/`;
  putFile(Module, path.join(v.dir, v.model), p + 'model.onnx');
  putFile(Module, path.join(v.dir, 'tokens.txt'), p + 'tokens.txt');
  const { createOfflineTts } = require(path.join(ASSETS, 'sherpa-onnx-tts.js'));
  const modelConfig = { numThreads: 1, debug: 0, provider: 'cpu' };
  if (v.kind === 'vits') modelConfig.offlineTtsVitsModelConfig = { model: p + 'model.onnx', lexicon: '', tokens: p + 'tokens.txt', dataDir: '', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 };
  else { putFile(Module, path.join(v.dir, 'voices.bin'), p + 'voices.bin'); modelConfig.offlineTtsKittenModelConfig = { model: p + 'model.onnx', voices: p + 'voices.bin', tokens: p + 'tokens.txt', dataDir: '', lengthScale: 1.0, lexicon: '' }; }
  return createOfflineTts(Module, { offlineTtsModelConfig: modelConfig, ruleFsts: '', ruleFars: '', maxNumSentences: 1 });
}

/** Speaks text through a phoneme-driven voice. */
function speakPhonemes (tts, phonemizer, text, { sid = 0, speed = 1 } = {}) {
  const phonemes = (phonemizer.phonemize(text) || []).filter(s => s.length > 0);
  if (!phonemes.length) return { samples: new Float32Array(0), sampleRate: tts.sampleRate };
  return tts.generateWithConfig(text, { sid, speed, phonemeCodepoints: phonemes });
}

module.exports = { loadPhonemizer, makeVoice, speakPhonemes, VOICES, PP_DIR };
