// The quiz itself: reads tossups and bonuses, reacts to buzzes and spoken answers, judges them,
// keeps score, and answers spoken requests ("repeat the question", "what was the answer",
// "Moderator, who else wrote about that?"). Everything it touches (reader, listener, sounds,
// question feed, screen, assistant) is passed in, so the same logic runs in the browser and under
// test with stand-ins.

import { prepareTossup, prepareBonus, mainAnswer, chunkForSpeech } from './speechtext.js';
import { classifyBuzz, classifyCommand, isCommandLead, isEcho, isFillerOnly, isOnlyBuzz, splitWake, looksLikeQuestion, ALL_COMMANDS } from './intent.js';
import { isGiveUp } from './judge.js';
import { scoreOf } from './history.js';
import { DIFFICULTIES } from './qb.js';
import { setTimer, clearTimer, sleep } from './clock.js';

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
  restart: 'Starting the question again.',
  cancelled: 'Okay, carrying on.',
  noPrevious: 'There is no earlier answer yet.',
  notYet: 'That would be telling. Say skip if you want the answer.',
  needKey: 'I need an assistant key for that. Add one in Settings. Until then, say: what can I say.',
  assistantTrouble: 'I could not reach the assistant.',
  help: 'You can say: buzz. Repeat the question. What were the earlier clues. Go back. What was the answer. Spell that. What is my score. Never mind. Skip. Pause the quiz. Read faster, or read slower.',
  helpAsk: 'You can also say: Moderator, and then ask me anything.'
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
  sentenceGapSec: 0.3,          // pause between sentences: the easiest moment to be heard over the reader
  sayHeard: true,               // "I heard ..." after a wrong answer
  announceType: true,           // say "Next tossup" / "Bonus question"
  readRestAfterBuzz: false,     // finish reading the question after a wrong buzz
  sayAnswerWhenCorrect: true,   // confirm the full answer after a correct response
  commandHoldSec: 0.9,          // how long to wait for the second half of a two-word command
  holdOnVoice: 'auto',          // auto | on | off: the reader stops as soon as a voice is heard, then carries on if it was nothing
  holdMaxSec: 2.5,              // ... and never stays stopped longer than this without words
  confirmSec: 2,                // after a sound that could not be made out, how long to wait for it to be said again
  assistant: true,              // spoken requests: built-in ones, and "Moderator, ..." for anything else
  followUpSec: 4.5,             // after the assistant answers, how long it waits for a follow-up question
  thinkingToneSec: 2.5,         // while the assistant's answer is awaited, a soft tone this often says it is being worked on
  askMoreSec: 0.6,              // after "Moderator, ..." heard while reading, how long to wait in case the sentence goes on after a pause
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
      this.waiter = e => { if (timer) clearTimer(timer); resolve(e); };
      if (timeoutMs !== undefined && timeoutMs !== null && Number.isFinite(timeoutMs)) {
        timer = setTimer(() => { if (this.waiter) { this.waiter = null; resolve({ type: 'timeout' }); } }, Math.max(0, timeoutMs));
      }
    });
  }
  /** Puts events back at the head of the queue, in the order given. */
  unshift (...events) { this.q.unshift(...events); }
  /** Drops queued speech events; keeps taps and control events. */
  dropSpeech () { this.q = this.q.filter(e => e.type !== 'utterance' && e.type !== 'speechstart' && e.type !== 'speechend'); }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const INFO_COMMANDS = ['answer', 'spell', 'score', 'where', 'help'];
const ANYTIME_COMMANDS = ['pause', 'skip', 'faster', 'slower', 'louder', 'quieter'];

/** "Kant" -> "K, A, N, T". Several words are spelled one after another. */
export function spellOut (text) {
  const words = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/ß/g, 'ss').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 8);
  return words.map(w => (words.length > 1 ? w + ': ' : '') + w.toUpperCase().split('').slice(0, 24).join(', ')).join('. ');
}

export class Game {
  /**
   * @param {object} d
   * @param {{ next: Function, prefetch: Function }} d.feed
   * @param {object} d.narrator   say(), read(), synth(), prepare(), newGroup(), stop(), optionally speakStream()
   * @param {EventTarget & { setMode: Function }} d.listener
   * @param {{ tone: Function, time: number }} d.audio
   * @param {(answerline: string, transcripts: string[], previous: string[]) => object} d.judge
   * @param {() => object} d.rules current rule settings (see DEFAULT_RULES)
   * @param {{ available: () => boolean, ask: Function }} [d.assistant] answers free questions (see assistant.js)
   * @param {object} [d.ui] optional callbacks: onState, onQuestion, onProgress, onHeard, onResult, onScore, onAnswer, onCommand, onAssistant, onSaved
   */
  constructor ({ feed, narrator, listener, audio, judge, rules, ui, log, assistant }) {
    this.feed = feed; this.narrator = narrator; this.listener = listener; this.audio = audio; this.judge = judge;
    this.rules = () => ({ ...DEFAULT_RULES, ...(rules ? rules() : {}) });
    this.ui = ui || {}; this.log = log || (() => {});
    this.assistant = assistant || null;
    this.box = new Mailbox();
    this.running = false; this.stopping = false; this.paused = false;
    this.history = [];
    this.count = { tossup: 0, bonus: 0 };
    this.state = 'idle';
    this.current = null;      // record of the question in progress
    this.reading = null;
    this.readingText = '';    // the text the current reading is taken from (to recognise our own voice)
    this.reveals = new Map(); // question id -> Promise<string> (verified reveal sentence)
    this.talk = [];           // the conversation with the assistant about the current question
    this._hold = null; this._holdTimer = null; this._holdOff = false; this._holds = { real: 0, false: 0 };
    this._unclear = { asked: 0, confirmed: 0 };
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

  /**
   * Asks for a pause once; repeated requests while one is pending or active do nothing.
   * quiet: nothing is said about it (used when sound itself has dropped out, e.g. during a phone call).
   */
  requestPause ({ quiet = false } = {}) {
    if (!this.running || this.paused || this._pauseQueued) return;
    this._pauseQueued = true; this._pauseQuiet = quiet;
    this.box.post({ type: 'tap', action: 'pause' });
  }

  /** Ends a pause; quiet = without saying "Resuming". */
  resume ({ quiet = false } = {}) { this.box.post({ type: 'tap', action: 'resume', quiet }); }

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
  async _toneAndWait (name) { const sec = this._tone(name); if (sec) await sleep(sec * 1000); }

  /** Starts reading and arranges for a "readingDone" event when it gets to the end. */
  _startReading (chunks, text, opts) {
    const reading = this.narrator.read(chunks, opts);
    this.reading = reading; this.readingText = text;
    reading.done.then(how => { if (how === 'finished') this.box.post({ type: 'readingDone', reading }); });
    return reading;
  }

  /** True when what was heard is the reader's own voice coming back through the microphone. */
  _ownVoice (e, text) {
    const r = this.reading;
    if (!r || !this.readingText || typeof r.textBetween !== 'function') return false;
    // While the reader was stopped for a voice, anything that started after the stop is not the reader.
    if (r.state !== 'reading' && !(this._hold && this._hold.reading === r)) return false;
    return isEcho(text, r.textBetween((e.start || 0) - 0.6, (e.end || 0) + 0.3, this.readingText));
  }

  // ---- stopping the reader for a voice ---------------------------------------------------

  _holdAllowed () {
    const m = this.rules().holdOnVoice;
    return m === 'on' || (m !== 'off' && !this._holdOff);
  }

  /** The reader stops talking the moment someone else starts; whether it was a buzz is decided afterwards. */
  _holdBegin (reading) {
    if (this._hold || !reading || reading.state !== 'reading' || !this._holdAllowed()) return false;
    reading.pause();
    const h = { reading, at: now(), speaking: true, extended: 0 };
    this._hold = h;
    this._armHold(h, this.rules().holdMaxSec * 1000);
    this._emit('onHeard', '…');
    return true;
  }

  _armHold (h, ms) {
    if (this._holdTimer) clearTimer(this._holdTimer);
    this._holdTimer = setTimer(() => { if (this._hold === h) this.box.post({ type: 'holdTimeout', hold: h }); }, ms);
  }

  /**
   * Ends a hold. real = the voice turned out to be for us (a buzz, a command, a question); when it
   * keeps turning out to be nothing, stopping for voices is switched off for the rest of the session.
   */
  _holdEnd (why, real, { resume = true } = {}) {
    const h = this._hold;
    if (!h) return false;
    this._hold = null;
    if (this._holdTimer) { clearTimer(this._holdTimer); this._holdTimer = null; }
    if (real) this._holds.real++; else {
      this._holds.false++;
      if (this.rules().holdOnVoice === 'auto' && !this._holdOff && this._holds.false >= 4 && this._holds.false > 2 * this._holds.real) {
        this._holdOff = true;
        this.log(`the reader no longer stops at the first sound: ${this._holds.false} false alarms against ${this._holds.real} real ones this session`);
        this._emit('onNotice', 'hold-off');
      }
    }
    if (resume && h.reading.state === 'paused') h.reading.resume();
    if (why) this.log((resume ? 'carried on reading: ' : 'reader stopped: ') + why);
    return true;
  }

  // ---- the event pump --------------------------------------------------------------------

  /**
   * Waits for the next event that matters, handling the things that can happen at any time:
   * stop, pause/resume (deadlines are pushed back by the time spent paused), skip, speed and volume
   * requests, and requests to the assistant.
   * Anything it dealt with itself comes back as { type: 'handled', what, action } so that the caller
   * can let the reader carry on (or act on what the assistant was asked to do).
   * @param {number|null} deadline absolute time (ms, performance clock) or null for none
   * @param {{ allowSkip?: boolean, onPause?: Function, onResume?: Function, plain?: boolean, free?: boolean }} [o]
   *   plain: an answer is being given: only "pause the quiz" is taken as a command
   *   free: a question may be put to the assistant without the wake word
   *   restartable: the caller acts on "repeat" / "go back" itself (a question is being read)
   * @returns {Promise<object>} an event; { type: 'timeout' } when the deadline passes
   */
  async _next (deadline, { allowSkip = true, onPause, onResume, plain = false, free = false, restartable = false } = {}) {
    for (;;) {
      if (this.stopping) throw new StopSignal();
      let e = await this.box.next(deadline == null ? undefined : deadline.at - now());
      if (e.type === 'stop' || this.stopping) throw new StopSignal();
      if (e.type === 'utterance' && !e.joined && this._mode === 'spot') e = await this._joinCommand(e);
      let command = null;
      if (e.type === 'tap') command = e.action;
      else if (e.type === 'utterance') {
        const text = String(e.text || '').trim();
        // Everything heard goes in the log, whatever the game then makes of it.
        this.log(`heard (${this.state}): "${text}" ${this._timing(e)}`);
        if (text && !this._ownVoice(e, text)) {
          command = classifyCommand(text, plain ? ['pause'] : ANYTIME_COMMANDS);
          if (!command && !plain && this.rules().assistant) {
            const ask = this._askFor(text, free);
            if (ask) {
              ask.end = e.end; // where these words ended: the rest of the sentence, if any, is listened for from there
              ask.whole = /\?["')\]]*\s*$/.test(text); // heard as a finished question: less reason to wait for more
              const t0 = now();
              if (onPause) onPause();
              let action = await this._assist(ask);
              if (deadline) deadline.at += now() - t0;
              if (onResume) onResume();
              if (action === 'skip' && allowSkip) throw new SkipSignal();
              // "Repeat" and "go back" mean something only where a question is being read; elsewhere the reader just carries on.
              if (!restartable && (action === 'repeat' || action === 'clues' || action === 'back')) { action = null; if (this.reading && this.reading.state === 'paused') this.reading.resume(); }
              if (action === 'pause') command = 'pause'; else return { type: 'handled', what: 'assistant', action };
            }
          }
        }
      }
      if (command === 'faster' || command === 'slower' || command === 'louder' || command === 'quieter') {
        // Speed and volume belong to the app's settings; the game only passes the request on and keeps going.
        this.log('heard a request: ' + command);
        this._emit('onCommand', command);
        if (e.type === 'utterance') return { type: 'handled', what: command };
        continue;
      }
      if (command === 'pause') {
        const t0 = now();
        if (onPause) onPause();
        await this._pause();
        if (deadline) deadline.at += now() - t0;
        if (onResume) onResume();
        if (e.type === 'utterance') return { type: 'handled', what: 'pause' };
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
    let quiet = !!this._pauseQuiet; this._pauseQuiet = false;
    const before = this.state; const modeBefore = this._mode || 'off';
    this._holdEnd('', true, { resume: false });
    this._set('paused', { quiet });
    this.log(quiet ? 'paused (sound or microphone trouble)' : 'paused');
    if (this.reading) this.reading.pause();
    else this.narrator.stop();
    this._listen('spot');
    if (!quiet) await this.narrator.say(PHRASES.paused);
    for (;;) {
      const e = await this.box.next();
      if (e.type === 'stop' || this.stopping) { this.paused = false; throw new StopSignal(); }
      if (e.type === 'tap' && e.action === 'resume') { quiet = !!e.quiet; break; }
      if (e.type === 'utterance' && classifyCommand(e.text, ['resume'])) { quiet = false; break; }
    }
    this.paused = false;
    this.log('resumed');
    if (!quiet) await this.narrator.say(PHRASES.resumed);
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
    const text = await Promise.race([pending, sleep(1800).then(() => `The answer is ${mainAnswer(answerSanitized)}.`)]);
    await this._say(text);
  }

  // ---- answers ---------------------------------------------------------------------------

  /**
   * Listens for a spoken answer (or, for the assistant, a spoken question).
   * @param {{ prefix?: string, since?: number, startSec?: number, maxSec?: number, moreSec?: number, alreadySpeaking?: boolean, state?: string }} o
   *   prefix: words already heard in the same breath as the buzz; moreSec: how long to wait for more of them
   *   since: listen from this moment on (audio clock), so that speech already under way is heard from its start
   * @returns {Promise<{ text: string, timedOut: boolean, cancelled?: boolean }>}
   */
  async _collectAnswer ({ prefix = '', since, startSec, maxSec, moreSec, alreadySpeaking = false, state = 'answering' } = {}) {
    const r = this.rules();
    const asking = state !== 'answering';
    this._set(state);
    this._listen('answer', { since });
    const t0 = now();
    const hard = { at: t0 + (maxSec || r.answerMaxSec) * 1000 };
    // With words already in hand, wait only briefly for more; otherwise give the full thinking time.
    let soft = { at: t0 + (prefix ? (moreSec || 1.2) * 1000 : (startSec || r.answerStartSec) * 1000) };
    const parts = prefix ? [prefix] : [];
    let speaking = alreadySpeaking; let cancelled = false;
    for (;;) {
      const limit = speaking ? hard : (soft.at < hard.at ? soft : hard);
      const e = await this._next(limit, { allowSkip: false, plain: true });
      if (e.type === 'timeout') break;
      if (e.type === 'speechstart') { speaking = true; this._emit('onHeard', '…'); continue; }
      if (e.type === 'speechend') { if (e.dropped) { speaking = false; soft = { at: Math.min(hard.at, Math.max(soft.at, now() + 1500)) }; } continue; }
      if (e.type === 'tap' && (e.action === 'buzz' || e.action === 'next')) break; // "that's my answer"
      if (e.type === 'tap' && e.action === 'cancel') { cancelled = true; break; }
      if (e.type !== 'utterance') continue;
      speaking = false;
      const text = String(e.text || '').trim();
      // "um" is not an answer, and neither is a second "buzz" said because the first seemed to go unheard:
      // keep listening, with a little extra time.
      if (!text || (isFillerOnly(text) && !parts.length) || (!asking && !parts.length && isOnlyBuzz(text))) {
        soft = { at: Math.min(hard.at, Math.max(soft.at, now() + 3000)) };
        continue;
      }
      if (!parts.length && classifyCommand(text, ['cancel'])) { cancelled = true; break; }
      this._emit('onHeard', text);
      parts.push(text);
      break;
    }
    this._listen('off');
    if (cancelled) return { text: '', timedOut: false, cancelled: true };
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

  // ---- the assistant ---------------------------------------------------------------------

  /**
   * Decides whether something that was said is a request to the assistant.
   * @returns {{ kind: 'local', name: string } | { kind: 'ask', text: string } | null}
   */
  _askFor (text, free) {
    const info = classifyCommand(text, INFO_COMMANDS);
    if (info) return { kind: 'local', name: info };
    const w = splitWake(text);
    if (w.wake) {
      const inner = classifyCommand(w.rest, INFO_COMMANDS);
      if (inner) return { kind: 'local', name: inner };
      const act = classifyCommand(w.rest, ['repeat', 'clues', 'back', 'skip', 'pause']);
      if (act) return { kind: 'act', name: act };
      return { kind: 'ask', text: w.rest };
    }
    // Right after a question, anything that reads as a question is taken as one (when there is someone to ask).
    if (free && this.assistant && this.assistant.available && this.assistant.available() && looksLikeQuestion(text) && !classifyCommand(text, ALL_COMMANDS)) return { kind: 'ask', text: String(text).trim() };
    return null;
  }

  /** The answer most recently revealed: { answerText, answer } or null. */
  _lastRevealed () {
    const pick = h => {
      if (!h) return null;
      if (h.type === 'tossup') return h.result ? { answerText: h.answerText || mainAnswer(String(h.answer || '').replace(/<[^>]*>/g, '')), answer: h.answer } : null;
      const done = (h.parts || []).filter(p => p.result !== null && p.result !== undefined);
      const p = done[done.length - 1];
      return p ? { answerText: p.answerText || mainAnswer(String(p.answer || '').replace(/<[^>]*>/g, '')), answer: p.answer } : null;
    };
    return pick(this.current) || pick(this.history[this.history.length - 1]) || null;
  }

  /** True while the current question (or bonus part) has not been answered yet. */
  _isLive () {
    const c = this.current;
    if (!c || this.state === 'between' || this.state === 'result') return false;
    if (c.type === 'tossup') return c.result === null || c.result === undefined;
    return (c.parts || []).some(p => p.result === null || p.result === undefined);
  }

  /** What the built-in requests are answered with. */
  _localReply (name) {
    if (name === 'help') return this.assistant && this.assistant.available && this.assistant.available() ? [PHRASES.help, PHRASES.helpAsk] : [PHRASES.help];
    if (name === 'score') {
      const s = this.score();
      if (!s.tossups && !s.bonuses) return ['No score yet.'];
      const bits = [`${s.points} points.`];
      if (s.tossups) bits.push(`${s.powers + s.tens} of ${s.tossups} tossups${s.powers ? `, ${s.powers} for power` : ''}${s.negs ? `, ${s.negs} ${s.negs === 1 ? 'neg' : 'negs'}` : ''}.`);
      if (s.bonuses) bits.push(`${s.ppb.toFixed(1)} points per bonus.`);
      return [bits.join(' ')];
    }
    if (name === 'where') {
      const c = this.current; const q = c && c.q;
      if (!q) return ['No question yet.'];
      const d = DIFFICULTIES.find(x => x.value === q.difficulty);
      const topic = q.alternate_subcategory || q.subcategory || q.category;
      return [`This is a ${c.type}${topic ? ' on ' + topic : ''}${q.set && q.set.name ? ', from ' + q.set.name : ''}${d ? ', ' + d.label + ' level' : ''}.`];
    }
    const last = this._lastRevealed();
    if (!last) return [this._isLive() ? PHRASES.notYet : PHRASES.noPrevious];
    if (name === 'spell') return [`${last.answerText}. Spelled: ${spellOut(last.answerText)}.`];
    return [`${this._isLive() ? 'The last answer was' : 'The answer was'} ${last.answerText}.`];
  }

  /** What the assistant is told about the quiz. The answer to a question still in play is left out, so it cannot leak. */
  _context () {
    const c = this.current; const live = this._isLive();
    const slim = h => h.type === 'tossup'
      ? { type: 'tossup', question: h.text, answer: String(h.answer || '').replace(/<[^>]*>/g, ''), heard: h.heard || '', result: h.result, points: h.points }
      : { type: 'bonus', leadin: h.leadin, parts: (h.parts || []).filter(p => p.result !== null && p.result !== undefined).map(p => ({ question: p.text, answer: String(p.answer || '').replace(/<[^>]*>/g, ''), heard: p.heard || '', result: p.result })), points: h.points };
    const out = { state: this.state, score: this.score(), asked: this.history.length };
    if (c) {
      const q = c.q || {};
      const read = this.reading && typeof this.reading.position === 'function' && this.readingText ? this.readingText.slice(0, this.reading.position()) : '';
      out.current = { type: c.type, category: q.category, subcategory: q.alternate_subcategory || q.subcategory, set: q.set && q.set.name, difficulty: (DIFFICULTIES.find(x => x.value === q.difficulty) || {}).label, live };
      if (c.type === 'tossup') {
        if (live) out.current.readSoFar = read || (c.buzzOffset !== null && c.buzzOffset !== undefined ? c.text.slice(0, c.buzzOffset) : '');
        else Object.assign(out.current, slim(c));
      } else {
        out.current.leadin = c.leadin;
        out.current.partsAnswered = slim(c).parts;
        const i = (c.parts || []).findIndex(p => p.result === null || p.result === undefined);
        if (i >= 0) out.current.partInPlay = { number: i + 1, readSoFar: read && this.readingText === c.parts[i].text ? read : '' };
      }
    }
    out.earlier = this.history.slice(-6).map(slim);
    return out;
  }

  /** Speaks sentences as they arrive; resolves 'ended', or 'stopped' when cut short. */
  _speaker () {
    const n = this.narrator;
    if (typeof n.speakStream === 'function') return n.speakStream({ group: n.newGroup ? n.newGroup('as') : '' });
    // Stand-in for readers without streaming: one sentence after another. Stopping lets the sentence
    // being spoken finish: stopping the reader outright would also end a question that is only paused.
    let chain = Promise.resolve('ended'); let stopped = false;
    return { push: t => { chain = chain.then(() => stopped ? 'stopped' : n.say(t)); }, end () {}, stop () { stopped = true; }, finish () { return chain.then(() => stopped ? 'stopped' : 'ended'); } };
  }

  /**
   * Says a reply while listening for "stop" (or a tap, or a new question).
   * @returns {Promise<{ how: 'ended'|'stopped', next?: string }>} next = a new question that cut the reply short
   */
  async _sayReply (produce) {
    const sp = this._speaker();
    this._listen('spot');
    let finished = false; let result = {};
    const spoken = [];
    // Whoever is producing the reply (a request to a model, say) is told when nobody is listening any more.
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const cut = () => { finished = true; if (ac) ac.abort(); sp.stop(); };
    const work = (async () => {
      try { result = (await produce(t => { if (t && !finished) { spoken.push(t); this._emit('onAssistant', 'assistant', t); sp.push(t); } }, ac ? ac.signal : undefined)) || {}; } catch (e) { result = { error: e }; }
      sp.end();
      const how = await (sp.finish ? sp.finish() : sp.done);
      this.box.post({ type: 'said', sp, how });
    })();
    let out = { how: 'ended' };
    for (;;) {
      const e = await this.box.next();
      if (e.type === 'stop' || this.stopping) { cut(); await work.catch(() => {}); throw new StopSignal(); }
      if (e.type === 'said' && e.sp === sp) { out = { how: e.how }; break; }
      if (e.type === 'tap' && e.action !== 'pause') { cut(); out = { how: 'stopped' }; await work.catch(() => {}); break; }
      if (e.type !== 'utterance') continue;
      const text = String(e.text || '').trim();
      if (!text || isEcho(text, spoken.join(' '))) continue;
      this.log(`heard (assistant speaking): "${text}"`);
      const w = splitWake(text);
      if (w.wake || classifyCommand(text, ['enough', 'resume', 'skip'])) {
        cut(); await work.catch(() => {});
        out = { how: 'stopped', next: w.wake ? w.rest : '', skip: !!classifyCommand(text, ['skip']) };
        break;
      }
    }
    this.box.q = this.box.q.filter(x => !(x.type === 'said' && x.sp === sp));
    return { ...out, ...result };
  }

  /**
   * Handles a request to the assistant: stops the reader, answers (from what the game knows, or by
   * asking the assistant's model), allows follow-up questions, then puts things back as they were.
   * The assistant may answer with an action: 'repeat' | 'clues' | 'back' | 'skip' | 'pause' (left to the caller),
   * 'mark_right' | 'mark_wrong' (the last verdict is overruled here), 'faster' | 'slower' | 'louder' | 'quieter'
   * (passed on to the app).
   * @returns {Promise<string|null>} something for the caller to do: 'repeat' | 'clues' | 'back' | 'skip' | 'pause' | null
   */
  async _assist (ask) {
    const r = this.rules();
    const before = this.state; const modeBefore = this._mode || 'off';
    const reading = this.reading;
    const wasHeld = !!(this._hold && this._hold.reading === reading);
    const pausedHere = reading && reading.state === 'reading';
    if (pausedHere) reading.pause();
    this._holdEnd('', true, { resume: false });
    if (ask.kind === 'act') { this._set(before); this._listen(modeBefore); if ((pausedHere || wasHeld) && reading.state === 'paused' && ask.name !== 'repeat' && ask.name !== 'clues' && ask.name !== 'back') reading.resume(); return ask.name; }
    this._set('assistant');
    let action = null;
    try {
      let kind = ask.kind; let text = ask.text || ''; let name = ask.name;
      // While a question is read, a pause of a third of a second ends an utterance (so that "buzz" is
      // caught quickly). After "Moderator," or in the middle of a sentence that is too soon: the words
      // so far may be only the beginning, and the rest is listened for from the moment they ended.
      let since = modeBefore === 'spot' && typeof ask.end === 'number' ? ask.end : undefined;
      for (let turn = 0; turn < 6; turn++) {
        if (kind === 'ask' && (!text || since !== undefined)) {
          // Only the wake word so far (listen for the question itself), or words that may go on.
          const goingOn = this.box.q.some(x => x.type === 'speechstart' || x.type === 'utterance');
          if (!text && !goingOn) this._tone('listen');
          const heard = await this._collectAnswer({ prefix: text, since, moreSec: ask.whole ? Math.min(0.25, r.askMoreSec) : r.askMoreSec, startSec: 6, maxSec: 14, state: 'asking' });
          since = undefined;
          this._set('assistant');
          text = heard.text;
          if (!text || heard.cancelled || classifyCommand(text, ['enough', 'resume', 'cancel'])) break;
          const local = classifyCommand(text, INFO_COMMANDS);
          if (local) { kind = 'local'; name = local; } else { const act = classifyCommand(text, ['repeat', 'clues', 'back', 'skip', 'pause']); if (act) { action = act; break; } }
        }
        let reply;
        if (kind === 'local') {
          this.log('assistant (built in): ' + name);
          const lines = this._localReply(name);
          reply = await this._sayReply(async say => { for (const l of lines) say(l); return {}; });
        } else {
          this._emit('onAssistant', 'user', text);
          this.talk.push({ role: 'user', text });
          const a = this.assistant;
          if (!a || !a.available || !a.available()) {
            reply = await this._sayReply(async say => { say(PHRASES.needKey); return {}; });
            break;
          }
          this.log('assistant asked: ' + text);
          this._tone('think');
          const t0 = now(); let first = 0; const said = [];
          // Until the first words come, the same soft tone every few seconds says the question is being worked on.
          let waiting = null;
          const remind = () => { waiting = setTimer(() => { if (!first && !this.stopping) { this._tone('think'); remind(); } }, Math.max(0.02, r.thinkingToneSec) * 1000); };
          remind();
          try {
            reply = await this._sayReply(async (say, signal) => {
              const res = await a.ask({ text, context: this._context(), talk: this.talk.slice(0, -1), signal, say: s => { if (!first) first = now() - t0; said.push(s); say(s); } });
              return res || {};
            });
          } finally { first = first || -1; if (waiting) clearTimer(waiting); }
          if (reply.error) { this.log('assistant failed: ' + (reply.error.message || reply.error)); await this._sayReply(async say => { say(reply.error.spoken || PHRASES.assistantTrouble); return {}; }); break; }
          this.log(`assistant answered in ${Math.round(now() - t0)} ms (${first > 0 ? `first words after ${Math.round(first)} ms` : 'no words'}${reply.action ? ', asked for: ' + reply.action : ''}): ${said.join(' ').slice(0, 200)}`);
          this.talk.push({ role: 'assistant', text: said.join(' ') });
          if (this.talk.length > 12) this.talk.splice(0, this.talk.length - 12);
          if (reply.action) action = reply.action;
        }
        if (reply.skip) action = 'skip';
        if (action) break;
        if (reply.next !== undefined && reply.how === 'stopped') {
          if (!reply.next) break;               // "stop" / "thanks"
          kind = 'ask'; text = reply.next; continue; // a new question cut the reply short
        }
        if (kind === 'local') break;
        // A moment for a follow-up question, with no need for the wake word.
        this._tone('listen');
        const more = await this._collectAnswer({ startSec: r.followUpSec, maxSec: 14, state: 'asking' });
        this._set('assistant');
        if (!more.text || more.cancelled || classifyCommand(more.text, ['enough', 'resume', 'cancel'])) break;
        const act = classifyCommand(more.text, ['repeat', 'clues', 'back', 'skip', 'pause']);
        if (act) { action = act; break; }
        const local = classifyCommand(more.text, INFO_COMMANDS);
        if (local) { kind = 'local'; name = local; text = ''; } else { kind = 'ask'; text = splitWake(more.text).wake ? splitWake(more.text).rest : more.text; }
      }
    } finally {
      if (!this.stopping) {
        this._set(before);
        this._listen(modeBefore);
        const restarts = action === 'repeat' || action === 'clues' || action === 'back';
        if ((pausedHere || wasHeld) && reading && reading.state === 'paused' && !restarts && action !== 'skip') reading.resume();
      }
    }
    if (action === 'mark_right' || action === 'mark_wrong') {
      const rec = this.history[this.history.length - 1] || this.current;
      if (this.override(rec, action === 'mark_right')) await this._say(action === 'mark_right' ? PHRASES.markedRight : PHRASES.markedWrong);
      return null;
    }
    // Speed and volume belong to the app's settings: passed on, as when they are asked for directly.
    if (action === 'faster' || action === 'slower' || action === 'louder' || action === 'quieter') { this._emit('onCommand', action); return null; }
    return action;
  }

  // ---- tossup ----------------------------------------------------------------------------

  /** Where to start again for "go back": the sentence being read, or the one before when it has only just begun. */
  _backOffset (chunks, pos) {
    let i = chunks.findIndex(c => c.end > pos);
    if (i < 0) i = chunks.length - 1;
    if (i > 0 && pos - chunks[i].start < 40) i--;
    return Math.max(0, chunks[i] ? chunks[i].start : 0);
  }

  async _tossup (q) {
    const r = this.rules();
    const prep = prepareTossup(q);
    const rec = { id: q._id, type: 'tossup', q, text: prep.text, powerOffset: prep.powerOffset, answer: q.answer || q.answer_sanitized, answerText: mainAnswer(q.answer_sanitized), result: null, points: 0, heard: '', buzzOffset: null, at: Date.now() };
    this.current = rec; this.talk = [];
    this._emit('onQuestion', rec);
    this.narrator.prepare(prep.chunks, { group: this.narrator.newGroup('tu'), count: 2 });
    this._prepareReveal(q._id, rec.answer, q.answer_sanitized, this.verify);
    if (r.announceType) await this._say(PHRASES.tossup);

    const total = prep.text.length;
    let from = 0; let restarts = 0;
    let verdict = null; let answer = { text: '' }; let finished = false;
    // One pass per stretch of reading: the first, and again after "repeat", "go back", or a buzz that was taken back.
    while (!verdict) {
      this._set('reading', { type: 'tossup' });
      this._listen(r.buzzSensitivity === 'off' ? 'off' : 'spot');
      const reading = this._startReading(prep.chunks, prep.text, { group: this.narrator.newGroup('tu'), gap: r.sentenceGapSec, from, onProgress: off => this._emit('onProgress', off, total) });
      let outcome = null;       // { kind: 'buzz', at, prefix, since } | { kind: 'dead' } | { kind: 'again', from, say }
      let deadline = null; let confirm = null;
      const dead = () => ({ at: now() + r.tossupDeadSec * 1000 });
      const again = (offset, say) => { outcome = { kind: 'again', from: offset, say }; };
      const endConfirm = () => { if (confirm) { clearTimer(confirm.timer); confirm = null; } };
      try {
        while (!outcome) {
          const e = await this._next(deadline, { onPause: endConfirm, restartable: true });
          if (e.type === 'readingDone') {
            if (e.reading !== reading) continue;
            this._emit('onProgress', total, total);
            this._set('waiting', { seconds: r.tossupDeadSec });
            deadline = dead();
          } else if (e.type === 'timeout') {
            outcome = { kind: 'dead' };
          } else if (e.type === 'tap') {
            if (e.action === 'buzz') outcome = { kind: 'buzz', at: this.audio.time, prefix: '', since: this.audio.time };
            else if (e.action === 'repeat') again(0, true);
            else if (e.action === 'back') again(this._backOffset(prep.chunks, reading.position()));
          } else if (e.type === 'speechstart') {
            // Somebody is talking: stop reading at once. What it was is decided when the words arrive.
            // After the question has been read there is nothing to stop, but time must not run out mid-word.
            if (r.buzzSensitivity !== 'off' && !this._holdBegin(reading) && deadline && reading.state === 'finished') deadline.at = Math.max(deadline.at, now() + 2000);
          } else if (e.type === 'speechend') {
            if (this._hold) this._hold.speaking = false;
            if (e.dropped && !confirm) this._holdEnd('a short noise', false);
          } else if (e.type === 'holdTimeout') {
            const h = this._hold;
            if (!h || e.hold !== h || confirm) continue;
            if (h.speaking && h.extended < 2) { h.extended++; this._armHold(h, 1000); continue; }
            this._holdEnd('no words followed', false);
          } else if (e.type === 'confirmTimeout') {
            if (!confirm || e.confirm !== confirm) continue;
            confirm = null;
            this._emit('onHeard', '');
            if (!this._holdEnd('the sound was not repeated', false) && reading.state === 'finished') deadline = dead();
          } else if (e.type === 'handled') {
            endConfirm();
            if (e.action === 'repeat' || e.action === 'clues') again(0, true);
            else if (e.action === 'back') again(this._backOffset(prep.chunks, reading.position()));
            else { this._holdEnd('', true); if (reading.state === 'finished') deadline = dead(); }
          } else if (e.type === 'utterance') {
            if (this._hold) this._hold.speaking = false;
            const text = String(e.text || '').trim();
            if (text && this._ownVoice(e, text)) { this.log('ignored: that was the reader\'s own voice'); if (!confirm) this._holdEnd('it was the reader', false); continue; }
            if (!text) {
              // Something short was said but could not be made out (often a "buzz" spoken over the
              // reader). Rather than ignore it, stop and give a moment for it to be said again.
              // (Short, and loud enough to have been a voice near the microphone rather than a stir in the background.)
              const short = (e.dur || 0) >= 0.1 && (e.dur || 0) <= 1.6 && (e.level === undefined || e.level >= 0.006);
              if (!confirm && short && r.buzzSensitivity === 'normal' && this._unclearAllowed()) {
                if (reading.state === 'reading' && !this._hold) { reading.pause(); this._hold = { reading, at: now(), speaking: false, extended: 0 }; }
                if (this._holdTimer) { clearTimer(this._holdTimer); this._holdTimer = null; }
                this._unclear.asked++;
                this._tone('unsure');
                this._emit('onHeard', '?');
                const c = { at: e.start, since: e.end }; confirm = c;
                c.timer = setTimer(() => this.box.post({ type: 'confirmTimeout', confirm: c }), r.confirmSec * 1000);
                deadline = null;
                this.log('could not make that out; waiting a moment for it to be said again');
              } else if (!confirm) this._holdEnd('nothing was recognised', false);
              continue;
            }
            const cmd = classifyCommand(text, ['repeat', 'clues', 'back']);
            if (cmd) { endConfirm(); this.log('command: ' + cmd); if (cmd === 'back') again(this._backOffset(prep.chunks, reading.position())); else again(0, true); continue; }
            const b = classifyBuzz({ text, dur: e.dur }, r.buzzSensitivity);
            if (confirm) {
              // Whatever is said in answer to "say again?" is the buzz; more than the buzz word is the answer itself.
              this._unclear.confirmed++;
              const at = confirm.at; endConfirm();
              outcome = { kind: 'buzz', at, prefix: b.buzz ? b.rest : (isOnlyBuzz(text) ? '' : text), since: e.end, why: 'said again' };
            } else if (b.buzz) outcome = { kind: 'buzz', at: e.start, prefix: b.rest, since: e.end, why: b.why };
            else {
              this._emit('onHeard', text, 'ignored');
              this._holdEnd('"' + text.slice(0, 40) + '" was not a buzz', false);
              if (reading.state === 'finished') deadline = dead();
            }
          }
        }
      } finally { endConfirm(); }

      if (outcome.kind === 'again') {
        this._holdEnd('', true, { resume: false });
        reading.stop(); this.reading = null;
        from = outcome.from;
        if (outcome.say && ++restarts <= 3) await this._say(PHRASES.restart);
        continue;
      }
      if (outcome.kind === 'dead') {
        this._holdEnd('', true, { resume: false });
        reading.stop(); this.reading = null;
        rec.result = 'dead'; rec.points = 0;
        this._listen('off');
        this._tone('time');
        await this._say(PHRASES.time);
        await this._finishQuestion(rec, true);
        return rec;
      }

      // Buzz.
      // The buzz counts from the moment the voice began, not from when the reader stopped for it.
      finished = reading.state === 'finished';
      rec.buzzOffset = finished ? total : reading.positionAt(outcome.at - (this.audio.latency || 0));
      this._holdEnd('', true, { resume: false });
      reading.stop(); this.reading = null;
      this._emit('onProgress', rec.buzzOffset, total, true);
      this.log(`buzz at character ${rec.buzzOffset}/${total}` + (outcome.why ? ` (${outcome.why})` : ''));
      this._tone('buzz');
      if (r.selfJudge) { this._emit('onAnswer', rec); verdict = await this._selfJudge(q._id, rec.answer, q.answer_sanitized); } else {
        answer = await this._collectAnswer({ prefix: outcome.prefix, since: outcome.since });
        if (answer.cancelled) {
          // The buzz is taken back: no penalty, and the reading picks up a few words before it stopped.
          this.log('buzz taken back');
          const at = rec.buzzOffset; rec.buzzOffset = null;
          await this._say(PHRASES.cancelled);
          from = finished ? Math.max(0, prep.chunks.length ? prep.chunks[prep.chunks.length - 1].start : 0) : Math.max(0, at - 20);
          continue;
        }
        verdict = await this._judgeWithPrompts(rec.answer, answer);
      }
    }

    rec.heard = verdict.heard || answer.text; rec.method = verdict.method;
    this._set('result');
    const early = !finished && rec.buzzOffset < total - 1;
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
        const rest = this._startReading(prep.chunks, prep.text, { group: this.narrator.newGroup('rest'), gap: r.sentenceGapSec, from: rec.buzzOffset, onProgress: off => this._emit('onProgress', off, total) });
        this._set('reading', { type: 'tossup', rest: true });
        try { for (;;) { const e = await this._next(null); if (e.type === 'readingDone' && e.reading === rest) break; if (e.type === 'tap' && e.action === 'next') break; } } finally { rest.stop(); this.reading = null; }
      }
      if (!verdict.self) await this._finishQuestion(rec, true);
    }
    return rec;
  }

  /** Asking for an unclear sound to be repeated is dropped when it keeps leading nowhere (a noisy car). */
  _unclearAllowed () { return !(this._unclear.asked >= 4 && this._unclear.confirmed === 0) && !(this._unclear.asked >= 8 && this._unclear.confirmed * 4 < this._unclear.asked); }

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
    const firstGroup = this.narrator.newGroup('bn');
    const rec = { id: q._id, type: 'bonus', q, leadin: prep.leadin.text, parts: prep.parts.map((p, i) => ({ text: p.text, answer: (q.answers && q.answers[i]) || q.answers_sanitized[i], answerText: mainAnswer(q.answers_sanitized[i]), result: null, points: 0, heard: '' })), points: 0, at: Date.now() };
    this.current = rec; this.talk = [];
    this._emit('onQuestion', rec);
    if (prep.leadin.chunks.length) this.narrator.prepare(prep.leadin.chunks, { group: leadGroup, count: 2 }); else this.narrator.prepare(prep.parts[0].chunks, { group: firstGroup, count: 2 });
    q.answers_sanitized.forEach((a, i) => this._prepareReveal(`${q._id}:${i}`, rec.parts[i].answer, a, i === 0 ? this.verify : null));
    if (r.announceType) await this._say(PHRASES.bonus);

    // Lead-in: nothing to answer yet.
    if (prep.leadin.chunks.length) {
      this._set('reading', { type: 'bonus', part: -1 });
      this._listen('spot');
      const lead = this._startReading(prep.leadin.chunks, prep.leadin.text, { group: leadGroup, gap: r.sentenceGapSec, onProgress: off => this._emit('onProgress', off, prep.leadin.text.length, false, -1) });
      this.narrator.prepare(prep.parts[0].chunks, { group: firstGroup, count: 2 });
      try { for (;;) { const e = await this._next(null); if (e.type === 'readingDone' && e.reading === lead) break; } } finally { lead.stop(); this.reading = null; }
    }

    for (let i = 0; i < prep.parts.length; i++) {
      const part = prep.parts[i]; const pr = rec.parts[i];
      if (i + 1 < prep.parts.length) this.narrator.prepare(prep.parts[i + 1].chunks, { group: this.narrator.newGroup('bn'), count: 1, priority: 7 });
      this._emit('onPart', rec, i);
      const direct = r.bonusDirectAnswer && r.buzzSensitivity !== 'off';
      let answer = null; let from = 0;
      // One pass per stretch of reading, as for a tossup: again after "repeat" or "go back".
      while (answer === null) {
        this._set('reading', { type: 'bonus', part: i });
        this._listen(r.buzzSensitivity === 'off' ? 'off' : (direct ? 'answer' : 'spot'));
        const reading = this._startReading(part.chunks, part.text, { group: this.narrator.newGroup('bn'), gap: r.sentenceGapSec, from, onProgress: off => this._emit('onProgress', off, part.text.length, false, i) });
        let deadline = null; let interrupted = false; let speaking = false; let redo = null;
        const hardCap = () => ({ at: now() + r.answerMaxSec * 1000 });
        const window = () => ({ at: now() + r.bonusAnswerSec * 1000 });
        const resumeReading = () => { if (interrupted) { interrupted = false; if (reading.state === 'paused') reading.resume(); this._set(reading.state === 'finished' ? 'waiting' : 'reading', { type: 'bonus', part: i }); } };
        const afterNothing = () => { resumeReading(); deadline = reading.state === 'finished' ? { at: now() + Math.max(2, r.bonusAnswerSec) * 1000 } : null; };
        try {
          while (answer === null && redo === null) {
            const e = await this._next(deadline, { onResume: () => { interrupted = false; }, restartable: true });
            if (e.type === 'readingDone') {
              if (e.reading !== reading) continue;
              this._emit('onProgress', part.text.length, part.text.length, false, i);
              this._set('waiting', { seconds: r.bonusAnswerSec });
              if (!speaking) deadline = window();
            } else if (e.type === 'timeout') {
              answer = { text: '', timedOut: true };
            } else if (e.type === 'tap') {
              if (e.action === 'buzz' && r.selfJudge) { reading.stop(); answer = { text: '', self: true }; } else if (e.action === 'buzz') { reading.stop(); this._tone('buzz'); const a = await this._collectAnswer({ since: this.audio.time }); if (a.cancelled) { await this._say(PHRASES.cancelled); redo = this._backOffset(part.chunks, reading.position()); } else answer = a; } else if (e.action === 'next') answer = { text: '', timedOut: true };
              else if (e.action === 'repeat') redo = 0;
              else if (e.action === 'back') redo = this._backOffset(part.chunks, reading.position());
            } else if (e.type === 'speechstart') {
              speaking = true;
              if (reading.state === 'reading' && (direct || this._holdAllowed())) { reading.pause(); interrupted = true; if (direct) this._set('answering'); }
              deadline = hardCap();
            } else if (e.type === 'speechend') {
              if (e.dropped) { speaking = false; afterNothing(); }
            } else if (e.type === 'handled') {
              speaking = false;
              if (e.action === 'repeat' || e.action === 'clues') redo = 0;
              else if (e.action === 'back') redo = this._backOffset(part.chunks, reading.position());
              else afterNothing();
            } else if (e.type === 'utterance') {
              speaking = false;
              const text = String(e.text || '').trim();
              const echo = text && !interrupted && this._ownVoice(e, text);
              const cmd = text && !echo ? classifyCommand(text, ['repeat', 'clues', 'back']) : null;
              if (cmd) { this.log('command: ' + cmd); redo = cmd === 'back' ? this._backOffset(part.chunks, reading.position()) : 0; continue; }
              const b = text ? classifyBuzz({ text, dur: e.dur }, 'strict') : { buzz: false, rest: '' };
              if (!text || echo || isFillerOnly(text) || (!direct && !b.buzz)) {
                if (echo) this.log('ignored: that was the reader\'s own voice');
                afterNothing();
                continue;
              }
              reading.stop();
              if (b.buzz && !b.rest) { this._tone('buzz'); const a = await this._collectAnswer({ since: e.end }); if (a.cancelled) { await this._say(PHRASES.cancelled); redo = this._backOffset(part.chunks, reading.position()); } else answer = a; } else { const said = b.buzz ? b.rest : text; this._emit('onHeard', said); answer = { text: said, timedOut: false }; }
            }
          }
        } finally { reading.stop(); this.reading = null; }
        if (redo !== null) from = redo;
      }
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

  /** A short window after each question for spoken corrections and questions; also where the next question is fetched. */
  async _between (rec) {
    const r = this.rules();
    this._set('between');
    this._listen(r.buzzSensitivity === 'off' ? 'off' : 'spot');
    const deadline = { at: now() + r.betweenSec * 1000 };
    let speaking = false;
    for (;;) {
      let e;
      try { e = await this._next(deadline, { free: true }); } catch (err) { if (err instanceof SkipSignal) break; throw err; }
      if (e.type === 'timeout') { if (speaking) { speaking = false; deadline.at = now() + 2500; continue; } break; }
      // Someone has started to say something: do not move on in the middle of it.
      if (e.type === 'speechstart') { speaking = true; deadline.at = Math.max(deadline.at, now() + 6000); continue; }
      if (e.type === 'speechend') { speaking = false; if (e.dropped) deadline.at = now() + Math.min(1500, r.betweenSec * 1000); continue; }
      if (e.type === 'handled') {
        speaking = false;
        if (e.action === 'repeat' || e.action === 'clues' || e.action === 'back') { this._listen('off'); await this._repeat(rec); this._listen('spot'); }
        deadline.at = now() + r.betweenSec * 1000;
        continue;
      }
      let cmd = null;
      if (e.type === 'tap') cmd = e.action;
      else if (e.type === 'utterance') { speaking = false; cmd = classifyCommand(e.text, ['right', 'wrong', 'repeat', 'clues', 'back', 'skip']); if (cmd) this.log('command: ' + cmd); else deadline.at = Math.max(deadline.at, now() + 1200); }
      if (cmd === 'next' || cmd === 'skip') break;
      if (cmd === 'right' || cmd === 'wrong') {
        if (this.override(rec, cmd === 'right')) await this._say(cmd === 'right' ? PHRASES.markedRight : PHRASES.markedWrong);
        deadline.at = now() + 1200;
      } else if ((cmd === 'repeat' || cmd === 'clues' || cmd === 'back') && rec) {
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
      const reading = this._startReading(chunkForSpeech(t), t, { group: this.narrator.newGroup('rp'), gap: this.rules().sentenceGapSec });
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
    this._emit('onSaved', rec);
    return true;
  }

  score () { return scoreOf(this.history); }

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
          this._holdEnd('', true, { resume: false });
          if (this.reading) { this.reading.stop(); this.reading = null; }
          this._listen('off');
          rec = this.current && this.current.id === q._id ? this.current : { id: q._id, type: q.type, q, points: 0, parts: [], at: Date.now() };
          if (e instanceof SkipSignal) {
            this.log('skipped');
            rec.result = 'skipped';
            if (rec.type === 'tossup') rec.points = 0;
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
        this._emit('onSaved', rec);
        if (this.stopping || played >= limit) break;
        // Fetch the next question while the correction window runs.
        next = this._fetch(this._nextType());
        next.catch(() => {});
        next.then(nq => { try { if (nq.type === 'tossup') { this.narrator.prepare(prepareTossup(nq).chunks, { count: 1, priority: 7 }); this._prepareReveal(nq._id, nq.answer || nq.answer_sanitized, nq.answer_sanitized, this.verify); } } catch (e) { /* preparation is best effort */ } }, () => {});
        await this._between(rec);
      }
    } catch (e) {
      if (!(e instanceof StopSignal)) { this.log('game loop failed: ' + (e && e.stack ? e.stack : e)); this._emit('onError', e); } else {
        // Ended in the middle of a question: what was already settled (a verdict, some bonus parts) is kept for review.
        const c = this.current;
        const settled = c && !this.history.includes(c) && (c.type === 'tossup' ? (c.result !== null && c.result !== undefined) : (c.parts || []).some(p => p.result !== null && p.result !== undefined));
        if (settled) { this.history.push(c); this.count[c.type]++; this._emit('onSaved', c); }
      }
    } finally {
      for (const [name, fn] of Object.entries(this._on)) this.listener.removeEventListener(name, fn);
      this._holdEnd('', true, { resume: false });
      try { if (this.reading) this.reading.stop(); this.narrator.stop(); this.listener.setMode('off'); } catch (e) { /* shutting down */ }
      this.reading = null; this.running = false; this.stopping = false; this.paused = false;
      this._set('idle');
      this._emit('onScore', this.score());
    }
  }
}
