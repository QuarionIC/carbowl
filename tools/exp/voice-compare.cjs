// Compares voices on (a) speed, (b) intelligibility of real question sentences (recognition round
// trip), and (c) reliability on short phrases such as answer reveals.
// Usage: node tools/exp/voice-compare.cjs <voice> [--sid N] [--speed X] [--n 30] [--asr moonshine-base]
//   voice: supertonic | lessac-int8 | lessac-fp16 | libritts-int8 | kitten-nano-int8
'use strict';
const fs = require('fs');
const path = require('path');
const { loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe, wer } = require('./models.cjs');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };

(async () => {
  const voice = process.argv[2] || 'supertonic';
  const sid = Number(arg('sid', 0)); const speed = Number(arg('speed', 1.0)); const n = Number(arg('n', 30)); const steps = Number(arg('steps', 5));
  const st = await import('../../docs/js/speechtext.js');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'tossups-philosophy.json'), 'utf8')).tossups;
  const sentences = [];
  for (const t of fx.slice(5)) { for (const c of st.chunkForSpeech(st.cleanForSpeech(t.question_sanitized).text)) sentences.push(c.text); if (sentences.length >= n) break; }
  sentences.length = Math.min(n, sentences.length);
  const answers = [...new Set(fx.map(t => st.mainAnswer(t.answer_sanitized)))].filter(a => a.length < 40).slice(0, 25);

  const Module = await loadSherpa();
  let say; let info;
  const t0 = Date.now();
  if (voice === 'supertonic') { const tts = makeSupertonic(Module); say = text => speak(tts, text, { sid, speed, steps }); info = `speakers ${tts.numSpeakers}, ${tts.sampleRate} Hz`; } else {
    const { loadPhonemizer, makeVoice, speakPhonemes } = require('./piper-node.cjs');
    const ph = await loadPhonemizer(); const tts = makeVoice(Module, voice);
    say = text => speakPhonemes(tts, ph, text, { sid, speed }); info = `speakers ${tts.numSpeakers}, ${tts.sampleRate} Hz`;
  }
  const initMs = Date.now() - t0;
  const rec = makeRecognizer(Module, arg('asr', 'moonshine-base'));
  const hear = audio => { const s = resample(audio.samples, audio.sampleRate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };

  let genMs = 0; let audioSec = 0; let errors = 0; let words = 0; const bad = [];
  for (const text of sentences) {
    const a = Date.now(); const audio = say(text); genMs += Date.now() - a; audioSec += audio.samples.length / audio.sampleRate;
    const hyp = hear(audio); const w = wer(text, hyp); errors += w.errors; words += w.words;
    if (w.errors / w.words > 0.2) bad.push(`   [${(100 * w.errors / w.words).toFixed(0)}%] ${text}\n        -> ${hyp}`);
  }
  let okAlone = 0; let okCarrier = 0; const failures = [];
  const contains = (hyp, ans) => { const h = st.wordsOf(hyp).join(' '); const last = st.wordsOf(ans).pop() || ''; return h.includes(last.slice(0, Math.max(4, last.length - 2))); };
  for (const ans of answers) {
    const h1 = hear(say(ans + '.')); const h2 = hear(say(`The answer is ${ans}.`));
    if (contains(h1, ans)) okAlone++; else failures.push(`alone "${ans}" -> "${h1}"`);
    if (contains(h2, ans) && /answer/i.test(h2)) okCarrier++; else failures.push(`carrier "${ans}" -> "${h2}"`);
  }
  console.log(`VOICE ${voice} sid ${sid} speed ${speed}${voice === 'supertonic' ? ' steps ' + steps : ''} (${info}; init ${initMs} ms)`);
  console.log(`  speed: RTF ${(genMs / 1000 / audioSec).toFixed(3)} (${audioSec.toFixed(0)} s audio in ${(genMs / 1000).toFixed(1)} s); speaking rate ${(sentences.join(' ').length / audioSec).toFixed(1)} chars/s`);
  console.log(`  question sentences: WER ${(100 * errors / words).toFixed(1)}% (${errors}/${words}); sentences over 20% WER: ${bad.length}/${sentences.length}`);
  console.log(`  short phrases: alone ${okAlone}/${answers.length}, in "The answer is ..." ${okCarrier}/${answers.length}`);
  if (process.argv.includes('--show')) { console.log(bad.join('\n')); console.log('   ' + failures.join('\n   ')); }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
