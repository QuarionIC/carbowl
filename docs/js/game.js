// The quiz itself: reads tossups and bonuses, reacts to buzzes and spoken answers, judges them,
// keeps score. Everything it touches (reader, listener, sounds, question feed, screen) is passed
// in, so the same logic runs in the browser and under test with stand-ins.

import { prepareTossup, prepareBonus, mainAnswer, chunkForSpeech } from './speechtext.js';
import { classifyBuzz, classifyCommand, isCommandLead, isEcho, isFillerOnly, ALL_COMMANDS } from './intent.js';
import { isGiveUp } from './judge.js';

export class StopSignal extends Error { constructor () { super('stopped'); this.name = 'StopSignal'; } }
class SkipSignal extends Error { constructor () { super('skipped'); this.name = 'SkipSignal'; } }

export const PHRASES = {
  start: 'Starting. Say buzz to answer a tossup.',
  tossup: 'Next tossup.',
  bonus: 'Bonus question.',
  correct: "That's correct.",
  power: "That's correct, for power.",
  incorrect: "That's incorrect.",
  time: "Time's up.",
  prompt: 'Prompt. Be more specific.',
  noAnswer: "I didn't hear an answer.",
  skipped: 'Skipping this one.',
  paused: 'Quiz paused.',
  resumed: 'Resuming.',
  markedRight: 'Okay, marked correct.',
  markedWrong: 'Okay, marked incorrect.',
  waiting: 'Waiting for a connection.',
  noQuestions: 'No questions match your settings.',
  trouble: 'Something went wrong. Moving on.',
  points0: 'No points on that bonus.',
  points10: 'Ten points on that bonus.',
  points20: 'Twenty points on that bonus.',
  points30: 'Thirty points on that bonus.',
  restart: 'Starting the question again.'
};

export const DEFAULT_RULES = {
  mode: 'both',                 // both | tossups | bonuses
  buzzSensitivity: 'normal',    // strict | normal | off
  bonusDirectAnswer: true,      // answer bonus parts by simply speaking
  tossupDeadSec: 5,             // time to buzz after a tossup has been read
  bonusAnswerSec: 5,            // time to start answering after a bonus part has been read
  answerStartSec: 7,            // time to start speaking after a buzz
  answerMaxSec: 14,             // hard cap on one answer
  betweenSec: 2.5,              // pause after each question for corrections ("I was right")
  sentenceGapSec: 0.12,         // pause between sentences
  sayHeard: true,               // "I heard ..." after a wrong answer
  announceType: true,           // say "Next tossup" / "Bonus question"
  readRestAfterBuzz: false,     // finish reading the question after a wrong buzz
  sayAnswerWhenCorrect: true,   // confirm the full answer after a correct response
  commandHoldSec: 0.9,          // how long to wait for the second half of a two-word command
  selfJudge: false,             // no microphone: the answer is revealed and the player taps right or wrong
  selfJudgeSec: 12,
  bonusPointsSpoken: true
};

class Mailbox {
  constructor () { this.q = []; this.waiter = null; }
  post (e) { if (this.waiter) { const w = this.waiter; this.waiter = null; w(e); } else this.q.push(e); }
  next (timeoutMs) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise(resolve => {
      let timer = null;
      this.waiter = e => { if (timer) clearTimeout(timer); resolve(e); };
      if (timeoutMs !== undefined && timeoutMs !== null && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => { if (this.waiter) { this.waiter = null; resolve({ type: 'timeout' }); } }, Math.max(0, timeoutMs));
      }
    });
  }
  /** Puts events back at the head of the queue, in the order given. */
  unshift (...events) { this.q.unshift(...events); }
  /** Drops queued speech events; keeps taps and control events. */
  dropSpeech () { this.q = this.q.filter(e => e.type !== 'utterance' && e.type !== 'speechstart' && e.type !== 'speechend'); }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Game {
  /**
   * @param {object} d
   * @param {{ next: Function, prefetch: Function }} d.feed
   * @param {object} d.narrator   say(), read(), synth(), prepare(), newGroup(), stop()
   * @param {EventTarget & { setMode: Function }} d.listener
   * @param {{ tone: Function, time: number }} d.audio
   * @param {(answerline: string, transcripts: string[], previous: string[]) => object} d.judge
   * @param {() => object} d.rules current rule settings (see DEFAULT_RULES)
   * @param {object} [d.ui] optional callbacks: onState, onQuestion, onProgress, onHeard, onResult, onScore, onAnswer
   */
  constructor ({ feed, narrator, listener, audio, judge, rules, ui, log }) {
    this.feed = feed; this.narrator = narrator; this.listener = listener; this.audio = audio; this.judge = judge;
    this.rules = () => ({ ...DEFAULT_RULES, ...(rules ? rules() : {}) });
    this.ui = ui || {}; this.log = log || (() => {});
    this.box = new Mailbox();
    this.running = false; this.stopping = false; this.paused = false;
    this.history = [];
    this.count = { tossup: 0, bonus: 0 };
    this.state = 'idle';
    this.current = null;      // record of the question in progress
    this.reading = null;
    this.reveals = new Map(); // question id -> Promise<string> (verified reveal sentence)
    this._on = {
      utterance: e => this.box.post({ type: 'utterance', ...e.detail }),
      speechstart: e => this.box.post({ type: 'speechstart', ...e.detail }),
      speechend: e => this.box.post({ type: 'speechend', ...e.detail })
    };
  }

  // ---- outside world -> game -------------------------------------------------------------

  /** A tap on the screen (or any other non-voice control). */
  act (action) {
    this.log('tap: ' + action);
    if (action === 'stop') { this.stop(); return; }
    this.box.post({ type: 'tap', action });
  }

  /** Asks for a pause once; repeated requests while one is pending or active do nothing. */
  requestPause () {
    if (!this.running || this.paused || this._pauseQueued) return;
    this._pauseQueued = true;
    this.box.post({ type: 'tap', action: 'pause' });
  }

  stop () {
    if (!this.running) return;
    this.stopping = true;
    this.box.post({ type: 'stop' });
    try { this.narrator.stop(); } catch (e) { /* nothing playing */ }
  }

  // ---- helpers ---------------------------------------------------------------------------

  _set (state, extra = {}) { this.state = state; if (this.ui.onState) this.ui.onState(state, extra); }
  _emit (name, ...args) { if (this.ui[name]) { try { this.ui[name](...args); } catch (e) { this.log(`ui.${name} failed: ${e.message}`); } } }

  _listen (mode, opts) { this._mode = mode; try { this.listener.setMode(mode, opts); } catch (e) { this.log('listener mode failed: ' + e.message); } this.box.dropSpeech(); }

  async _say (text, opts) {
    if (this.stopping) throw new StopSignal();
    const how = await this.narrator.say(text, opts);
    if (this.stopping) throw new StopSignal();
    return how;
  }

  /** For the log: how long the speech lasted, how loud it was, and how long after it ended we learned of it. */
  _timing (e) {
    const lag = typeof e.end === 'number' && this.audio.time ? this.audio.time - e.end : null;
    return `[${e.dur ? e.dur.toFixed(2) + 's' : '?'}${e.level ? ', level ' + e.level.toFixed(3) : ''}${lag !== null ? ', known ' + lag.toFixed(2) + 's after it ended' : ''}${e.asrMs ? ', recognised in ' + e.asrMs + ' ms' : ''}]`;
  }

  _tone (name) { try { return this.audio.tone(name) || 0; } catch (e) { return 0; } }
  async _toneAndWait (name) { const sec = this._tone(name); if (sec) await new Promise(resolve => setTimeout(resolve, sec * 1000)); }

  /**
   * Waits for the next event that matters, handling the things that can happen at any time:
   * stop, pause/resume (deadlines are pushed back by the time spent paused), and skip.
   * @param {number|null} deadline absolute time (ms, performance clock) or null for none
   * @returns {Promise<object>} an event; { type: 'timeout' } when the deadline passes
   */
  async _next (deadline, { allowSkip = true, onPause, onResume } = {}) {
    for (;;) {
      if (this.stopping) throw new StopSignal();
      let e = await this.box.next(deadline == null ? undefined : deadline.at - now());
      if (e.type === 'stop' || this.stopping) throw new StopSignal();
      if (e.type === 'utterance' && !e.joined && this._mode === 'spot') e = await this._joinCommand(e);
      let command = null;
      if (e.type === 'tap') command = e.action;
      else if (e.type === 'utterance') {
        command = classifyCommand(e.text, ['pause', 'skip', 'faster', 'slower']);
        // Everything heard goes in the log, whatever the game then makes of it.
        this.log(`heard (${this.state}): "${String(e.text || '').trim()}" ${this._timing(e)}`);
      }
      if (command === 'faster' || command === 'slower') {
        // Reading speed belongs to the app's settings; the game only passes the request on and keeps going.
        this.log('heard a speed request: ' + command);
        this._emit('onCommand', command);
        continue;
      }
      if (command === 'pause') {
        const t0 = now();
        if (onPause) onPause();
        await this._pause();
        if (deadline) deadline.at += now() - t0;
        if (onResume) onResume();
        continue;
      }
      if (command === 'skip' && allowSkip) throw new SkipSignal();
      return e;
    }
  }

  /**
   * While listening for single words, a short pause inside a two-word command ("read ... faster",
   * "pause ... quiz") arrives as two utterances. When an utterance is just the first word of such a
   * command, wait a moment for the second half and judge the two together; otherwise the first word
   * alone would be mistaken for a buzz.
   * @returns {Promise<object>} the utterance to handle now (possibly the two joined), marked joined
   */
  async _joinCommand (first) {
    if (!isCommandLead(first.text)) return first;
    const until = now() + this.rules().commandHoldSec * 1000;
    const aside = [];
    let second = null;
    for (;;) {
      const x = await this.box.next(Math.max(0, until - now()));
      if (x.type === 'timeout') break;
      if (x.type === 'stop') { this.box.unshift(x); break; }
      if (x.type === 'utterance') { second = x; break; }
      aside.push(x); // speech starting, a reading finishing, a tap: handled afterwards, in order
    }
    if (second) {
      const text = `${first.text} ${second.text}`;
      if (classifyCommand(text, ALL_COMMANDS)) {
        this.box.unshift(...aside);
        return { ...first, text, end: second.end, dur: (second.end || 0) - (first.start || 0), joined: true };
      }
      this.box.unshift(...aside, { ...second, joined: true });
    } else this.box.unshift(...aside);
    return { ...first, joined: true };
  }

  async _pause () {
    this.paused = true; this._pauseQueued = false;
    const before = this.state; const modeBefore = this._mode || 'off';
    this._set('paused');
    this.log('paused');
    if (this.reading) this.reading.pause();
    else this.narrator.stop();
    this._listen('spot');
    await this.narrator.say(PHRASES.paused);
    for (;;) {
      const e = await this.box.next();
      if (e.type === 'stop' || this.stopping) { this.paused = false; throw new StopSignal(); }
      if (e.type === 'tap' && e.action === 'resume') break;
      if (e.type === 'utterance' && classifyCommand(e.text, ['resume'])) break;
    }
    this.paused = false;
    this.log('resumed');
    await this.narrator.say(PHRASES.resumed);
    this._set(before);
    this._listen(modeBefore);
    if (this.reading) this.reading.resume();
  }

  /** The sentence that reveals an answer, checked once by ear: synthesise it, transcribe it, and
   *  keep the first phrasing the judge recognises as the right answer. */
  _prepareReveal (id, answerHtml, answerSanitized, verify) {
    if (this.reveals.has(id)) return this.reveals.get(id);
    const answer = mainAnswer(answerSanitized);
    const variants = [`The answer is ${answer}.`, `The correct answer is: ${answer}.`, `The answer was ${answer}.`];
    const p = (async () => {
      if (!verify) { this.narrator.synth(variants[0], { priority: 4, kind: 'phrase' }).catch(() => {}); return variants[0]; }
      for (const text of variants) {
        try {
          const audio = await this.narrator.synth(text, { priority: 4, kind: 'phrase' });
          const heard = await verify(audio);
          if (heard === null) return text; // verification unavailable
          const r = this.judge(answerHtml, [heard.replace(/^.*?\banswer\b\s*(?:is|was)?:?\s*/i, '')], []);
          if (r.directive === 'accept' || r.directive === 'prompt') return text;
          this.log(`reveal check: "${text}" came back as "${heard}"; trying another phrasing`);
        } catch (e) { this.log('reveal check failed: ' + e.message); return variants[0]; }
      }
      return variants[0];
    })();
    this.reveals.set(id, p);
    if (this.reveals.size > 12) this.reveals.delete(this.reveals.keys().next().value);
    return p;
  }

  async _reveal (id, answerHtml, answerSanitized) {
    const pending = this._prepareReveal(id, answerHtml, answerSanitized, this.verify);
    // Never hold up the game for the check: fall back to the plain sentence after a moment.
    const text = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(`The answer is ${mainAnswer(answerSanitized)}.`), 1800))]);
    await this._say(text);
  }

  // ---- answers ---------------------------------------------------------------------------

  /**
   * Listens for a spoken answer.
   * @param {{ prefix?: string, since?: number, startSec?: number, maxSec?: number, alreadySpeaking?: boolean }} o
   *   prefix: words already heard in the same breath as the buzz
   * @returns {Promise<{ text: string, timedOut: boolean }>}
   */
  async _collectAnswer ({ prefix = '', since, startSec, maxSec, alreadySpeaking = false } = {}) {
    const r = this.rules();
    this._set('answering');
    this._listen('answer', { since });
    const t0 = now();
    const hard = { at: t0 + (maxSec || r.answerMaxSec) * 1000 };
    // With words already in hand, wait only briefly for more; otherwise give the full thinking time.
    let soft = { at: t0 + (prefix ? 1200 : (startSec || r.answerStartSec) * 1000) };
    const parts = prefix ? [prefix] : [];
    let speaking = alreadySpeaking;
    for (;;) {
      const limit = speaking ? hard : (soft.at < hard.at ? soft : hard);
      const e = await this._next(limit, { allowSkip: false });
      if (e.type === 'timeout') break;
      if (e.type === 'speechstart') { speaking = true; this._emit('onHeard', '…'); continue; }
      if (e.type === 'speechend') { if (e.dropped) { speaking = false; soft = { at: Math.min(hard.at, Math.max(soft.at, now() + 1500)) }; } continue; }
      if (e.type === 'tap' && (e.action === 'buzz' || e.action === 'next')) break; // "that's my answer"
      if (e.type !== 'utterance') continue;
      speaking = false;
      const text = String(e.text || '').trim();
      if (!text || (isFillerOnly(text) && !parts.length)) {
        // "um" - keep listening, with a little extra time.
        soft = { at: Math.min(hard.at, Math.max(soft.at, now() + 3000)) };
        continue;
      }
      this._emit('onHeard', text);
      parts.push(text);
      break;
    }
    this._listen('off');
    return { text: parts.join(' ').trim(), timedOut: parts.length === 0 };
  }

  /** Without a microphone: say the answer, then wait for a tap on "I was right" or "I was wrong". */
  async _selfJudge (revealId, answerHtml, answerSanitized) {
    this._set('judging');
    await this._reveal(revealId, answerHtml, answerSanitized);
    const deadline = { at: now() + this.rules().selfJudgeSec * 1000 };
    for (;;) {
      const e = await this._next(deadline, { allowSkip: false });
      if (e.type === 'timeout') return { directive: 'reject', self: true, heard: '', empty: true };
      if (e.type === 'tap' && e.action === 'right') return { directive: 'accept', self: true, heard: '', method: 'self', score: 1 };
      if (e.type === 'tap' && (e.action === 'wrong' || e.action === 'next' || e.action === 'buzz')) return { directive: 'reject', self: true, heard: '', method: 'self', score: 0 };
    }
  }

  /** Judges an answer, asking again when the answerline says to prompt. */
  async _judgeWithPrompts (answerHtml, first) {
    let answer = first; const previous = [];
    for (let round = 0; ; round++) {
      if (!answer.text) return { directive: 'reject', heard: '', empty: true, method: 'empty', score: 0 };
      let r;
      try { r = this.judge(answerHtml, [answer.text], previous); } catch (e) { this.log('judge failed: ' + e.message); r = { directive: 'reject', heard: answer.text, method: 'error', score: 0 }; }
      this.log(`judge: ${r.directive} via ${r.method} (${(r.score || 0).toFixed(2)}) heard "${answer.text}"` + (r.matched ? ` ~ "${r.matched}"` : ''));
      if (r.directive !== 'prompt' || round >= 2) return r.directive === 'prompt' ? { ...r, directive: 'reject' } : r;
      previous.push(answer.text);
      this._tone('prompt');
      await this._say(r.directedPrompt ? `Prompt. ${r.directedPrompt}` : PHRASES.prompt);
      this._tone('listen');
      answer = await this._collectAnswer({});
      if (answer.text) answer.text = answer.text.trim();
    }
  }

  // ---- tossup ----------------------------------------------------------------------------

  async _tossup (q) {
    const r = this.rules();
    const prep = prepareTossup(q);
    let group = this.narrator.newGroup('tu');
    const rec = { id: q._id, type: 'tossup', q, text: prep.text, powerOffset: prep.powerOffset, answer: q.answer || q.answer_sanitized, answerText: mainAnswer(q.answer_sanitized), result: null, points: 0, heard: '', buzzOffset: null, at: Date.now() };
    this.current = rec;
    this._emit('onQuestion', rec);
    this.narrator.prepare(prep.chunks, { group, count: 2 });
    this._prepareReveal(q._id, rec.answer, q.answer_sanitized, this.verify);
    if (r.announceType) await this._say(PHRASES.tossup);

    let outcome = null;       // { kind: 'buzz', at, prefix, since } | { kind: 'dead' }
    let restarts = 0;
    while (!outcome) {
      this._set('reading', { type: 'tossup' });
      this._listen(r.buzzSensitivity === 'off' ? 'off' : 'spot');
      const reading = this.narrator.read(prep.chunks, { group, gap: r.sentenceGapSec, onProgress: off => this._emit('onProgress', off, prep.text.length) });
      this.reading = reading;
      reading.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading }); });
      let deadline = null; let restart = false;
      while (!outcome && !restart) {
        const e = await this._next(deadline);
        if (e.type === 'readingDone') {
          if (e.reading !== reading) continue;
          this._emit('onProgress', prep.text.length, prep.text.length);
          this._set('waiting', { seconds: r.tossupDeadSec });
          deadline = { at: now() + r.tossupDeadSec * 1000 };
        } else if (e.type === 'timeout') {
          outcome = { kind: 'dead' };
        } else if (e.type === 'tap') {
          if (e.action === 'buzz') outcome = { kind: 'buzz', at: this.audio.time, prefix: '', since: this.audio.time };
          else if (e.action === 'repeat') restart = true;
        } else if (e.type === 'utterance') {
          const text = String(e.text || '').trim();
          const spoken = reading.textBetween(e.start - 0.6, e.end + 0.3, prep.text);
          if (!text) continue;
          if (classifyCommand(text, ['repeat'])) { restart = true; continue; }
          if (reading.state === 'reading' && isEcho(text, spoken)) { this.log('ignored: that was the reader\'s own voice'); continue; }
          const b = classifyBuzz({ text, dur: e.dur }, r.buzzSensitivity);
          if (!b.buzz) { this._emit('onHeard', text, 'ignored'); continue; }
          outcome = { kind: 'buzz', at: e.start, prefix: b.rest, since: e.end, why: b.why };
        }
      }
      if (restart) {
        reading.stop(); this.reading = null;
        group = this.narrator.newGroup('tu'); // a stopped reading cancels its group
        if (++restarts <= 3) await this._say(PHRASES.restart);
      }
    }

    const reading = this.reading;
    if (outcome.kind === 'dead') {
      this.reading = null;
      rec.result = 'dead'; rec.points = 0;
      this._listen('off');
      this._tone('time');
      await this._say(PHRASES.time);
      await this._finishQuestion(rec, true);
      return rec;
    }

    // Buzz.
    const finished = reading.state === 'finished';
    rec.buzzOffset = finished ? prep.text.length : reading.positionAt(outcome.at - (this.audio.latency || 0));
    reading.stop(); this.reading = null;
    this._emit('onProgress', rec.buzzOffset, prep.text.length, true);
    this.log(`buzz at character ${rec.buzzOffset}/${prep.text.length}` + (outcome.why ? ` (${outcome.why})` : ''));
    this._tone('buzz');
    let answer = { text: '' }; let verdict;
    if (r.selfJudge) { this._emit('onAnswer', rec); verdict = await this._selfJudge(q._id, rec.answer, q.answer_sanitized); } else {
      answer = await this._collectAnswer({ prefix: outcome.prefix, since: outcome.since });
      verdict = await this._judgeWithPrompts(rec.answer, answer);
    }
    rec.heard = verdict.heard || answer.text; rec.method = verdict.method;
    this._set('result');
    const early = !finished && rec.buzzOffset < prep.text.length - 1;
    if (verdict.directive === 'accept') {
      const power = prep.powerOffset >= 0 && rec.buzzOffset < prep.powerOffset;
      rec.result = power ? 'power' : 'ten'; rec.points = power ? 15 : 10;
      this._tone(power ? 'power' : 'correct');
      this._emit('onResult', rec);
      await this._say(power ? PHRASES.power : PHRASES.correct);
      if (!verdict.self) await this._finishQuestion(rec, false);
    } else {
      rec.result = early ? 'neg' : 'wrong'; rec.points = early ? -5 : 0;
      this._tone('wrong');
      this._emit('onResult', rec);
      if (verdict.self) { /* the answer has been said already */ } else if (verdict.empty) await this._say(PHRASES.noAnswer);
      else {
        await this._say(PHRASES.incorrect);
        if (r.sayHeard && rec.heard && !verdict.gaveUp) await this._say(`I heard: ${rec.heard.replace(/[.?!]+$/, '')}.`);
      }
      if (r.readRestAfterBuzz && early) {
        const rest = this.narrator.read(prep.chunks, { group: this.narrator.newGroup('rest'), gap: r.sentenceGapSec, from: rec.buzzOffset, onProgress: off => this._emit('onProgress', off, prep.text.length) });
        this.reading = rest; this._set('reading', { type: 'tossup', rest: true });
        rest.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading: rest }); });
        try { for (;;) { const e = await this._next(null); if (e.type === 'readingDone' && e.reading === rest) break; if (e.type === 'tap' && e.action === 'next') break; } } finally { rest.stop(); this.reading = null; }
      }
      if (!verdict.self) await this._finishQuestion(rec, true);
    }
    return rec;
  }

  /** Reveals the answer (always after a miss; after a correct answer only its name is confirmed). */
  async _finishQuestion (rec, missed) {
    this._set('result');
    this._emit('onAnswer', rec);
    if (missed || this.rules().sayAnswerWhenCorrect) await this._reveal(rec.id, rec.answer, rec.q.answer_sanitized);
  }

  // ---- bonus -----------------------------------------------------------------------------

  async _bonus (q) {
    const r = this.rules();
    const prep = prepareBonus(q);
    const leadGroup = this.narrator.newGroup('bn');
    const groups = prep.parts.map(() => this.narrator.newGroup('bn')); // one per reading: stopping a reading cancels its group
    const rec = { id: q._id, type: 'bonus', q, leadin: prep.leadin.text, parts: prep.parts.map((p, i) => ({ text: p.text, answer: (q.answers && q.answers[i]) || q.answers_sanitized[i], answerText: mainAnswer(q.answers_sanitized[i]), result: null, points: 0, heard: '' })), points: 0, at: Date.now() };
    this.current = rec;
    this._emit('onQuestion', rec);
    if (prep.leadin.chunks.length) this.narrator.prepare(prep.leadin.chunks, { group: leadGroup, count: 2 }); else this.narrator.prepare(prep.parts[0].chunks, { group: groups[0], count: 2 });
    q.answers_sanitized.forEach((a, i) => this._prepareReveal(`${q._id}:${i}`, rec.parts[i].answer, a, i === 0 ? this.verify : null));
    if (r.announceType) await this._say(PHRASES.bonus);

    // Lead-in: nothing to answer yet.
    if (prep.leadin.chunks.length) {
      this._set('reading', { type: 'bonus', part: -1 });
      this._listen('spot');
      const lead = this.narrator.read(prep.leadin.chunks, { group: leadGroup, gap: r.sentenceGapSec, onProgress: off => this._emit('onProgress', off, prep.leadin.text.length, false, -1) });
      this.reading = lead;
      lead.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading: lead }); });
      this.narrator.prepare(prep.parts[0].chunks, { group: groups[0], count: 2 });
      try { for (;;) { const e = await this._next(null); if (e.type === 'readingDone' && e.reading === lead) break; } } finally { lead.stop(); this.reading = null; }
    }

    for (let i = 0; i < prep.parts.length; i++) {
      const part = prep.parts[i]; const pr = rec.parts[i];
      if (i + 1 < prep.parts.length) this.narrator.prepare(prep.parts[i + 1].chunks, { group: groups[i + 1], count: 1, priority: 7 });
      this._set('reading', { type: 'bonus', part: i });
      this._emit('onPart', rec, i);
      const direct = r.bonusDirectAnswer && r.buzzSensitivity !== 'off';
      this._listen(r.buzzSensitivity === 'off' ? 'off' : (direct ? 'answer' : 'spot'));
      const reading = this.narrator.read(part.chunks, { group: groups[i], gap: r.sentenceGapSec, onProgress: off => this._emit('onProgress', off, part.text.length, false, i) });
      this.reading = reading;
      reading.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading }); });
      let deadline = null; let answer = null; let interrupted = false; let speaking = false;
      const hardCap = () => ({ at: now() + r.answerMaxSec * 1000 });
      const resumeReading = () => { if (interrupted) { interrupted = false; reading.resume(); this._set('reading', { type: 'bonus', part: i }); } };
      try {
        while (answer === null) {
          const e = await this._next(deadline, { onResume: () => { interrupted = false; } });
          if (e.type === 'readingDone') {
            if (e.reading !== reading) continue;
            this._emit('onProgress', part.text.length, part.text.length, false, i);
            this._set('waiting', { seconds: r.bonusAnswerSec });
            if (!speaking) deadline = { at: now() + r.bonusAnswerSec * 1000 };
          } else if (e.type === 'timeout') {
            answer = { text: '', timedOut: true };
          } else if (e.type === 'tap') {
            if (e.action === 'buzz' && r.selfJudge) { reading.stop(); answer = { text: '', self: true }; } else if (e.action === 'buzz') { reading.stop(); this._tone('buzz'); answer = await this._collectAnswer({ since: this.audio.time }); } else if (e.action === 'next') answer = { text: '', timedOut: true };
          } else if (e.type === 'speechstart') {
            if (!direct) continue;
            speaking = true;
            if (reading.state === 'reading') { reading.pause(); interrupted = true; this._set('answering'); }
            deadline = hardCap();
          } else if (e.type === 'speechend') {
            if (e.dropped) { speaking = false; resumeReading(); if (reading.state === 'finished') deadline = { at: now() + r.bonusAnswerSec * 1000 }; else deadline = null; }
          } else if (e.type === 'utterance') {
            speaking = false;
            const text = String(e.text || '').trim();
            const spoken = reading.textBetween(e.start - 0.6, e.end + 0.3, part.text);
            const echo = text && !interrupted && reading.state === 'reading' && isEcho(text, spoken);
            const b = text ? classifyBuzz({ text, dur: e.dur }, 'strict') : { buzz: false, rest: '' };
            if (!text || echo || isFillerOnly(text) || (!direct && !b.buzz)) {
              if (echo) this.log('ignored: that was the reader\'s own voice');
              resumeReading();
              deadline = reading.state === 'finished' ? { at: now() + Math.max(2, r.bonusAnswerSec) * 1000 } : null;
              continue;
            }
            reading.stop();
            if (b.buzz && !b.rest) { this._tone('buzz'); answer = await this._collectAnswer({ since: e.end }); } else { const said = b.buzz ? b.rest : text; this._emit('onHeard', said); answer = { text: said, timedOut: false }; }
          }
        }
      } finally { reading.stop(); this.reading = null; }
      this._listen('off');
      let verdict;
      if (r.selfJudge && (answer.self || answer.timedOut)) { this._emit('onAnswer', rec, i); verdict = await this._selfJudge(`${q._id}:${i}`, pr.answer, q.answers_sanitized[i]); } else verdict = answer.text ? await this._judgeWithPrompts(pr.answer, answer) : { directive: 'reject', empty: true, heard: '' };
      pr.heard = verdict.heard || answer.text || '';
      this._set('result');
      if (verdict.directive === 'accept') {
        pr.result = 'correct'; pr.points = 10; rec.points += 10;
        this._tone('correct'); this._emit('onResult', rec, i);
        await this._say(PHRASES.correct);
        this._emit('onAnswer', rec, i);
        if (r.sayAnswerWhenCorrect && !verdict.self) await this._reveal(`${q._id}:${i}`, pr.answer, q.answers_sanitized[i]);
      } else {
        pr.result = verdict.empty ? 'none' : 'wrong';
        this._tone(verdict.empty ? 'time' : 'wrong'); this._emit('onResult', rec, i);
        if (verdict.self) { /* the answer has been said already */ } else if (verdict.empty) await this._say(PHRASES.time);
        else { await this._say(PHRASES.incorrect); if (r.sayHeard && pr.heard && !verdict.gaveUp && !isGiveUp(pr.heard)) await this._say(`I heard: ${pr.heard.replace(/[.?!]+$/, '')}.`); }
        this._emit('onAnswer', rec, i);
        if (!verdict.self) await this._reveal(`${q._id}:${i}`, pr.answer, q.answers_sanitized[i]);
      }
      if (i + 1 < prep.parts.length) this._prepareReveal(`${q._id}:${i + 1}`, rec.parts[i + 1].answer, q.answers_sanitized[i + 1], null);
    }
    this._set('result');
    if (r.bonusPointsSpoken) await this._say(PHRASES['points' + rec.points] || `${rec.points} points on that bonus.`);
    return rec;
  }

  // ---- between questions -----------------------------------------------------------------

  /** A short window after each question for spoken corrections; also where the next question is fetched. */
  async _between (rec) {
    const r = this.rules();
    this._set('between');
    this._listen(r.buzzSensitivity === 'off' ? 'off' : 'spot');
    const deadline = { at: now() + r.betweenSec * 1000 };
    for (;;) {
      let e;
      try { e = await this._next(deadline); } catch (err) { if (err instanceof SkipSignal) break; throw err; }
      if (e.type === 'timeout') break;
      let cmd = null;
      if (e.type === 'tap') cmd = e.action;
      else if (e.type === 'utterance') { cmd = classifyCommand(e.text, ['right', 'wrong', 'repeat', 'skip']); if (cmd) this.log('command: ' + cmd); }
      if (cmd === 'next' || cmd === 'skip') break;
      if (cmd === 'right' || cmd === 'wrong') {
        if (this.override(rec, cmd === 'right')) await this._say(cmd === 'right' ? PHRASES.markedRight : PHRASES.markedWrong);
        deadline.at = now() + 1200;
      } else if (cmd === 'repeat' && rec) {
        this._listen('off');
        await this._repeat(rec);
        this._listen('spot');
        deadline.at = now() + r.betweenSec * 1000;
      }
    }
    this._listen('off');
  }

  async _repeat (rec) {
    this._set('reading', { type: rec.type, repeat: true });
    const texts = rec.type === 'tossup' ? [rec.text, `The answer is ${rec.answerText}.`] : [rec.leadin, ...rec.parts.flatMap(p => [p.text, `The answer is ${p.answerText}.`])];
    for (const t of texts) {
      if (!t) continue;
      const reading = this.narrator.read(chunkForSpeech(t), { group: this.narrator.newGroup('rp'), gap: this.rules().sentenceGapSec });
      this.reading = reading;
      reading.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading }); });
      try { for (;;) { const e = await this._next(null, { allowSkip: true }); if (e.type === 'readingDone' && e.reading === reading) break; if (e.type === 'tap' && e.action === 'next') { reading.stop(); return; } } } catch (err) { reading.stop(); this.reading = null; if (err instanceof SkipSignal) return; throw err; } finally { this.reading = null; }
    }
  }

  /**
   * Flips the verdict on the last question (or one bonus part): the listener can always overrule the judge.
   * @returns {boolean} whether anything changed
   */
  override (rec, right, partIndex) {
    if (!rec) return false;
    if (rec.type === 'tossup') {
      const was = rec.result;
      if (right) {
        if (was === 'power' || was === 'ten') return false;
        const power = rec.powerOffset >= 0 && rec.buzzOffset !== null && rec.buzzOffset < rec.powerOffset;
        rec.result = power ? 'power' : 'ten'; rec.points = power ? 15 : 10;
      } else {
        if (was !== 'power' && was !== 'ten') return false;
        const early = rec.buzzOffset !== null && rec.buzzOffset < rec.text.length - 1;
        rec.result = early ? 'neg' : 'wrong'; rec.points = early ? -5 : 0;
      }
      rec.overridden = true;
    } else {
      // Without an index: the most recent part that would change.
      let i = partIndex;
      if (i === undefined) { for (let k = rec.parts.length - 1; k >= 0; k--) { const p = rec.parts[k]; if (p.result !== null && (p.result === 'correct') !== right) { i = k; break; } } }
      const p = rec.parts[i];
      if (!p || p.result === null || (p.result === 'correct') === right) return false;
      p.result = right ? 'correct' : 'wrong'; p.points = right ? 10 : 0; p.overridden = true;
      rec.points = rec.parts.reduce((s, x) => s + x.points, 0);
      rec.overridden = true;
    }
    this.log(`override: marked ${right ? 'correct' : 'incorrect'}`);
    this._emit('onResult', rec, partIndex);
    this._emit('onScore', this.score());
    return true;
  }

  score () {
    const s = { tossups: 0, powers: 0, tens: 0, negs: 0, tossupPoints: 0, bonuses: 0, bonusPoints: 0, bonusParts: 0, bonusCorrect: 0 };
    for (const h of this.history) {
      if (h.result === 'skipped') continue;
      if (h.type === 'tossup') { s.tossups++; s.tossupPoints += h.points; if (h.result === 'power') s.powers++; else if (h.result === 'ten') s.tens++; else if (h.result === 'neg') s.negs++; } else { s.bonuses++; s.bonusPoints += h.points; s.bonusParts += h.parts.length; s.bonusCorrect += h.parts.filter(p => p.result === 'correct').length; }
    }
    s.points = s.tossupPoints + s.bonusPoints;
    s.ppb = s.bonuses ? s.bonusPoints / s.bonuses : 0;
    return s;
  }

  // ---- main loop -------------------------------------------------------------------------

  _nextType () {
    const mode = this.rules().mode;
    if (mode === 'tossups') return 'tossup';
    if (mode === 'bonuses') return 'bonus';
    const last = this.history.length ? this.history[this.history.length - 1].type : 'bonus';
    return last === 'tossup' ? 'bonus' : 'tossup';
  }

  async _fetch (type) {
    let told = false;
    return this.feed.next(type, { onWaiting: () => { if (!told) { told = true; this.log('waiting for the network'); this._set('offline'); this.narrator.say(PHRASES.waiting).catch(() => {}); } } });
  }

  async run ({ limit = Infinity } = {}) {
    if (this.running) return;
    this.running = true; this.stopping = false;
    for (const [name, fn] of Object.entries(this._on)) this.listener.addEventListener(name, fn);
    let played = 0;
    try {
      this._set('starting');
      this._tone('ready');
      let next = this._fetch(this._nextType());
      next.catch(() => {});
      await this._say(PHRASES.start);
      while (!this.stopping && played < limit) {
        let q;
        try { q = await next; } catch (e) {
          if (e && e.name === 'NoQuestionsError') { this.log(e.message); this._set('empty'); await this._say(PHRASES.noQuestions); break; }
          throw e;
        }
        let rec = null;
        try {
          rec = q.type === 'bonus' ? await this._bonus(q) : await this._tossup(q);
        } catch (e) {
          if (e instanceof StopSignal) throw e;
          if (this.reading) { this.reading.stop(); this.reading = null; }
          this._listen('off');
          rec = this.current && this.current.id === q._id ? this.current : { id: q._id, type: q.type, q, points: 0, parts: [] };
          if (e instanceof SkipSignal) {
            this.log('skipped');
            if (rec.type === 'tossup') { rec.result = 'skipped'; rec.points = 0; } else { rec.result = 'skipped'; }
            await this._say(PHRASES.skipped);
            if (rec.type === 'tossup' && rec.answerText) { this._emit('onAnswer', rec); await this._say(`The answer was ${rec.answerText}.`); }
          } else {
            this.log('question failed: ' + (e && e.stack ? e.stack : e));
            rec.result = 'skipped'; rec.error = String(e && e.message || e);
            this._tone('wrong');
            await this.narrator.say(PHRASES.trouble).catch(() => {});
          }
        }
        this.history.push(rec); played++;
        this.count[rec.type]++;
        this._emit('onResult', rec);
        this._emit('onScore', this.score());
        if (this.stopping || played >= limit) break;
        // Fetch the next question while the correction window runs.
        next = this._fetch(this._nextType());
        next.catch(() => {});
        next.then(nq => { try { if (nq.type === 'tossup') { this.narrator.prepare(prepareTossup(nq).chunks, { count: 1, priority: 7 }); this._prepareReveal(nq._id, nq.answer || nq.answer_sanitized, nq.answer_sanitized, this.verify); } } catch (e) { /* preparation is best effort */ } }, () => {});
        await this._between(rec);
      }
    } catch (e) {
      if (!(e instanceof StopSignal)) { this.log('game loop failed: ' + (e && e.stack ? e.stack : e)); this._emit('onError', e); }
    } finally {
      for (const [name, fn] of Object.entries(this._on)) this.listener.removeEventListener(name, fn);
      try { if (this.reading) this.reading.stop(); this.narrator.stop(); this.listener.setMode('off'); } catch (e) { /* shutting down */ }
      this.reading = null; this.running = false; this.stopping = false; this.paused = false;
      this._set('idle');
      this._emit('onScore', this.score());
    }
  }
}
