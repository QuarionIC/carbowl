// The reader's voice stays as chosen, and reaches the sound system at the sound system's own rate
// and at a level that cannot clip: the reader (narrator.js), the speech client (speech.js), the
// sound engine's playing path (audio.js) and the speech worker's finishing step (tts-worker.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Narrator } from '../docs/js/narrator.js';
import { AudioEngine, keepAwake } from '../docs/js/audio.js';
import * as dsp from '../docs/js/dsp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = x => 20 * Math.log10(Math.max(1e-12, x));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const peakOf = x => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };

/** A second or so of something voice-shaped: harmonics under syllable envelopes. */
function voiceLike (rate, seconds, { amp = 0.2, f0 = 150, lead = 0 } = {}) {
  const n = Math.round(rate * seconds); const x = new Float32Array(n + Math.round(rate * lead));
  const off = x.length - n;
  for (let i = 0; i < n; i++) {
    const syll = Math.sin(Math.PI * ((i / rate) % 0.22) / 0.22) ** 2;
    let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(2 * Math.PI * f0 * h * i / rate + h) / h;
    x[off + i] = amp * syll * v;
  }
  return x;
}

// ---------- the reader: quality is what was chosen, always ----------

/** A speech engine that takes `ms` per sentence, one at a time, like the real worker. */
function slowTts ({ ms = 0, rate = 44100, clipSec = 0.05, factor = 1.4 } = {}) {
  const asked = []; let chain = Promise.resolve();
  return {
    asked, realTimeFactor: factor, cancelled: [],
    statsFor: () => ({ jobs: 40, genMs: 90000, audioMs: 60000 }),      // slower than real time, for a long while
    recentFactor: () => ({ jobs: 6, factor }),
    speak (text, o) { asked.push({ text, ...o }); const p = chain.then(() => sleep(ms)).then(() => ({ samples: voiceLike(rate, clipSec), sampleRate: rate, genMs: ms, audioMs: clipSec * 1000 })); chain = p.catch(() => {}); return { id: asked.length, promise: p }; },
    cancel (o) { this.cancelled.push(o); }
  };
}
/** A sound engine that only keeps time. */
function clockAudio () {
  const played = [];
  return {
    played, get time () { return performance.now() / 1000; },
    play (samples, sampleRate, { when = 0 } = {}) {
      const startAt = Math.max(this.time + 0.001, when); const dur = samples.length / sampleRate; let stop;
      const ended = new Promise(resolve => { const t = setTimeout(() => resolve('ended'), (startAt - this.time + dur) * 1000); stop = () => { clearTimeout(t); resolve('stopped'); }; });
      played.push({ at: startAt, dur });
      return { startAt, endAt: startAt + dur, ended, position: () => Math.min(dur, Math.max(0, this.time - startAt)), stop };
    }
  };
}
const chunksOf = n => Array.from({ length: n }, (_, i) => ({ text: `Sentence number ${i + 1} of the question.`, start: i * 40, end: i * 40 + 38 }));

test('the voice quality is the one chosen, however slowly this device makes speech', () => {
  const tts = slowTts({ factor: 2.5 });
  const n = new Narrator({ tts, audio: clockAudio(), voice: () => ({ sid: 5, speed: 1.65, steps: 5 }), phraseCap: () => 1.35 });
  for (let i = 0; i < 30; i++) {
    assert.deepEqual(n._voice(), { sid: 5, speed: 1.65, steps: 5 });
    n.synth('Sentence ' + i).catch(() => {});
  }
  assert.ok(tts.asked.every(a => a.steps === 5), 'every sentence was asked for at quality 5');
  assert.deepEqual(n._voice('phrase'), { sid: 5, speed: 1.35, steps: 5 }, 'verdicts keep to the calmer pace, at the same quality');
});

test('a reader that falls behind keeps its voice, says so in the log, and finishes the question', async () => {
  const tts = slowTts({ ms: 380, factor: 1.6 });
  const lines = []; const slow = [];
  const n = new Narrator({ tts, audio: clockAudio(), voice: () => ({ sid: 5, speed: 1.3, steps: 5 }), onSlow: info => slow.push(info), log: l => lines.push(l) });
  const reading = n.read(chunksOf(5), { group: 'g', gap: 0.01 });
  assert.equal(await reading.done, 'finished');
  assert.equal(n.audio.played.length, 5, 'all five sentences were spoken');
  assert.ok(tts.asked.every(a => a.steps === 5), 'all at the chosen quality');
  assert.ok(reading.underruns >= 3, `late sentences were counted (${reading.underruns})`);
  assert.ok(lines.some(l => /reader fell behind: the next sentence started \d+ ms late \(speech generated in 1\.60 of real time lately at quality 5\)/.test(l)), lines.join('\n'));
  assert.equal(slow.length, 1, 'the listener is told once, not at every sentence');
  assert.equal(slow[0].steps, 5); assert.ok(slow[0].factor > 1 && slow[0].late >= 3);
});

test('one or two late sentences, or a device that is fast enough, are not reported', () => {
  const fast = new Narrator({ tts: slowTts({ factor: 0.6 }), audio: clockAudio(), voice: () => ({ sid: 5, speed: 1.3, steps: 5 }), onSlow: () => assert.fail('a busy moment on a fast device is not a slow device') });
  for (let i = 0; i < 6; i++) fast._noteLate(400);
  let told = 0;
  const slow = new Narrator({ tts: slowTts({ factor: 1.3 }), audio: clockAudio(), voice: () => ({ sid: 5, speed: 1.3, steps: 5 }), onSlow: () => told++ });
  slow._noteLate(400); slow._noteLate(400);
  assert.equal(told, 0, 'two late sentences are not enough');
  slow._noteLate(400);
  assert.equal(told, 1);
  for (let i = 0; i < 5; i++) slow._noteLate(400);
  assert.equal(told, 1, 'not again within the minute');
});

// ---------- the speech client: recent generation speed, and telling the worker the output rate ----------

test('the speech client reports how fast recent sentences were made, and passes the output rate on', async () => {
  const sent = [];
  globalThis.Worker = class { constructor () { this.onmessage = null; } postMessage (m) { sent.push(m); } terminate () {} };
  try {
    const { TtsClient } = await import('../docs/js/speech.js');
    const tts = new TtsClient({ base: 'http://localhost/' });
    tts.outRate = 48000;
    tts.init({ manifest: {}, voice: 'supertonic' });
    assert.equal(sent[0].type, 'init'); assert.equal(sent[0].outRate, 48000);
    tts.setOutputRate(48000);
    assert.equal(sent.length, 1, 'no message when the rate has not changed');
    tts.setOutputRate(16000);
    assert.deepEqual(sent[1], { type: 'rate', sampleRate: 16000 });
    assert.deepEqual(tts.recentFactor(5), { jobs: 0, factor: 0 });
    // Ten long sentences at quality 5 (the last six slow), a short phrase, and one at quality 3.
    const done = [];
    const make = (steps, genMs, audioMs) => { const job = tts.speak('x', { steps, speed: 1.3 }); done.push(job.promise); tts.worker.onmessage({ data: { type: 'audio', id: job.id, samples: new Float32Array(4), sampleRate: 16000, genMs, audioMs, limited: 0.9 } }); };
    for (let i = 0; i < 4; i++) make(5, 1000, 4000);
    for (let i = 0; i < 6; i++) make(5, 4400, 4000);
    make(5, 900, 600);
    make(3, 2000, 4000);
    const first = await done[0];
    assert.equal(first.sampleRate, 16000); assert.equal(first.limited, 0.9);
    assert.deepEqual(tts.recentFactor(5, 6), { jobs: 6, factor: 1.1 });
    assert.equal(tts.recentFactor(5, 10).jobs, 10); assert.ok(Math.abs(tts.recentFactor(5, 10).factor - (4 * 1000 + 6 * 4400) / 40000) < 1e-9);
    assert.deepEqual(tts.recentFactor(3), { jobs: 1, factor: 0.5 });
    assert.equal(tts.stats.jobs, 12, 'short phrases still count in the overall figure');
  } finally { delete globalThis.Worker; }
});

// ---------- the sound engine: what is handed to the sound system ----------

function fakeContext (rate) {
  const made = []; const gains = [];
  const param = v => ({ value: v, cancelScheduledValues () {}, setValueAtTime () {}, linearRampToValueAtTime () {}, setTargetAtTime (x) { this.value = x; } });
  return {
    sampleRate: rate, currentTime: 1, made, gains,
    createBuffer (ch, n, r) { const data = new Float32Array(n); const b = { length: n, sampleRate: r, duration: n / r, getChannelData: () => data }; made.push(b); return b; },
    createBufferSource () { return { buffer: null, onended: null, connect () {}, start () {}, stop () {} }; },
    createGain () { const g = { gain: param(1), connect () {} }; gains.push(g); return g; }
  };
}
function engineAt (rate, volume = 1) {
  const e = new AudioEngine({});
  e.ctx = fakeContext(rate); e.master = e.ctx.createGain(); e.setVolume(volume);
  return e;
}

test('the sound system is always handed audio at its own rate', async () => {
  const clip = dsp.finishClip(voiceLike(44100, 1.2), 44100).samples;
  for (const rate of [48000, 16000, 24000, 44100]) {
    const e = engineAt(rate);
    const h = e.play(clip, 44100);
    const buf = e.ctx.made[0];
    assert.equal(buf.sampleRate, rate, `buffer made at ${rate} Hz`);
    assert.equal(buf.length, Math.round(clip.length * rate / 44100));
    assert.ok(Math.abs(h.duration - clip.length / 44100) < 0.001, 'the same length in seconds');
    assert.ok(peakOf(buf.getChannelData(0)) <= 0.97 + 1e-6);
    assert.ok(Math.abs(db(dsp.speechLevel(buf.getChannelData(0), rate).rms) - db(dsp.speechLevel(clip, 44100).rms)) < 0.4, 'the same loudness');
    h.stop(); assert.equal(await h.ended, 'stopped');
    // The same clip again: converted once, not every time it is played.
    const again = e.play(clip, 44100); again.stop(); await again.ended;
    assert.equal(e.played.converted, rate === 44100 ? 0 : 1);
    assert.equal(e.played.clips, 2);
  }
});

test('volume above 1x presses peaks instead of clipping them, and leaves the clip itself untouched', async () => {
  // As the worker delivers real speech: the spoken parts at the standard loudness, a few sharp
  // peaks (plosives) up near the ceiling of 0.89.
  const clip = dsp.finishClip(voiceLike(48000, 1.2), 48000).samples;
  for (const at of [9000, 21000, 33000, 45000]) for (let i = 0; i < 30; i++) clip[at + i] = 0.89 * Math.exp(-i / 6) * (i % 2 ? -1 : 1);
  const before = Float32Array.from(clip);
  const loud = engineAt(48000, 1.5);
  assert.equal(loud.master.gain.value, 1, 'the common gain never goes over 1');
  const h = loud.play(clip, 48000); h.stop(); await h.ended;
  const out = loud.ctx.made[0].getChannelData(0);
  assert.deepEqual(clip, before, 'the cached clip is not written to');
  assert.ok(peakOf(clip) * 1.5 > 1, 'this clip would have clipped at 1.5x');
  assert.ok(peakOf(out) <= 0.97 + 1e-6, `peak ${peakOf(out).toFixed(3)}`);
  const gained = db(dsp.speechLevel(out, 48000).rms) - db(dsp.speechLevel(clip, 48000).rms);
  assert.ok(gained > 2.2 && gained < 3.6, `louder by ${gained.toFixed(2)} dB (1.5x is 3.5 dB)`);
  assert.equal(loud.played.pressed, 1);
  // Up to 1x nothing is copied or changed: the volume is a plain gain.
  const plain = engineAt(48000, 0.8);
  assert.ok(Math.abs(plain.master.gain.value - 0.8) < 1e-6);
  const p = plain.play(clip, 48000); p.stop(); await p.ended;
  assert.deepEqual(plain.ctx.made[0].getChannelData(0), before);
  assert.equal(plain.played.pressed, 0);
  // A quiet clip at a volume above 1x has room: it is simply turned up.
  const quiet = clip.map(v => v * 0.3);
  const q = loud._forOutput(quiet, 48000, 48000);
  assert.equal(q.data, quiet); assert.equal(q.gain, 1.5);
});

// ---------- what plays under everything, so that the output is never true silence ----------

/** Level of one frequency in a signal, as an amplitude. */
function toneAt (x, rate, hz) {
  let re = 0; let im = 0;
  for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(2 * Math.PI * hz * i / rate); im += x[i] * Math.sin(2 * Math.PI * hz * i / rate); }
  return 2 * Math.hypot(re, im) / x.length;
}

test('on a computer the keep-awake signal is a 30 Hz tone with nothing in the range where hiss is heard', () => {
  for (const rate of [48000, 44100, 96000]) {
    const loop = keepAwake(new Float32Array(rate * 2), rate, 'direct');
    assert.ok(Math.abs(peakOf(loop) - 0.0001) < 2e-6, `peak ${peakOf(loop)}`);
    assert.ok(Math.abs(toneAt(loop, rate, 30) - 0.0001) < 1e-6, 'all of it is the 30 Hz tone');
    // What is left when that tone is taken away: nothing, at any audible pitch.
    const rest = loop.map((v, i) => v - 0.0001 * Math.sin(2 * Math.PI * 30 * i / rate));
    assert.ok(peakOf(rest) < 1e-9, `everything but the tone: ${peakOf(rest)}`);
    for (const hz of [200, 1000, 4000, 10000]) assert.ok(toneAt(loop, rate, hz) < 1e-8, `nothing at ${hz} Hz`);
    // It is played as a loop: the end runs into the beginning without a step (which would click).
    const step = Math.abs(loop[1] - loop[0]); const seam = Math.abs(loop[0] - (loop[loop.length - 1] + (loop[loop.length - 1] - loop[loop.length - 2])));
    assert.ok(seam < step * 0.01, 'the loop closes on itself');
    // Never true silence, even after rounding to 16 bits: no run of zeros longer than a few milliseconds.
    let run = 0; let longest = 0;
    for (const v of loop) { if (Math.round(v * 32768) === 0) { run++; longest = Math.max(longest, run); } else run = 0; }
    assert.ok(longest / rate < 0.004, `longest stretch of 16-bit zeros ${(1000 * longest / rate).toFixed(1)} ms`);
  }
});

test('through the call audio the keep-awake signal stays the faint hiss, and the engine picks by how sound leaves', () => {
  const hiss = keepAwake(new Float32Array(96000), 48000, 'element');
  assert.ok(peakOf(hiss) <= 0.00015 && peakOf(hiss) > 0.00014);
  const rms = Math.sqrt(hiss.reduce((s, v) => s + v * v, 0) / hiss.length);
  assert.ok(Math.abs(db(rms) - db(0.00015 / Math.sqrt(3))) < 0.2, 'evenly spread noise');
  assert.ok(toneAt(hiss, 48000, 30) < 2e-6, 'not a tone: a telephone link would not carry one that low');
  for (const [mode, tone] of [['direct', true], ['element', false]]) {
    const e = engineAt(48000); e.mode = mode;
    const started = []; e.ctx.createBufferSource = () => ({ buffer: null, loop: false, connect () {}, start () { started.push(this); } });
    e._bed();
    assert.equal(started.length, 1); assert.equal(started[0].loop, true);
    const d = started[0].buffer.getChannelData(0);
    assert.equal(d.length, 96000);
    assert.equal(Math.abs(toneAt(d, 48000, 30) - 0.0001) < 1e-6, tone, mode);
  }
});

// ---------- the speech worker's finishing step, run as the worker runs it ----------

/** Loads tts-worker.js into a sandbox with a stand-in voice model and returns a way to talk to it. */
function startWorker ({ modelRate = 44100 } = {}) {
  const out = []; const waiters = [];
  const dir = path.join(here, '..', 'docs', 'js', 'workers');
  const model = { handle: 1, sampleRate: modelRate, numSpeakers: 10, calls: [], generateWithConfig (text, cfg) { this.calls.push({ text, ...cfg }); return { samples: voiceLike(modelRate, 1.5, { amp: text.length % 2 ? 0.05 : 0.4, lead: 0.5 }), sampleRate: modelRate }; } };
  const sandbox = {
    console, performance, setTimeout, clearTimeout, URL, Float32Array, Math, Date, JSON, Set, Map, Promise, Object, Error, String, Number,
    postMessage (m) { out.push(m); for (const w of waiters.splice(0)) w(); },
    startRuntime: async () => ({ HEAPU8: { length: 1 << 20 }, FS: {} }), loadBundle: async () => new Proxy({}, { get: (t, k) => '/tts/' + String(k) }), unlinkAll () {}, heapMiB: () => 1, describeError: e => String(e && e.message || e),
    createOfflineTts: () => model,
    importScripts (...urls) { for (const u of urls) if (String(u).endsWith('dsp.js')) vm.runInContext(fs.readFileSync(path.join(dir, 'dsp.js'), 'utf8'), sandbox, { filename: 'dsp.js' }); }
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'tts-worker.js'), 'utf8'), sandbox, { filename: 'tts-worker.js' });
  const send = m => sandbox.onmessage({ data: m });
  const next = async type => { for (;;) { const i = out.findIndex(m => m.type === type); if (i >= 0) return out.splice(i, 1)[0]; await new Promise(resolve => waiters.push(resolve)); } };
  return { send, next, model, out };
}

test('the speech worker delivers each sentence trimmed, at the standard loudness and at the sound system\'s rate', async () => {
  const w = startWorker();
  w.send({ type: 'init', base: 'http://localhost/', manifest: { bundles: { 'tts-supertonic': { files: [] } } }, voice: 'supertonic' });
  const ready = await w.next('ready');
  assert.equal(ready.sampleRate, 44100);
  // Before the page has opened sound, the rate is not known: the model's own rate is kept.
  w.send({ type: 'speak', id: 1, text: 'even', sid: 5, speed: 1.3, steps: 5 });
  const a = await w.next('audio');
  assert.equal(a.sampleRate, 44100);
  assert.ok(a.samples.length < 44100 * 1.75 && a.samples.length > 44100 * 1.3, 'the half second of silence in front is trimmed to a margin');
  assert.equal(w.model.calls.at(-1).numSteps, 5, 'made at the quality asked for');
  // Once the page says the sound system runs at 48 kHz, that is what arrives.
  w.send({ type: 'rate', sampleRate: 48000 });
  w.send({ type: 'speak', id: 2, text: 'odd', sid: 5, speed: 1.3, steps: 5 });
  const b = await w.next('audio');
  assert.equal(b.sampleRate, 48000);
  assert.ok(Math.abs(b.samples.length / 48000 - a.samples.length / 44100) < 0.01);
  assert.equal(b.audioMs, Math.round(1000 * b.samples.length / 48000));
  // The model's quiet take ("odd": 0.05) and loud take ("even": 0.4) leave at the same loudness.
  const la = db(dsp.speechLevel(a.samples, 44100).rms); const lb = db(dsp.speechLevel(b.samples, 48000).rms);
  assert.ok(Math.abs(la - db(dsp.SPEECH_LEVEL)) < 0.5 && Math.abs(lb - db(dsp.SPEECH_LEVEL)) < 0.5, `levels ${la.toFixed(2)} and ${lb.toFixed(2)} dB`);
  assert.ok(peakOf(a.samples) <= dsp.CEILING + 1e-6 && peakOf(b.samples) <= dsp.CEILING + 1e-6);
  // A phone-call route: delivered at 16 kHz.
  w.send({ type: 'rate', sampleRate: 16000 });
  w.send({ type: 'speak', id: 3, text: 'even', sid: 5, speed: 1.3, steps: 8 });
  const c = await w.next('audio');
  assert.equal(c.sampleRate, 16000);
  assert.equal(w.model.calls.at(-1).numSteps, 8);
});

test('for a fast reading the voice model is asked for a pace it speaks clearly at, and the rest is compression', async () => {
  const w = startWorker();
  w.send({ type: 'init', base: 'http://localhost/', manifest: { bundles: { 'tts-supertonic': { files: [] } } }, voice: 'supertonic' });
  await w.next('ready');
  w.send({ type: 'speak', id: 1, text: 'even', sid: 5, speed: 1.3, steps: 5 });
  const usual = await w.next('audio');
  assert.equal(w.model.calls.at(-1).speed, 1.3, 'up to 1.5x the model speaks at the pace asked for');
  w.send({ type: 'speak', id: 2, text: 'even', sid: 5, speed: 2, steps: 5 });
  const fast = await w.next('audio');
  assert.equal(w.model.calls.at(-1).speed, 1.5, 'the model itself is never asked for 2x');
  assert.equal(w.model.calls.at(-1).numSteps, 5);
  // The stand-in model says the same thing at any pace, so the two clips differ by the compression alone.
  const ratio = (usual.samples.length / usual.sampleRate) / (fast.samples.length / fast.sampleRate);
  assert.ok(Math.abs(ratio - 2 / 1.5) < 0.1, `compressed by ${ratio.toFixed(2)} (2 / 1.5 = 1.33)`);
  assert.ok(Math.abs(db(dsp.speechLevel(fast.samples, fast.sampleRate).rms) - db(dsp.SPEECH_LEVEL)) < 0.5, 'at the standard loudness all the same');
  assert.ok(peakOf(fast.samples) <= dsp.CEILING + 1e-6);
});

test('the page module hands out exactly what the worker script defines', () => {
  assert.deepEqual(Object.keys(dsp).sort(), Object.keys(globalThis.CarbowlDsp).sort());
  for (const k of Object.keys(dsp)) assert.equal(dsp[k], globalThis.CarbowlDsp[k]);
});
