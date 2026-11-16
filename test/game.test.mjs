// Runs whole tossups and bonuses through the real game logic and the real judge, with stand-ins
// for the reader, the listener and the sounds. Speech "arrives" as scripted utterance events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, PHRASES, spellOut } from '../docs/js/game.js';
import { judgeAnswer } from '../docs/js/judge.js';
import { prepareTossup } from '../docs/js/speechtext.js';
import checkAnswer from '../docs/vendor/qb-answer-checker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHARS_PER_SEC = 4000; // the stand-in reader is very fast

const KANT = {
  _id: 'kant', type: 'tossup', category: 'Philosophy', subcategory: 'Philosophy', difficulty: 7,
  question_sanitized: 'This thinker argued that the solution to the problem of causality is obtained by restoring to the pure concepts of the (*) understanding their a priori origin. This author recounted being woken from his dogmatic slumber by David Hume in the preface to his Prolegomena to Any Future Metaphysics. For 10 points, identify this thinker who wrote the Critique of Pure Reason.',
  answer: 'Immanuel <b><u>Kant</u></b>', answer_sanitized: 'Immanuel Kant'
};
const MILL = { _id: 'mill', type: 'tossup', category: 'Philosophy', question_sanitized: 'This thinker wrote On Liberty. For 10 points, name this author of Utilitarianism.', answer: '<b><u>John Stuart Mill</u></b> [prompt on <u>Mill</u> by asking "which one?"; do not accept "James Mill"]', answer_sanitized: 'John Stuart Mill [prompt on Mill by asking "which one?"; do not accept "James Mill"]' };
const BONUS = {
  _id: 'color', type: 'bonus', leadin_sanitized: 'For 10 points each, answer the following about philosophers who wrote about color:',
  parts_sanitized: ['In this work, David Hume presents a thought experiment detailing how the mind can fill in a missing shade of blue. This work also uses the example of billiard balls.', 'This philosopher used bleen and grue as illustrations of his new riddle of induction in his work Fact, Fiction, and Forecast.', 'This author of A Letter Concerning Toleration described how colors are secondary qualities. He also wrote that the mind at birth is a blank slate.'],
  answers: ['An <b><u>Enquiry Concerning Human Understanding</u></b>', 'Nelson <b><u>Goodman</u></b>', 'John <b><u>Locke</u></b>'],
  answers_sanitized: ['An Enquiry Concerning Human Understanding', 'Nelson Goodman', 'John Locke']
};

function makeWorld ({ questions, rules = {}, onMode, onState, limit, assistant }) {
  const t0 = performance.now();
  const audio = { get time () { return (performance.now() - t0) / 1000; }, tone: () => 0, latency: 0 };
  const spoken = []; const tones = []; const modes = []; const states = []; const logs = []; const reads = [];
  audio.tone = name => { tones.push(name); return 0; };
  let groupN = 0;
  const narrator = {
    current: null,
    newGroup: l => `${l}-${++groupN}`,
    prepare () {}, synth: () => Promise.resolve({ samples: new Float32Array(10), sampleRate: 16000 }),
    stop () { if (this.current) this.current.stop(); },
    async say (text) { spoken.push(text); await sleep(3); return 'ended'; },
    read (chunks, { onProgress, from = 0 } = {}) {
      reads.push({ from, first: chunks.length ? chunks[0].text.slice(0, 24) : '' });
      const total = chunks.length ? chunks[chunks.length - 1].end : 0;
      let base = from; let startedAt = audio.time; let state = 'reading'; let resolveDone; let timer = null;
      const pos = () => state === 'reading' ? Math.min(total, base + (audio.time - startedAt) * CHARS_PER_SEC) : base;
      const done = new Promise(resolve => { resolveDone = resolve; });
      const arm = () => { timer = setTimeout(() => { if (state === 'reading') { base = total; state = 'finished'; resolveDone('finished'); } }, Math.max(0, (total - base) / CHARS_PER_SEC * 1000)); };
      arm();
      const reading = {
        kind: 'reading', done,
        get state () { return state; },
        positionAt: t => state === 'reading' ? Math.round(Math.max(0, Math.min(total, base + (t - startedAt) * CHARS_PER_SEC))) : Math.round(base),
        position: () => Math.round(pos()),
        textBetween: (a, b, full) => full.slice(Math.max(0, reading.positionAt(a) - 12), reading.positionAt(b) + 12),
        pause () { if (state !== 'reading') return; base = pos(); state = 'paused'; clearTimeout(timer); },
        resume () { if (state !== 'paused') return; state = 'reading'; startedAt = audio.time; arm(); },
        stop () { if (state === 'stopped' || state === 'finished') return; base = pos(); state = 'stopped'; clearTimeout(timer); resolveDone('stopped'); }
      };
      narrator.current = reading;
      return reading;
    }
  };
  const listener = new EventTarget();
  listener.mode = 'off';
  listener.setMode = (mode, opts) => { listener.mode = mode; modes.push(mode); if (onMode) onMode(mode, world, opts); };
  const hear = (text, { dur = 0.4, type = 'utterance' } = {}) => listener.dispatchEvent(new CustomEvent(type, { detail: { text, start: audio.time - dur, end: audio.time, dur, level: 0.05 } }));
  const queue = questions.slice();
  const feed = { next: async type => { const q = queue.shift(); if (!q) { const e = new Error('none'); e.name = 'NoQuestionsError'; throw e; } return { ...q }; }, prefetch () {} };
  const game = new Game({
    feed, narrator, listener, audio, assistant,
    judge: (answerline, transcripts, previous) => judgeAnswer({ answerline, transcripts, previous, checkAnswer }),
    rules: () => ({ tossupDeadSec: 0.12, bonusAnswerSec: 0.12, answerStartSec: 0.15, answerMaxSec: 0.6, betweenSec: 0.04, sentenceGapSec: 0, holdMaxSec: 0.12, confirmSec: 0.1, followUpSec: 0.06, ...rules }),
    ui: { onState: (s, extra) => { states.push(s); if (onState) onState(s, extra || {}, world); } },
    log: m => logs.push(m)
  });
  const world = { game, narrator, listener, audio, spoken, tones, modes, states, logs, reads, hear, run: () => game.run({ limit: limit || questions.length }) };
  return world;
}
/** A slower stand-in question, so that things can happen while it is still being read. */
const LONG = { ...KANT, _id: 'long', question_sanitized: (KANT.question_sanitized + ' ').repeat(3).trim() };

/** Fires fn once, the first time the listener enters the given mode after `skip` earlier entries. */
const onceMode = (mode, fn, skip = 0) => { let seen = 0; let done = false; return (m, w) => { if (m !== mode || done) return; if (seen++ < skip) return; done = true; setTimeout(() => fn(w), 8); }; };
const chain = (...fns) => (...args) => { for (const f of fns) f(...args); };

test('tossup: early buzz and correct answer earns power', async () => {
  const w = makeWorld({ questions: [KANT], onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => w.hear('Immanuel Kant.'))) });
  await w.run();
  const rec = w.game.history[0];
  assert.equal(rec.result, 'power'); assert.equal(rec.points, 15);
  assert.ok(rec.buzzOffset < rec.powerOffset, `buzz ${rec.buzzOffset} before power ${rec.powerOffset}`);
  assert.ok(w.spoken.includes(PHRASES.power));
  assert.ok(w.spoken.includes('The answer is Immanuel Kant.'));
  assert.deepEqual(w.tones.filter(t => t !== 'ready'), ['buzz', 'power']);
  assert.equal(w.game.score().points, 15);
});

test('tossup: nobody buzzes, time is called and the answer is given', async () => {
  const w = makeWorld({ questions: [KANT] });
  await w.run();
  const rec = w.game.history[0];
  assert.equal(rec.result, 'dead'); assert.equal(rec.points, 0);
  assert.ok(w.spoken.includes(PHRASES.time));
  assert.ok(w.spoken.includes('The answer is Immanuel Kant.'));
  assert.ok(w.states.includes('waiting'));
});

test('tossup: wrong answer on an early buzz is a neg, and the app says what it heard', async () => {
  const w = makeWorld({ questions: [KANT], onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => w.hear('David Hume.'))) });
  await w.run();
  const rec = w.game.history[0];
  assert.equal(rec.result, 'neg'); assert.equal(rec.points, -5);
  assert.ok(w.spoken.includes(PHRASES.incorrect));
  assert.ok(w.spoken.includes('I heard: David Hume.'));
  assert.ok(w.spoken.includes('The answer is Immanuel Kant.'));
});

test('tossup: buzz after the question has been read earns ten, or zero when wrong', async () => {
  const afterReading = text => ({ onState: (s, extra, w) => { if (s === 'waiting' && !w.fired) { w.fired = true; setTimeout(() => w.hear('Buzz.'), 10); } }, onMode: onceMode('answer', w => w.hear(text)) });
  const a = makeWorld({ questions: [KANT], ...afterReading('Kant') });
  await a.run();
  assert.equal(a.game.history[0].result, 'ten'); assert.equal(a.game.history[0].points, 10);
  const b = makeWorld({ questions: [KANT], ...afterReading('Hegel') });
  await b.run();
  assert.equal(b.game.history[0].result, 'wrong'); assert.equal(b.game.history[0].points, 0);
});

test('tossup: buzz and answer in one breath', async () => {
  const w = makeWorld({ questions: [KANT], onMode: onceMode('spot', w => w.hear('Buzz, Immanuel Kant.', { dur: 1.2 })) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power');
  assert.equal(w.game.history[0].heard, 'immanuel kant');
});

test('tossup: a misheard name is accepted by sound', async () => {
  const w = makeWorld({ questions: [KANT], onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => w.hear("Emmanuel can't."))) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power');
});

test('tossup: silence after a buzz counts as no answer', async () => {
  const w = makeWorld({ questions: [KANT], onMode: onceMode('spot', w => w.hear('Buzz.')) });
  await w.run();
  assert.equal(w.game.history[0].result, 'neg');
  assert.ok(w.spoken.includes(PHRASES.noAnswer));
  assert.ok(!w.spoken.some(s => s.startsWith('I heard')));
});

test('tossup: "um" does not count as the answer; the app keeps listening', async () => {
  const w = makeWorld({ questions: [KANT], rules: { answerStartSec: 0.2, answerMaxSec: 2 }, onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => { w.hear('Um.'); setTimeout(() => w.hear('Kant.'), 60); })) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power');
});

test('tossup: the reader hearing itself is ignored, and so is unrelated talk', async () => {
  const text = prepareTossup(KANT).text;
  const w = makeWorld({ questions: [KANT], onMode: onceMode('spot', w => {
    w.hear(text.slice(0, 40), { dur: 0.6 });                                  // echo of the first words
    w.hear('We should stop for gas at the next exit.', { dur: 2.5 });          // passenger
  }) });
  await w.run();
  assert.equal(w.game.history[0].result, 'dead');
  assert.ok(w.logs.some(l => /own voice/.test(l)));
});

test('tossup: strict mode needs the word buzz; normal mode takes any short word', async () => {
  const strict = makeWorld({ questions: [KANT], rules: { buzzSensitivity: 'strict' }, onMode: onceMode('spot', w => w.hear('That is.', { dur: 0.4 })) });
  await strict.run();
  assert.equal(strict.game.history[0].result, 'dead');
  const normal = makeWorld({ questions: [KANT], onMode: chain(onceMode('spot', w => w.hear('This.', { dur: 0.4 })), onceMode('answer', w => w.hear('Kant'))) });
  await normal.run();
  assert.equal(normal.game.history[0].result, 'power');
});

test('tossup: tapping works as a buzz when listening is off', async () => {
  const w = makeWorld({ questions: [KANT], rules: { buzzSensitivity: 'off' }, onState: (s, e, w) => { if (s === 'reading' && !w.fired) { w.fired = true; setTimeout(() => w.game.act('buzz'), 10); } }, onMode: onceMode('answer', w => w.hear('Kant')) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power');
  assert.ok(!w.modes.includes('spot'));
});

test('tossup: a prompt asks again and accepts the fuller answer', async () => {
  let n = 0;
  const w = makeWorld({ questions: [MILL], onMode: (m, w) => { if (m === 'spot' && !w.buzzed) { w.buzzed = true; setTimeout(() => w.hear('Buzz.'), 5); } if (m === 'answer') { n++; setTimeout(() => w.hear(n === 1 ? 'Mill.' : 'John Stuart Mill.'), 8); } } });
  await w.run();
  assert.ok(w.spoken.some(s => /^Prompt\. which one\?/i.test(s)), w.spoken.join(' | '));
  assert.equal(w.game.history[0].points > 0, true);
  assert.ok(w.tones.includes('prompt'));
});

test('tossup: saying "repeat question" starts the question again', async () => {
  const w = makeWorld({ questions: [KANT], onMode: onceMode('spot', w => w.hear('Repeat question.', { dur: 0.9 })) });
  await w.run();
  assert.ok(w.spoken.includes(PHRASES.restart));
  assert.equal(w.game.history[0].result, 'dead');
});

test('bonus: answering by simply speaking, during and after the reading', async () => {
  let part = -1;
  const w = makeWorld({
    questions: [BONUS],
    onState: (s, extra, w) => {
      if (s !== 'reading' || extra.type !== 'bonus' || extra.part === part || extra.part < 0) return;
      part = extra.part;
      if (part === 0) setTimeout(() => { w.hear('', { type: 'speechstart' }); setTimeout(() => w.hear('An inquiry concerning human understanding.', { dur: 1.8 }), 15); }, 12); // interrupts the reading
      // part 1: says nothing; part 2: answers wrongly after the reading
      if (part === 2) w.wantWrong = true;
    },
    onMode: (m, w) => {}
  });
  const origOnState = w.game.ui.onState;
  w.game.ui.onState = (s, extra) => { origOnState(s, extra); if (s === 'waiting' && w.wantWrong && !w.saidWrong) { w.saidWrong = true; setTimeout(() => w.hear('Thomas Hobbes.', { dur: 0.8 }), 10); } };
  await w.run();
  const rec = w.game.history[0];
  assert.deepEqual(rec.parts.map(p => p.result), ['correct', 'none', 'wrong']);
  assert.equal(rec.points, 10);
  assert.ok(w.spoken.includes(PHRASES.points10));
  assert.ok(w.spoken.includes('I heard: Thomas Hobbes.'));
  assert.ok(w.spoken.includes('The answer is Nelson Goodman.'));
  assert.ok(w.spoken.includes('The answer is John Locke.'));
  const s = w.game.score();
  assert.equal(s.bonuses, 1); assert.equal(s.bonusPoints, 10); assert.equal(s.bonusCorrect, 1);
});

test('bonus: a cough pauses the reading, which then carries on', async () => {
  const w = makeWorld({
    questions: [BONUS], rules: { bonusAnswerSec: 0.1 },
    onState: (s, extra, w) => { if (s === 'reading' && extra.type === 'bonus' && extra.part === 0 && !w.coughed) { w.coughed = true; setTimeout(() => { w.hear('', { type: 'speechstart' }); setTimeout(() => w.listener.dispatchEvent(new CustomEvent('speechend', { detail: { dropped: true } })), 10); }, 10); } }
  });
  await w.run();
  const rec = w.game.history[0];
  assert.deepEqual(rec.parts.map(p => p.result), ['none', 'none', 'none']);
  assert.equal(rec.points, 0);
  assert.ok(w.spoken.includes(PHRASES.points0));
});

test('pause and resume by tap keep the question going', async () => {
  const w = makeWorld({ questions: [KANT], onState: (s, e, w) => { if (s === 'reading' && !w.fired) { w.fired = true; setTimeout(() => { w.game.requestPause(); w.game.requestPause(); }, 10); setTimeout(() => w.game.act('resume'), 60); } } });
  await w.run();
  assert.ok(w.spoken.includes(PHRASES.paused)); assert.ok(w.spoken.includes(PHRASES.resumed));
  assert.equal(w.game.history[0].result, 'dead');
  assert.ok(w.states.includes('paused'));
});

test('"pause quiz" and "resume" by voice; the listening mode is restored', async () => {
  const w = makeWorld({ questions: [KANT], onMode: onceMode('spot', w => { w.hear('Pause quiz.', { dur: 0.8 }); setTimeout(() => w.hear('Resume.', { dur: 0.5 }), 50); }) });
  await w.run();
  assert.ok(w.spoken.includes(PHRASES.paused)); assert.ok(w.spoken.includes(PHRASES.resumed));
  assert.equal(w.game.history[0].result, 'dead');
});

test('"skip question" moves on and still gives the answer', async () => {
  const w = makeWorld({ questions: [KANT, MILL], onMode: onceMode('spot', w => w.hear('Skip question.', { dur: 0.9 })) });
  await w.run();
  assert.equal(w.game.history[0].result, 'skipped');
  assert.ok(w.spoken.includes(PHRASES.skipped)); assert.ok(w.spoken.includes('The answer was Immanuel Kant.'));
  assert.equal(w.game.history.length, 2);
  assert.equal(w.game.score().tossups, 1, 'a skipped question is not counted');
});

test('"I was right" after a wrong verdict flips it; "I was wrong" flips it back', async () => {
  const w = makeWorld({ questions: [KANT, MILL], rules: { betweenSec: 0.25 }, onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => w.hear('Hegel.'))), onState: (s, e, w) => { if (s === 'between' && !w.said) { w.said = true; setTimeout(() => w.hear('I was right.', { dur: 0.9 }), 10); } } });
  await w.run();
  const rec = w.game.history[0];
  assert.equal(rec.result, 'power'); assert.equal(rec.points, 15); assert.equal(rec.overridden, true);
  assert.ok(w.spoken.includes(PHRASES.markedRight));
  assert.equal(w.game.override(rec, false), true);
  assert.equal(rec.result, 'neg'); assert.equal(rec.points, -5);
  assert.equal(w.game.override(rec, false), false, 'no change the second time');
});

test('tossups and bonuses alternate; stop ends the session cleanly', async () => {
  const w = makeWorld({ questions: [KANT, BONUS, MILL], limit: 3 });
  await w.run();
  assert.deepEqual(w.game.history.map(h => h.type), ['tossup', 'bonus', 'tossup']);
  assert.equal(w.game.running, false);
  const v = makeWorld({ questions: [KANT, BONUS, MILL], limit: 3, onState: (s, e, w) => { if (s === 'reading' && !w.fired) { w.fired = true; setTimeout(() => w.game.stop(), 10); } } });
  await v.run();
  assert.equal(v.game.history.length, 0);
  assert.equal(v.game.running, false);
  assert.equal(v.states[v.states.length - 1], 'idle');
});

test('running out of questions is announced, not fatal', async () => {
  const w = makeWorld({ questions: [KANT], limit: 5 });
  await w.run();
  assert.equal(w.game.history.length, 1);
  assert.ok(w.spoken.includes(PHRASES.noQuestions));
});

test('real questions: twenty tossups and bonuses play through without a hitch', async () => {
  const fx = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
  const tossups = fx('tossups-philosophy.json').tossups.slice(0, 10).map(t => ({ ...t, type: 'tossup' }));
  const bonuses = fx('bonuses-philosophy.json').bonuses.slice(0, 10).map(b => ({ ...b, type: 'bonus' }));
  const questions = []; for (let i = 0; i < 10; i++) questions.push(tossups[i], bonuses[i]);
  const w = makeWorld({ questions, rules: { tossupDeadSec: 0.02, bonusAnswerSec: 0.02, betweenSec: 0.01 } });
  await w.run();
  assert.equal(w.game.history.length, 20);
  assert.ok(w.game.history.every(h => h.result !== 'skipped'), 'no question errored');
  assert.ok(!w.logs.some(l => /failed/.test(l)), w.logs.filter(l => /failed/.test(l)).join('\n'));
});

test('"read faster" is passed to the app and the question carries on', async () => {
  const asked = [];
  const w = makeWorld({ questions: [KANT], onMode: chain(onceMode('spot', w => { w.hear('Read faster.', { dur: 0.8 }); setTimeout(() => w.hear('Slow down.', { dur: 0.8 }), 15); setTimeout(() => w.hear('Buzz.'), 30); }), onceMode('answer', w => w.hear('Kant'))) });
  w.game.ui.onCommand = c => asked.push(c);
  await w.run();
  assert.deepEqual(asked, ['faster', 'slower']);
  assert.equal(w.game.history[0].result, 'power', 'the speed requests neither buzzed nor ended the question');
});

test('a pause inside a two-word command does not turn its first word into a buzz', async () => {
  const asked = [];
  const w = makeWorld({ questions: [KANT], rules: { commandHoldSec: 0.08 }, onMode: chain(onceMode('spot', w => { w.hear('Raid.', { dur: 0.4 }); setTimeout(() => w.hear('Faster.', { dur: 0.5 }), 25); setTimeout(() => w.hear('Buzz.'), 70); }), onceMode('answer', w => w.hear('Kant'))) });
  w.game.ui.onCommand = c => asked.push(c);
  await w.run();
  assert.deepEqual(asked, ['faster']);
  assert.equal(w.game.history[0].result, 'power');
  assert.ok(!w.logs.some(l => /short blurt/.test(l)), 'the lone first word was not treated as a buzz');
});

test('"pause ... quiz" in two halves pauses; a lone "pause" still counts as a short-word buzz', async () => {
  const a = makeWorld({ questions: [KANT], rules: { commandHoldSec: 0.08 }, onMode: onceMode('spot', w => { w.hear('Pause.', { dur: 0.4 }); setTimeout(() => w.hear('Quiz.', { dur: 0.4 }), 20); setTimeout(() => w.game.act('resume'), 90); }) });
  await a.run();
  assert.ok(a.spoken.includes(PHRASES.paused)); assert.equal(a.game.history[0].result, 'dead');
  const b = makeWorld({ questions: [KANT], rules: { commandHoldSec: 0.05 }, onMode: chain(onceMode('spot', w => w.hear('Pause.', { dur: 0.4 })), onceMode('answer', w => w.hear('Kant'))) });
  await b.run();
  assert.equal(b.game.history[0].result, 'power');
  assert.ok(b.logs.some(l => /short blurt/.test(l)));
});

test('a held first word followed by something else: both are handled, in order', async () => {
  const w = makeWorld({ questions: [KANT], rules: { commandHoldSec: 0.08 }, onMode: chain(onceMode('spot', w => { w.hear('Read.', { dur: 0.4 }); setTimeout(() => w.hear('Immanuel Kant is the answer here.', { dur: 2.4 }), 20); }), onceMode('answer', w => w.hear('Kant'))) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power', 'the lone word became the buzz; the long sentence was not a command');
});

test('ending in the middle of a bonus keeps the parts already answered, and every finished question is handed over for saving', async () => {
  const saved = [];
  const w = makeWorld({ questions: [KANT, BONUS], limit: 2, onState: (s, extra, w) => { if (s === 'reading' && extra.type === 'bonus' && extra.part === 1 && !w.fired) { w.fired = true; setTimeout(() => w.game.stop(), 5); } } });
  w.game.ui.onSaved = rec => saved.push(`${rec.type}:${rec.type === 'tossup' ? rec.result : rec.parts.map(p => p.result).join(',')}`);
  await w.run();
  assert.deepEqual(w.game.history.map(h => h.type), ['tossup', 'bonus']);
  assert.deepEqual(w.game.history[1].parts.map(p => p.result), ['none', null, null]);
  assert.deepEqual(saved, ['tossup:dead', 'bonus:none,,']);
  // Correcting a verdict hands the record over again.
  w.game.override(w.game.history[1], true, 0);
  assert.equal(saved[2], 'bonus:correct,,');
});

// ---- the reader stops for a voice ------------------------------------------------------

test('hold: the reader stops the moment a voice starts, and the buzz counts from that moment', async () => {
  let pausedAt = null;
  const w = makeWorld({ questions: [LONG], rules: { holdMaxSec: 1 }, onMode: chain(onceMode('spot', w => {
    w.hear('', { type: 'speechstart' });
    setTimeout(() => { pausedAt = w.game.reading && w.game.reading.state; }, 15);
    setTimeout(() => w.hear('Buzz.', { dur: 0.03 }), 40);
  }), onceMode('answer', w => w.hear('Kant'))) });
  await w.run();
  const rec = w.game.history[0];
  assert.equal(pausedAt, 'paused', 'reading stopped as soon as speech began');
  assert.equal(rec.result, 'power');
  assert.ok(rec.buzzOffset < prepareTossup(LONG).text.length / 2, `buzz placed where the voice began (${rec.buzzOffset})`);
});

test('hold: a noise or unrelated talk only interrupts the reader briefly', async () => {
  const w = makeWorld({ questions: [LONG], rules: { holdMaxSec: 1 }, onMode: onceMode('spot', w => {
    w.hear('', { type: 'speechstart' });
    setTimeout(() => w.listener.dispatchEvent(new CustomEvent('speechend', { detail: { dropped: true } })), 15);
    setTimeout(() => w.hear('', { type: 'speechstart' }), 40);
    setTimeout(() => w.hear('We should stop for gas at the next exit.', { dur: 0.02 }), 60);
  }) });
  await w.run();
  assert.equal(w.game.history[0].result, 'dead', 'the question was read to the end');
  assert.equal(w.logs.filter(l => /^carried on reading/.test(l)).length, 2);
  assert.equal(w.reads.length, 1, 'the same reading carried on; nothing was restarted');
});

test('hold: with no words at all the reader carries on by itself', async () => {
  const w = makeWorld({ questions: [LONG], rules: { holdMaxSec: 0.05 }, onMode: onceMode('spot', w => { w.hear('', { type: 'speechstart' }); setTimeout(() => w.listener.dispatchEvent(new CustomEvent('speechend', { detail: { dropped: false } })), 5); }) });
  await w.run();
  assert.equal(w.game.history[0].result, 'dead');
  assert.ok(w.logs.some(l => /no words followed/.test(l)));
});

test('hold: after repeated false alarms the reader stops stopping (automatic setting only)', async () => {
  const cough = w => { w.hear('', { type: 'speechstart' }); setTimeout(() => w.listener.dispatchEvent(new CustomEvent('speechend', { detail: { dropped: true } })), 4); };
  const run = async rules => { const w = makeWorld({ questions: [LONG], rules, onMode: onceMode('spot', w => { for (let i = 0; i < 6; i++) setTimeout(() => cough(w), 10 + i * 22); }) }); await w.run(); return w; };
  const auto = await run({});
  assert.ok(auto.logs.some(l => /no longer stops at the first sound/.test(l)));
  assert.equal(auto.logs.filter(l => /^carried on reading/.test(l)).length, 4, 'four false alarms, then no more holds');
  const always = await run({ holdOnVoice: 'on' });
  assert.equal(always.logs.filter(l => /^carried on reading/.test(l)).length, 6);
  const never = await run({ holdOnVoice: 'off' });
  assert.equal(never.logs.filter(l => /^carried on reading/.test(l)).length, 0);
});

// ---- sounds that could not be made out ---------------------------------------------------

test('unclear: a short sound that was not understood is asked for again, and then counts as the buzz', async () => {
  const w = makeWorld({ questions: [LONG], rules: { confirmSec: 0.5 }, onMode: chain(onceMode('spot', w => { w.hear('', { dur: 0.3 }); setTimeout(() => w.hear('Buzz.'), 40); }), onceMode('answer', w => w.hear('Kant'))) });
  await w.run();
  const rec = w.game.history[0];
  assert.ok(w.tones.includes('unsure'));
  assert.equal(rec.result, 'power');
  assert.ok(w.logs.some(l => /said again/.test(l)));
  assert.ok(rec.buzzOffset < prepareTossup(LONG).text.length / 2, `the buzz counts from the first sound (${rec.buzzOffset})`);
});

test('unclear: saying the answer itself after "say again?" is taken as buzz and answer', async () => {
  const w = makeWorld({ questions: [LONG], rules: { confirmSec: 0.5 }, onMode: onceMode('spot', w => { w.hear('', { dur: 0.3 }); setTimeout(() => w.hear('Immanuel Kant.', { dur: 0.9 }), 40); }) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power'); assert.equal(w.game.history[0].heard, 'Immanuel Kant.');
});

test('unclear: if nothing follows, the reading carries on with no penalty; strict mode never asks', async () => {
  const w = makeWorld({ questions: [LONG], rules: { confirmSec: 0.04 }, onMode: onceMode('spot', w => w.hear('', { dur: 0.3 })) });
  await w.run();
  assert.equal(w.game.history[0].result, 'dead'); assert.equal(w.game.history[0].points, 0);
  assert.ok(w.logs.some(l => /not repeated/.test(l)));
  const strict = makeWorld({ questions: [LONG], rules: { buzzSensitivity: 'strict' }, onMode: onceMode('spot', w => w.hear('', { dur: 0.3 })) });
  await strict.run();
  assert.ok(!strict.tones.includes('unsure'));
});

test('unclear: asking is given up when it keeps leading nowhere', async () => {
  const w = makeWorld({ questions: [LONG, LONG, LONG], rules: { confirmSec: 0.01, mode: 'tossups' }, onMode: (m, w) => { if (m === 'spot') { for (let i = 0; i < 3; i++) setTimeout(() => w.hear('', { dur: 0.3 }), 8 + i * 30); } } });
  await w.run();
  assert.equal(w.tones.filter(t => t === 'unsure').length, 4, 'four tries, then silence about it');
});

// ---- answers ------------------------------------------------------------------------------

test('a second "buzz" said because the first seemed unheard is not taken for the answer', async () => {
  const w = makeWorld({ questions: [KANT], rules: { answerStartSec: 0.3, answerMaxSec: 2 }, onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => { w.hear('Buzz.'); setTimeout(() => w.hear('Buzz buzz.'), 20); setTimeout(() => w.hear('Kant.'), 50); })) });
  await w.run();
  assert.equal(w.game.history[0].result, 'power');
  assert.ok(!w.spoken.some(s => /^I heard: buzz/i.test(s)));
});

test('"never mind" takes a buzz back: no penalty, and the reading picks up where it stopped', async () => {
  const w = makeWorld({ questions: [LONG], onMode: chain(onceMode('spot', w => setTimeout(() => w.hear('Buzz.', { dur: 0.01 }), 60)), onceMode('answer', w => w.hear('Never mind.', { dur: 0.7 }))) });
  await w.run();
  const rec = w.game.history[0];
  assert.ok(w.spoken.includes(PHRASES.cancelled));
  assert.equal(rec.result, 'dead'); assert.equal(rec.points, 0); assert.equal(rec.buzzOffset, null);
  assert.equal(w.reads.length, 2); assert.ok(w.reads[1].from > 100, `resumed mid-question (${w.reads[1].from})`);
});

// ---- hearing it again ---------------------------------------------------------------------

test('"what were the earlier clues" starts the question again; "go back" repeats only the last sentence', async () => {
  const a = makeWorld({ questions: [LONG], onMode: onceMode('spot', w => setTimeout(() => w.hear('What were the earlier clues?', { dur: 0.01 }), 60)) });
  await a.run();
  assert.ok(a.spoken.includes(PHRASES.restart)); assert.deepEqual(a.reads.map(r => r.from), [0, 0]);
  const b = makeWorld({ questions: [LONG], onMode: onceMode('spot', w => setTimeout(() => w.hear('Go back.', { dur: 0.01 }), 150)) });
  await b.run();
  assert.ok(!b.spoken.includes(PHRASES.restart));
  assert.equal(b.reads.length, 2);
  const starts = prepareTossup(LONG).chunks.map(c => c.start);
  assert.ok(b.reads[1].from > 0 && starts.includes(b.reads[1].from), `restarted at the start of a sentence (${b.reads[1].from})`);
  assert.equal(b.game.history[0].result, 'dead');
});

test('bonus: "repeat the question" reads the part again from its start', async () => {
  const w = makeWorld({ questions: [BONUS], rules: { bonusDirectAnswer: false }, onState: (s, extra, w) => { if (s === 'reading' && extra.part === 0 && !w.asked) { w.asked = true; setTimeout(() => w.hear('Repeat the question.', { dur: 0.01 }), 15); } } });
  await w.run();
  assert.equal(w.reads.filter(r => r.first.startsWith('In this work, David Hume')).length, 2);
  assert.deepEqual(w.game.history[0].parts.map(p => p.result), ['none', 'none', 'none']);
});

// ---- the assistant ------------------------------------------------------------------------

test('built-in requests: the last answer, its spelling, the score, and what this question is', async () => {
  assert.equal(spellOut('Kant'), 'K, A, N, T');
  assert.equal(spellOut('Søren Kierkegaard'), 'Soren: S, O, R, E, N. Kierkegaard: K, I, E, R, K, E, G, A, A, R, D');
  const w = makeWorld({
    questions: [KANT, { ...MILL, set: { name: 'ACF Regionals' }, subcategory: 'Philosophy', difficulty: 8 }], rules: { betweenSec: 0.3, mode: 'tossups' },
    onMode: chain(onceMode('spot', w => w.hear('Buzz.')), onceMode('answer', w => w.hear('Kant'))),
    onState: (s, e, w) => {
      if (s === 'between' && !w.a) { w.a = true; setTimeout(() => w.hear('What was the answer?', { dur: 0.9 }), 5); setTimeout(() => w.hear('Spell that.', { dur: 0.6 }), 40); setTimeout(() => w.hear("What's my score?", { dur: 0.8 }), 80); }
      if (s === 'reading' && w.a && !w.b) { w.b = true; setTimeout(() => w.hear('What set is this from?', { dur: 0.01 }), 5); setTimeout(() => w.hear('What was the answer?', { dur: 0.01 }), 30); }
    }
  });
  await w.run();
  assert.ok(w.spoken.includes('The answer was Immanuel Kant.'), w.spoken.join(' | '));
  assert.ok(w.spoken.includes('Immanuel Kant. Spelled: Immanuel: I, M, M, A, N, U, E, L. Kant: K, A, N, T.'), w.spoken.join(' | '));
  assert.ok(w.spoken.includes('15 points. 1 of 1 tossups, 1 for power.'), w.spoken.join(' | '));
  assert.ok(w.spoken.includes('This is a tossup on Philosophy, from ACF Regionals, Regionals College level.'), w.spoken.join(' | '));
  assert.ok(w.spoken.includes('The last answer was Immanuel Kant.'), 'during a live question only an earlier answer is given');
  assert.equal(w.game.history[1].result, 'dead', 'the second question carried on to its end');
});

test('built-in requests: the answer to a question still in play is never given', async () => {
  const w = makeWorld({ questions: [LONG], onMode: onceMode('spot', w => setTimeout(() => w.hear('What is the answer?', { dur: 0.01 }), 30)) });
  await w.run();
  assert.ok(w.spoken.includes(PHRASES.notYet));
  assert.equal(w.spoken.filter(s => /Immanuel Kant/.test(s)).length, 1, 'only the reveal at the end names it');
});

test('assistant: "Moderator, ..." is put to the assistant with the quiz as context, and the question carries on', async () => {
  const calls = [];
  const assistant = { available: () => true, ask: async ({ text, context, talk, say }) => { calls.push({ text, context: JSON.parse(JSON.stringify(context)), talk: talk.length }); say('Hume argued that causation is only habit.'); say('Kant answered him.'); return {}; } };
  const w = makeWorld({ questions: [LONG], assistant, onMode: onceMode('spot', w => setTimeout(() => { w.hear('', { type: 'speechstart' }); setTimeout(() => w.hear('Moderator, who was David Hume?', { dur: 0.02 }), 10); }, 50)) });
  await w.run();
  assert.equal(calls.length, 1); assert.equal(calls[0].text, 'who was david hume');
  const c = calls[0].context.current;
  assert.equal(c.type, 'tossup'); assert.equal(c.live, true);
  assert.ok(c.readSoFar.length > 20 && c.readSoFar.length < prepareTossup(LONG).text.length, 'only what has been read so far is passed on');
  assert.equal(JSON.stringify(calls[0].context).includes('Immanuel Kant'), false, 'the answer to the live question is withheld from the assistant');
  assert.ok(w.spoken.includes('Hume argued that causation is only habit.') && w.spoken.includes('Kant answered him.'));
  assert.ok(w.states.includes('assistant'));
  assert.equal(w.game.history[0].result, 'dead', 'the reading resumed and finished');
  assert.equal(w.reads.length, 1);
});

test('assistant: the wake word alone opens the floor; a follow-up needs no wake word; "thanks" ends it', async () => {
  const asked = [];
  const assistant = { available: () => true, ask: async ({ text, talk, say }) => { asked.push([text, talk.length]); say('Answer to ' + text + '.'); return {}; } };
  const w = makeWorld({
    questions: [LONG], assistant, rules: { followUpSec: 0.4, answerStartSec: 0.4 },
    onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator.', { dur: 0.01 }), 40)),
    onState: (s, e, w) => {
      if (s !== 'asking') return;
      w.n = (w.n || 0) + 1;
      if (w.n === 1) setTimeout(() => w.hear('What is the categorical imperative?', { dur: 1.5 }), 10);
      if (w.n === 2) setTimeout(() => w.hear('And who opposed it?', { dur: 1 }), 10);
      if (w.n === 3) setTimeout(() => w.hear('Thanks.', { dur: 0.4 }), 10);
    }
  });
  await w.run();
  assert.deepEqual(asked, [['What is the categorical imperative?', 0], ['And who opposed it?', 2]]);
  assert.ok(w.tones.includes('listen'));
  assert.equal(w.game.history[0].result, 'dead');
});

test('assistant: what it asks the quiz to do is done (repeat, skip), and "Moderator, skip" needs no model', async () => {
  const assistant = { available: () => true, ask: async ({ text, say }) => { say('Sure.'); return { action: /again/.test(text) ? 'repeat' : 'skip' }; } };
  const a = makeWorld({ questions: [LONG], assistant, onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator, read that again from the top please.', { dur: 0.01 }), 60)) });
  await a.run();
  assert.deepEqual(a.reads.map(r => r.from), [0, 0]); assert.equal(a.game.history[0].result, 'dead');
  const b = makeWorld({ questions: [LONG], assistant, onMode: onceMode('spot', w => setTimeout(() => w.hear('Computer, I give up on this one.', { dur: 0.01 }), 30)) });
  await b.run();
  assert.equal(b.game.history[0].result, 'skipped');
  let called = 0;
  const c = makeWorld({ questions: [LONG], assistant: { available: () => true, ask: async () => { called++; return {}; } }, onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator, skip.', { dur: 0.01 }), 30)) });
  await c.run();
  assert.equal(c.game.history[0].result, 'skipped'); assert.equal(called, 0);
});

test('assistant: without a key it says so; a failure is spoken and the quiz goes on; free questions need a key', async () => {
  const none = makeWorld({ questions: [LONG], onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator, who was Hume?', { dur: 0.01 }), 30)) });
  await none.run();
  assert.ok(none.spoken.includes(PHRASES.needKey)); assert.equal(none.game.history[0].result, 'dead');
  const broken = makeWorld({ questions: [LONG], assistant: { available: () => true, ask: async () => { throw Object.assign(new Error('HTTP 529'), { spoken: 'The assistant is busy. Try again in a moment.' }); } }, onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator, who was Hume?', { dur: 0.01 }), 30)) });
  await broken.run();
  assert.ok(broken.spoken.includes('The assistant is busy. Try again in a moment.')); assert.equal(broken.game.history[0].result, 'dead');
  // Between questions a question needs no wake word, but only when there is an assistant to ask.
  let asked = 0;
  const between = assistant => makeWorld({ questions: [KANT, MILL], assistant, rules: { betweenSec: 0.2, mode: 'tossups' }, onState: (s, e, w) => { if (s === 'between' && !w.a) { w.a = true; setTimeout(() => w.hear('Why is that the answer?', { dur: 1 }), 5); } } });
  const withKey = between({ available: () => true, ask: async ({ say }) => { asked++; say('Because.'); return {}; } });
  await withKey.run();
  assert.equal(asked, 1);
  const without = between(undefined);
  await without.run();
  assert.ok(!without.spoken.includes(PHRASES.needKey), 'no nagging about a key for idle talk');
});

test('assistant: its own voice coming back is not taken for a request, and "stop" cuts it short', async () => {
  let resolveAsk;
  const assistant = { available: () => true, ask: ({ say }) => new Promise(resolve => { say('The moderator reads the question aloud.'); resolveAsk = resolve; }) };
  const w = makeWorld({ questions: [LONG], assistant, onMode: onceMode('spot', w => setTimeout(() => w.hear('Moderator, what does a moderator do?', { dur: 0.01 }), 30)) });
  const done = w.run();
  await sleep(120);
  w.hear('moderator reads the question aloud', { dur: 1 });   // echo: ignored
  await sleep(30);
  assert.equal(w.game.state, 'assistant');
  w.hear('Stop.', { dur: 0.3 });
  await sleep(30);
  resolveAsk({});
  await done;
  assert.equal(w.game.history[0].result, 'dead');
});
