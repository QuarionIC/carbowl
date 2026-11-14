// End-to-end answer test: synthetic spoken answers -> recogniser -> judge, against the real answerlines.
// Reports how often the right answer is accepted (by each judging stage) and how often a different,
// wrong answer would be accepted.
// Usage: node tools/exp/answer-exp.cjs [--asr moonshine-tiny] [--threshold 0.8] [--snr 15] [--show]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, readWav, mulberry32, addNoise } = require('./sherpa-node.cjs');
const { makeRecognizer, transcribe } = require('./models.cjs');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes('--' + name);

(async () => {
  const { judgeAnswer } = await import('../../docs/js/judge.js');
  const checkAnswer = (await import('../../docs/vendor/qb-answer-checker.js')).default;
  const Module = await loadSherpa();
  const asr = arg('asr', 'moonshine-tiny'); const threshold = Number(arg('threshold', 0.8)); const snr = arg('snr', 'clean');
  const rec = makeRecognizer(Module, asr);
  const rand = mulberry32(7);
  const dir = path.join(OUT, arg('dir', 'answers'));
  const items = fs.readdirSync(dir).filter(f => f.endsWith('.wav')).sort().map(f => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.wav$/, '.json')), 'utf8')), wav: readWav(path.join(dir, f)) }));
  const stats = { n: items.length, exact: 0, sound: 0, prompt: 0, reject: 0, officialOnly: 0 };
  const rejected = []; const bySound = []; let ms = 0; let audio = 0;
  for (const it of items) {
    let samples = it.wav.samples;
    if (snr !== 'clean') samples = addNoise(samples, Number(snr), rand);
    const padded = new Float32Array(samples.length + 16000 * 0.4); padded.set(samples, 16000 * 0.2);
    const a = Date.now(); it.heard = transcribe(rec, padded, it.wav.sampleRate); ms += Date.now() - a; audio += padded.length / 16000;
    const r = judgeAnswer({ answerline: it.answerline, transcripts: [it.heard], checkAnswer, threshold });
    it.result = r;
    if (checkAnswer(it.answerline, it.heard).directive === 'accept') stats.officialOnly++;
    if (r.directive === 'accept') { if (r.method === 'exact') stats.exact++; else { stats.sound++; bySound.push(`${it.text}  <=  "${it.heard}" (${r.score.toFixed(2)})`); } } else if (r.directive === 'prompt') stats.prompt++; else { stats.reject++; rejected.push(`${it.text}  <=  "${it.heard}" (best ${r.score.toFixed(2)} vs ${r.matched || '-'})`); }
  }
  // Wrong answers: each transcript judged against the next item's answerline.
  let falseAccept = 0; const fas = [];
  for (let i = 0; i < items.length; i++) {
    const other = items[(i + 7) % items.length];
    if (other.text.toLowerCase() === items[i].text.toLowerCase()) continue;
    const r = judgeAnswer({ answerline: other.answerline, transcripts: [items[i].heard], checkAnswer, threshold });
    if (r.directive === 'accept') { falseAccept++; fas.push(`said "${items[i].heard}" for [${other.text}] via ${r.method} ${r.score.toFixed(2)} ~ ${r.matched}`); }
  }
  const pct = x => (100 * x / stats.n).toFixed(0) + '%';
  console.log(`${asr} @ ${snr}${snr === 'clean' ? '' : ' dB SNR'}, threshold ${threshold}: accepted ${pct(stats.exact + stats.sound)} (QBReader checker alone ${pct(stats.officialOnly)}; +sound ${stats.sound}), prompt ${stats.prompt}, rejected ${stats.reject} of ${stats.n}; wrong-answer false accepts ${falseAccept}/${stats.n}; ASR RTF ${(ms / 1000 / audio).toFixed(3)}, ${(ms / stats.n).toFixed(0)} ms per answer`);
  if (has('show')) {
    console.log('--- accepted by sound ---\n  ' + bySound.join('\n  '));
    console.log('--- rejected ---\n  ' + rejected.join('\n  '));
    console.log('--- false accepts ---\n  ' + fas.join('\n  '));
  }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
