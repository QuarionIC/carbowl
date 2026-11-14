// "Utterance spotter" experiment: voice-activity detection cuts the microphone stream into
// utterances, a recogniser transcribes each one, and a rule decides whether it was a buzz.
// Measures detection rate, delay after the word ends, and false buzzes on question audio that
// leaks back into the microphone (echo) at several levels.
// Usage: node tools/exp/spot-exp.cjs [--asr moonshine-tiny] [--silence 0.3] [--vadth 0.5] [--quick]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav, mulberry32, roadNoise, rmsActive } = require('./sherpa-node.cjs');
const { makeRecognizer, makeVad, transcribe } = require('./models.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes('--' + name);
const SR = 16000; const WIN = 512;
const PAD_BEFORE = Number(arg('padbefore', 0.25)); const PAD_AFTER = Number(arg('padafter', 0.1));
const load = dir => fs.readdirSync(path.join(OUT, dir)).filter(f => f.endsWith('.wav')).sort().map(f => ({ name: f, samples: readWav(path.join(OUT, dir, f)).samples, meta: JSON.parse(fs.readFileSync(path.join(OUT, dir, f.replace(/\.wav$/, '.json')), 'utf8')) }));
const scaleTo = (s, target) => { const g = target / (rmsActive(s) || 1e-9); const o = new Float32Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s[i] * g; return o; };

(async () => {
  const { isBuzzLike, classifyBuzz } = await import('../../docs/js/intent.js');
  const Module = await loadSherpa();
  const rec = makeRecognizer(Module, arg('asr', 'moonshine-tiny'));
  const vad = makeVad(Module, { threshold: Number(arg('vadth', 0.5)), minSilence: Number(arg('silence', 0.3)), minSpeech: Number(arg('minspeech', 0.1)), maxSpeech: 8 });
  const rand = mulberry32(42);
  const LEVEL = 0.08;

  /** Streams a signal through VAD + ASR; returns utterances with the stream time at which each became available. */
  function run (signal) {
    vad.reset(); vad.clear();
    const utts = [];
    for (let i = 0; i + WIN <= signal.length; i += WIN) {
      vad.acceptWaveform(signal.subarray(i, i + WIN));
      while (!vad.isEmpty()) {
        const seg = vad.front(); vad.pop();
        const a = Math.max(0, Math.round(seg.start - PAD_BEFORE * SR)); const b = Math.min(signal.length, Math.round(seg.start + seg.samples.length + PAD_AFTER * SR), i + WIN);
        const text = transcribe(rec, PAD_BEFORE || PAD_AFTER ? signal.subarray(a, b) : seg.samples, SR);
        utts.push({ text, start: seg.start / SR, dur: seg.samples.length / SR, availableAt: (i + WIN) / SR });
      }
    }
    return utts;
  }
  const build = ({ buzz, echo, echoDb, snrDb, at }) => {
    const total = Math.round(((echo ? echo.length / SR : 0) + 1.5) * SR) + (buzz && !echo ? buzz.length + SR * 2 : 0);
    const sig = new Float32Array(total);
    if (echo) { const e = scaleTo(echo, LEVEL * Math.pow(10, echoDb / 20)); sig.set(e.subarray(0, Math.min(e.length, sig.length)), 0); }
    if (buzz) { const b = scaleTo(buzz, LEVEL); const o = Math.round(at * SR); for (let i = 0; i < b.length && o + i < sig.length; i++) sig[o + i] += b[i]; }
    if (snrDb !== Infinity) { const n = roadNoise(sig.length, rand); const g = LEVEL / Math.pow(10, snrDb / 20); for (let i = 0; i < sig.length; i++) sig[i] += g * n[i]; }
    return sig;
  };

  const buzz = load('buzz'); const questions = load('questions');
  const quick = has('quick');
  const report = { padBefore: PAD_BEFORE, padAfter: PAD_AFTER, asr: arg('asr', 'moonshine-tiny'), vadSilence: Number(arg('silence', 0.3)), vadThreshold: Number(arg('vadth', 0.5)) };

  // A. Buzz alone, with road noise.
  report.buzzAlone = {};
  for (const snr of quick ? [Infinity, 10] : [Infinity, 20, 10, 5, 0]) {
    let strict = 0; let normal = 0; let delay = 0; const misses = {};
    for (const b of buzz) {
      const at = 1.0; const sig = build({ buzz: b.samples, snrDb: snr, at });
      const end = at + b.samples.length / SR;
      const utts = run(sig).filter(u => u.start < end + 0.3);
      const s = utts.find(u => classifyBuzz(u, 'strict').buzz); const n = utts.find(u => classifyBuzz(u, 'normal').buzz);
      if (s) strict++;
      if (n) { normal++; delay += n.availableAt - end; } else misses[(utts.map(u => u.text).join(' / ')) || '(no utterance)'] = 1;
    }
    report.buzzAlone[snr === Infinity ? 'clean' : snr + 'dB SNR'] = `strict ${strict}/${buzz.length}, normal ${normal}/${buzz.length}` + (normal ? `, available +${(delay / normal).toFixed(2)}s after word end` : '') + (Object.keys(misses).length ? ` misses: ${Object.keys(misses).slice(0, 4).join(' | ')}` : '');
  }

  // B. Buzz spoken over leaked question audio. echoDb = level of the leak relative to the user's voice.
  report.buzzOverEcho = {};
  for (const echoDb of quick ? [-30, -10] : [-40, -30, -20, -10, 0]) {
    let strict = 0; let normal = 0; let delay = 0; let falseEarly = 0;
    for (let i = 0; i < buzz.length; i++) {
      const q = questions[i % questions.length];
      const at = Math.min(3.0, Math.max(0.8, q.samples.length / SR - 2.5));
      const sig = build({ buzz: buzz[i].samples, echo: q.samples, echoDb, snrDb: 20, at });
      const end = at + buzz[i].samples.length / SR;
      const utts = run(sig);
      const near = utts.filter(u => u.start + u.dur > at - 0.2 && u.start < end + 0.3);
      if (near.some(u => classifyBuzz(u, 'strict').buzz)) strict++;
      const n = near.find(u => classifyBuzz(u, 'normal').buzz);
      if (n) { normal++; delay += n.availableAt - end; }
      if (utts.some(u => u.start + u.dur < at - 0.2 && classifyBuzz(u, 'normal').buzz)) falseEarly++;
    }
    report.buzzOverEcho[echoDb + 'dB echo'] = `strict ${strict}/${buzz.length}, normal ${normal}/${buzz.length}` + (normal ? `, +${(delay / normal).toFixed(2)}s` : '') + `, false buzz before the real one: ${falseEarly}`;
  }

  // C. No buzz at all: question audio leaking at several levels. Counts utterances and false buzzes.
  report.echoOnly = {};
  for (const echoDb of quick ? [-30] : [-40, -30, -20, -10, 0]) {
    let utts = 0; let strict = 0; let normal = 0; let sec = 0; const examples = [];
    for (const q of questions.slice(0, quick ? 15 : 40)) {
      const sig = build({ echo: q.samples, echoDb, snrDb: 20 });
      sec += sig.length / SR;
      for (const u of run(sig)) { utts++; if (classifyBuzz(u, 'strict').buzz) { strict++; examples.push(u.text); } if (classifyBuzz(u, 'normal').buzz) { normal++; if (examples.length < 6) examples.push(u.text); } }
    }
    report.echoOnly[echoDb + 'dB echo'] = `${utts} utterances in ${(sec / 60).toFixed(1)} min; false buzz strict ${strict}, normal ${normal}` + (examples.length ? ` e.g. ${examples.slice(0, 4).join(' | ')}` : '');
  }

  // D. Noise only.
  { const n = roadNoise(SR * 120, rand); for (let i = 0; i < n.length; i++) n[i] *= LEVEL; const u = run(n); report.noiseOnly = `${u.length} utterances in 2.0 min` + (u.length ? ': ' + u.slice(0, 5).map(x => x.text || '(empty)').join(' | ') : ''); }
  console.log(JSON.stringify(report, null, 1));
})().catch(e => { console.error('FAILED', e); process.exit(1); });
