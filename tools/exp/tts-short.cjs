// How reliably does the voice say short phrases? Synthesises a few answers alone and in a carrier
// sentence, for every voice, and transcribes them.
'use strict';
const { loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe } = require('./models.cjs');
(async () => {
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module); const rec = makeRecognizer(Module, 'moonshine-base');
  const phrases = ['John Locke', 'private language', 'On the Nature of Things', 'heliocentrism', 'Immanuel Kant', 'Buzz'];
  const hear = (text, o) => { const a = speak(tts, text, o); const s = resample(a.samples, a.sampleRate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return { text: transcribe(rec, p, 16000), sec: (a.samples.length / a.sampleRate).toFixed(2) }; };
  for (const steps of [5, 10]) for (const speed of [1.0, 1.15]) {
    console.log(`=== steps ${steps}, speed ${speed} ===`);
    for (const ph of phrases) {
      const alone = []; const carrier = [];
      for (let sid = 0; sid < 10; sid++) { alone.push(hear(ph + '.', { sid, speed, steps }).text); carrier.push(hear(`The answer is ${ph}.`, { sid, speed, steps }).text); }
      const okA = alone.filter(t => t.toLowerCase().replace(/[^a-z ]/g, '').includes(ph.toLowerCase().split(' ').pop().slice(0, 5))).length;
      const okC = carrier.filter(t => t.toLowerCase().replace(/[^a-z ]/g, '').includes(ph.toLowerCase().split(' ').pop().slice(0, 5))).length;
      console.log(`${ph}: alone ok ${okA}/10, in carrier ok ${okC}/10\n   alone:   ${alone.join(' | ')}\n   carrier: ${carrier.join(' | ')}`);
    }
  }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
