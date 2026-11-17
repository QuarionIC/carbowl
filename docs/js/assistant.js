// Answers what the app cannot answer by itself: "Moderator, who was David Hume?", "why was that the
// answer?", "switch to math". The model is Claude, called straight from this page with the
// listener's own Anthropic API key, through Anthropic's SDK (bundled in ../vendor/anthropic-sdk.js
// and loaded the first time it is needed). A reply is streamed and handed on sentence by sentence,
// so the first words are spoken while the rest is still being written.
//
// One request per question, always: everything the model needs is in the request (the state of the
// quiz), and the things it can do (repeat, skip, switch topics, ...) are carried out by the app
// without going back to the model for a second round.

import { splitSentences, chunkForSpeech, cleanForSpeech } from './speechtext.js';
import { setTimer, clearTimer } from './clock.js';

/**
 * The models on offer and the request settings each is run with. All at low effort, because here
 * the wait before the first spoken word matters more than depth. Opus 5.5 always thinks (effort is
 * its only control); Haiku 5.5 may be told not to, which is the quickest start there is.
 */
export const ASSISTANT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'best answers', request: { output_config: { effort: 'low' } } },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'in between', request: { output_config: { effort: 'low' } } },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fastest and cheapest', request: { output_config: { effort: 'low' }, thinking: { type: 'disabled' } } }
];
export const DEFAULT_ASSISTANT_MODEL = 'claude-opus-5-5';

export const SYSTEM = `You are the moderator's voice in Carbowl, a hands-free quizbowl practice app. The listener is driving: they hear quiz questions read aloud and they talk to you. Everything you write is spoken by a speech synthesiser, and what they say reaches you through speech recognition.

How to answer
- Lead with the answer, in one to three short spoken sentences. Say more only when asked for more.
- Write plain spoken English: no markdown, lists, headings, symbols, abbreviations or asides in brackets. Write numbers, formulas and notation the way they are said aloud.
- Speech recognition mishears things, names above all. Read what was said charitably and use the state of the quiz to work out which name or title was meant. If you cannot tell what was asked, ask them in a few words to say it again.
- If you do not know something, say so briefly. Never invent facts, titles or dates.

The quiz
- Each message comes with the state of the quiz: the question in play as far as it has been read aloud, earlier questions with their answer lines and what the listener answered, and the score.
- While a question is in play its answer is kept from you on purpose. Do not name it, guess at it, confirm or deny a guess, or give hints that narrow it down, even when you are sure what it is and even when asked directly. Say that it would be telling, and that they can say "skip" to hear the answer. You may still explain other things, including names and terms from the clues read so far.
- Once a question is over you have its full text and answer line. Then explain freely: why the answer is right, what a clue referred to, how the listener's answer compares, and related people and works worth knowing for quizbowl.

Doing things
- When the listener wants something done rather than explained, call the matching tool and write no reply: the app carries the action out and confirms it itself. Examples: hearing the question again, skipping it, pausing, changing the reading speed or the volume, correcting a verdict ("I said Kant, count that"), switching topics.
- Call a tool only when the listener asked for that action.`;

// What the model may ask the app to do, and the name the game knows each by.
const ACTIONS = {
  repeat_question: 'repeat',
  earlier_clues: 'clues',
  go_back_a_sentence: 'back',
  skip_question: 'skip',
  pause_quiz: 'pause',
  mark_correct: 'mark_right',
  mark_incorrect: 'mark_wrong',
  read_faster: 'faster',
  read_slower: 'slower',
  volume_up: 'louder',
  volume_down: 'quieter'
};
const TOPIC_KEYS = ['philosophy', 'math', 'computer_science'];

// eager_input_streaming: these requests are streamed, so tool input arrives as it is written and is
// not checked by the server; every input is checked here before anything is done with it.
export const TOOLS = [
  {
    name: 'quiz_action',
    description: 'Carry out something the listener asked the quiz to do. Call it when they ask to hear the question again from the start (repeat_question), to hear the clues read so far again (earlier_clues), to hear just the last sentence again (go_back_a_sentence), to skip the current question (skip_question), to pause (pause_quiz), to overrule the verdict on the question just answered in their favour (mark_correct) or against them (mark_incorrect), or to change how fast (read_faster, read_slower) or how loud (volume_up, volume_down) the reader is. Do not call it to answer a question about the quiz: answer in words instead.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: Object.keys(ACTIONS), description: 'What to do.' } },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'set_topics',
    description: 'Switch the one-tap question topics on or off, from the next question on. Call it when the listener asks for a different subject ("switch to math", "add computer science", "philosophy only"). Give all three values every time, keeping the current value of any topic they did not mention; the current values are in the state of the quiz. At least one must stay on.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      properties: {
        philosophy: { type: 'boolean', description: 'Philosophy questions on (true) or off (false).' },
        math: { type: 'boolean', description: 'Math questions on or off.' },
        computer_science: { type: 'boolean', description: 'Computer Science questions on or off.' }
      },
      required: TOPIC_KEYS,
      additionalProperties: false
    }
  }
];

/** Checks a tool call the model made. @returns {{ action?: string, topics?: object } | null} null when the input is not usable */
export function readToolCall (block) {
  const input = block && block.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (block.name === 'quiz_action') {
    return typeof input.action === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, input.action) ? { action: ACTIONS[input.action] } : null;
  }
  if (block.name === 'set_topics') {
    if (!TOPIC_KEYS.every(k => typeof input[k] === 'boolean')) return null;
    return { topics: { philosophy: input.philosophy, math: input.math, cs: input.computer_science } };
  }
  return null;
}

// ---------- what the model is told about the quiz ----------

const quote = s => `"${String(s == null ? '' : s).replace(/\s+/g, ' ').trim()}"`;
const TOSSUP_RESULT = { power: 'correct, for power (15 points)', ten: 'correct (10 points)', neg: 'wrong, while the question was still being read (minus 5)', wrong: 'wrong', dead: 'no buzz before time ran out', skipped: 'skipped' };
const PART_RESULT = { correct: 'correct', wrong: 'wrong', none: 'no answer in time' };

function tossupLines (t, lead) {
  const out = [`${lead}Text: ${quote(t.question)}`, `Answer line: ${quote(t.answer)}`];
  out.push(t.heard ? `The listener answered ${quote(t.heard)}: ${TOSSUP_RESULT[t.result] || t.result || 'not judged yet'}.` : `Outcome: ${TOSSUP_RESULT[t.result] || t.result || 'not judged yet'}.`);
  return out;
}
function partLines (parts) {
  return (parts || []).map((p, i) => `Part ${i + 1}: ${quote(p.question)} Answer line: ${quote(p.answer)} ${p.heard ? `The listener answered ${quote(p.heard)}: ` : 'Outcome: '}${PART_RESULT[p.result] || p.result || 'not judged yet'}.`);
}
const about = c => [c.type, c.subcategory || c.category, c.set ? `from ${c.set}` : '', c.difficulty ? `${c.difficulty} level` : ''].filter(Boolean).join(', ');

/**
 * The state of the quiz as text for the model. The answer to a question still in play is not in
 * the context the game hands over, and so not in here either.
 * @param {object} c what Game._context() returns
 * @param {{ on: string[], off: string[] }} [topics] the one-tap topics, by name
 */
export function describeQuiz (c, topics) {
  c = c || {};
  const lines = [];
  const s = c.score || {};
  const bits = [];
  if (s.tossups) bits.push(`tossups: ${(s.powers || 0) + (s.tens || 0)} right of ${s.tossups} heard${s.powers ? `, ${s.powers} for power` : ''}${s.negs ? `, ${s.negs} answered wrong early` : ''}`);
  if (s.bonuses) bits.push(`bonuses: ${s.bonuses} heard, ${Number(s.ppb || 0).toFixed(1)} points per bonus`);
  lines.push(bits.length ? `Score so far: ${s.points || 0} points (${bits.join('; ')}).` : 'No questions have been scored yet.');
  if (topics) lines.push(`Topics switched on: ${topics.on.join(', ') || 'none'}. Switched off: ${topics.off.join(', ') || 'none'}.`);
  const cur = c.current;
  if (cur && cur.live) {
    lines.push('', `QUESTION IN PLAY (its answer is withheld from you): ${about(cur)}.`);
    if (cur.type === 'tossup') lines.push(cur.readSoFar ? `Read aloud so far: ${quote(cur.readSoFar)}` : 'Nothing of it has been read aloud yet.');
    else {
      if (cur.leadin) lines.push(`Lead-in: ${quote(cur.leadin)}`);
      lines.push(...partLines(cur.partsAnswered));
      if (cur.partInPlay) lines.push(`Part ${cur.partInPlay.number} is in play. ${cur.partInPlay.readSoFar ? `Read aloud so far: ${quote(cur.partInPlay.readSoFar)}` : 'It has been read to the listener, or is about to be; its text is withheld along with its answer.'}`);
    }
  } else if (cur) {
    lines.push('', `THE QUESTION JUST FINISHED: ${about(cur)}.`);
    if (cur.type === 'tossup') lines.push(...tossupLines(cur, ''));
    else { if (cur.leadin) lines.push(`Lead-in: ${quote(cur.leadin)}`); lines.push(...partLines(cur.partsAnswered)); }
  } else lines.push('', 'No question has been read yet.');
  // The question just finished is also the newest entry of the history: say it once.
  let earlier = (c.earlier || []).slice();
  const same = (a, b) => a && b && a.type === b.type && (a.type === 'tossup' ? a.question === b.question : a.leadin === b.leadin && (a.parts || []).length === (b.partsAnswered || []).length);
  if (cur && !cur.live && earlier.length && same(earlier[earlier.length - 1], cur)) earlier = earlier.slice(0, -1);
  if (earlier.length) {
    lines.push('', 'EARLIER QUESTIONS, oldest first:');
    earlier.forEach((h, i) => {
      if (h.type === 'tossup') lines.push(...tossupLines(h, `${i + 1}. Tossup. `));
      else { lines.push(`${i + 1}. Bonus (${h.points || 0} points).${h.leadin ? ` Lead-in: ${quote(h.leadin)}` : ''}`); lines.push(...partLines(h.parts)); }
    });
  }
  return `<quiz_state>\n${lines.join('\n')}\n</quiz_state>`;
}

/**
 * The request for one question from the listener.
 * @param {object} o
 * @param {string} o.model one of ASSISTANT_MODELS (anything else falls back to the default)
 * @param {string} o.text what the listener said
 * @param {object} o.context Game._context()
 * @param {{ role: 'user'|'assistant', text: string }[]} [o.talk] earlier turns of this conversation
 * @param {{ on: string[], off: string[] }} [o.topics] current topics; leaving it out withholds the topic tool
 */
export function buildRequest ({ model, text, context, talk = [], topics }) {
  const m = ASSISTANT_MODELS.find(x => x.id === model) || ASSISTANT_MODELS.find(x => x.id === DEFAULT_ASSISTANT_MODEL);
  // Earlier turns go back as plain text. (No thinking blocks are replayed, so nothing ties a later
  // request to an earlier one; a turn in which the model only did something is skipped.)
  const messages = [];
  for (const t of talk || []) {
    const said = String((t && t.text) || '').trim();
    if (!said || (t.role !== 'user' && t.role !== 'assistant')) continue;
    if (!messages.length && t.role !== 'user') continue; // a conversation starts with the listener
    messages.push({ role: t.role, content: said });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: describeQuiz(context, topics) },
      { type: 'text', text: `The listener said (as heard by speech recognition): ${quote(text)}` }
    ]
  });
  return { model: m.id, max_tokens: 4096, system: SYSTEM, tools: topics ? TOOLS : TOOLS.filter(t => t.name !== 'set_topics'), messages, ...m.request };
}

// ---------- text as it streams in -> sentences ready to be spoken ----------

/** Strips the marks of written text that a voice should not read out, then tidies for speech. */
export function replyForSpeech (raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/```[a-z]*\n?/gi, ' ').replace(/`([^`]*)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  t = t.replace(/(^|[\s("'])\*([^*\s][^*]*)\*(?=[\s)"'.,;:!?]|$)/g, '$1$2').replace(/(^|[\s("'])_([^_\s][^_]*)_(?=[\s)"'.,;:!?]|$)/g, '$1$2');
  t = t.replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1');
  t = t.replace(/(^|\s)#{1,6}\s+/g, '$1');
  return cleanForSpeech(t).text;
}

/** Line breaks become sentence breaks and list markers go, so that what is left can be split into sentences. */
function flatten (raw) {
  let t = raw.replace(/\r/g, '').replace(/\t/g, ' ');
  t = t.replace(/(^|\n) *(?:[-*•]|\d{1,2}[.)]) +/g, '$1');
  t = t.replace(/ *\n+ */g, (m, at, all) => at === 0 ? '' : (/[.!?:;,]["')\]]*$/.test(all.slice(0, at)) ? ' ' : '. '));
  return t.replace(/ {2,}/g, ' ');
}

/**
 * Takes text as it arrives in pieces and hands on whole sentences, cleaned for the voice. A sentence
 * is only known to be whole once the next one has begun (or the reply has ended), and very short
 * ones ("Yes.") go out together with what follows, so the voice is not handed scraps.
 */
export class SpeechStream {
  /** @param {(sentence: string) => void} emit */
  constructor (emit, { minChars = 16, maxChars = 240 } = {}) {
    this.emit = emit; this.minChars = minChars; this.maxChars = maxChars;
    this.raw = '';
    this.count = 0;   // pieces handed on
    this.text = '';   // everything handed on, as spoken
  }

  push (delta) { if (!delta) return; this.raw += delta; this._drain(false); }
  end () { this._drain(true); }

  _drain (final) {
    let raw = this.raw; let keep = '';
    if (!final) {
      // A line that has only just begun may yet turn out to start with a list marker: leave it for the next round.
      const m = raw.match(/\n[ \t]*(?:[-*•]|\d{1,2}[.)]?)?[ \t]*$/);
      if (m) { keep = raw.slice(m.index); raw = raw.slice(0, m.index); }
    }
    const pieces = splitSentences(flatten(raw));
    const whole = final ? pieces.length : Math.max(0, pieces.length - 1);
    let acc = '';
    for (let i = 0; i < whole; i++) {
      acc = acc ? acc + ' ' + pieces[i].text.trim() : pieces[i].text.trim();
      if (acc.length >= this.minChars) { this._say(acc); acc = ''; }
    }
    const rest = final ? '' : (pieces.length ? pieces[pieces.length - 1].text : '');
    if (final) { if (acc) this._say(acc); this.raw = ''; return; }
    this.raw = (acc ? acc + ' ' : '') + rest + keep;
  }

  _say (sentence) {
    const clean = replyForSpeech(sentence);
    if (!/[A-Za-z0-9À-ɏ]/.test(clean)) return;
    // Only what is too long for one breath is divided further (a scrap joined to its neighbour stays joined).
    for (const c of clean.length <= this.maxChars ? [{ text: clean }] : chunkForSpeech(clean, this.maxChars)) {
      const t = c.text.trim();
      if (!t) continue;
      this.count++; this.text += (this.text ? ' ' : '') + t;
      this.emit(t);
    }
  }
}

// ---------- the assistant ----------

const SPOKEN = {
  noKey: 'There is no assistant key yet. Add one in Settings.',
  load: 'I could not load the assistant.',
  auth: 'The assistant key was not accepted. Check it in Settings.',
  permission: 'That key may not use this model. Check it in Settings.',
  model: 'That model is not available to your key. Pick another in Settings.',
  billing: 'The assistant account needs credit. Check billing in the Anthropic console.',
  rate: 'The assistant is at its limit for the moment. Try again shortly.',
  slow: 'The assistant took too long to answer.',
  reach: 'I could not reach the assistant.',
  server: 'The assistant is having trouble right now. Try again shortly.',
  request: 'The assistant would not take that request.',
  garbled: 'Sorry, say that again?',
  refused: 'I cannot help with that one.',
  empty: 'Sorry, I have nothing to say to that.',
  topicsKept: 'At least one topic has to stay on.',
  topicsOff: 'Okay. Those topics are off from the next question.'
};
export const ASSISTANT_PHRASES = SPOKEN;
// The API's error types, and which of the sentences above each one gets.
const BY_TYPE = { authentication_error: 'auth', permission_error: 'permission', not_found_error: 'model', billing_error: 'billing', rate_limit_error: 'rate', overloaded_error: 'server', api_error: 'server', timeout_error: 'slow', invalid_request_error: 'request', request_too_large: 'request' };

/** An error the listener should hear about: spoken is what to say, message is for the log. */
export class AssistantError extends Error {
  constructor (spoken, message, cause) { super(message || spoken); this.name = 'AssistantError'; this.spoken = spoken; if (cause) this.cause = cause; }
}

export class Assistant {
  /**
   * @param {object} o
   * @param {() => string} o.key the listener's Anthropic API key ('' when none is saved)
   * @param {() => string} o.model the model id chosen in Settings
   * @param {() => Promise<object>} o.sdk loads Anthropic's SDK (a module whose default export is the client class)
   * @param {{ get: () => { on: string[], off: string[] }, set: (t: { philosophy: boolean, math: boolean, cs: boolean }) => { ok: boolean, on: string[] } }} [o.topics]
   * @param {string} [o.baseURL] for tests only: a stand-in for the API
   * @param {number} [o.timeoutMs] how long to wait for the reply to begin
   * @param {number} [o.stallMs] how long a reply that has begun may go quiet
   */
  constructor ({ key, model, sdk, topics, log, baseURL, timeoutMs = 15000, stallMs = 15000 }) {
    this.key = key; this.model = model; this.sdk = sdk; this.topics = topics || null; this.log = log || (() => {});
    this.baseURL = baseURL || ''; this.timeoutMs = timeoutMs; this.stallMs = stallMs;
    this._sdk = null; this._client = null; this._clientKey = '';
    this.last = null; // how the latest request went (for Settings and the log)
  }

  available () { return !!this._key(); }
  _key () { try { return String(this.key() || '').trim(); } catch (e) { return ''; } }

  /** Fetches the SDK ahead of the first question, so that question does not wait for it. */
  warm () { if (this.available()) this._load().catch(() => {}); }

  _load () {
    if (!this._sdk) {
      this._sdk = Promise.resolve().then(() => this.sdk()).then(m => {
        const Anthropic = m && (m.default || m.Anthropic);
        if (typeof Anthropic !== 'function') throw new Error('the SDK module has no client class');
        return Anthropic;
      });
      this._sdk.catch(() => { this._sdk = null; });
    }
    return this._sdk;
  }

  _clientFor (Anthropic, key) {
    if (!this._client || this._clientKey !== key) {
      // dangerouslyAllowBrowser: the key is the listener's own, typed into this page by them and kept
      // on their device; there is no server of ours it could be kept on instead.
      // referrerPolicy: the address of this page is nobody's business but the listener's.
      this._client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: this.timeoutMs, fetchOptions: { referrerPolicy: 'no-referrer' }, ...(this.baseURL ? { baseURL: this.baseURL } : {}) });
      this._clientKey = key;
    }
    return this._client;
  }

  /**
   * Puts one question to the model and speaks the reply as it arrives.
   * @param {object} o
   * @param {string} o.text what the listener said
   * @param {object} o.context Game._context()
   * @param {{ role: string, text: string }[]} [o.talk] earlier turns of this conversation
   * @param {(sentence: string) => void} o.say called with each sentence as soon as it is whole
   * @param {AbortSignal} [o.signal] aborted when the listener cuts the reply short
   * @returns {Promise<{ action?: string }>} action: something for the game to do (see ACTIONS)
   * @throws {AssistantError} with .spoken set to what the listener should be told
   */
  async ask ({ text, context, talk, say, signal }) {
    const key = this._key();
    if (!key) throw new AssistantError(SPOKEN.noKey);
    let Anthropic;
    try { Anthropic = await this._load(); } catch (e) { throw new AssistantError(SPOKEN.load, 'the assistant SDK did not load: ' + (e && e.message), e); }
    if (signal && signal.aborted) return {};
    const client = this._clientFor(Anthropic, key);
    const topics = this.topics ? this.topics.get() : undefined;
    const params = buildRequest({ model: this.model(), text, context, talk, topics });
    const out = new SpeechStream(say);
    const t0 = Date.now(); let firstAt = 0; let stalled = false; let timer = null; let over = false;
    const stream = client.messages.stream(params, signal ? { signal } : undefined);
    // Getting connected is the SDK's business (its timeout, one retry). Once the reply has begun, a
    // reply that goes quiet (a dead spot on the road) is given up on here.
    let lastAt = 0;
    const every = Math.min(1000, Math.max(40, this.stallMs / 3));
    const watch = () => {
      timer = setTimer(() => {
        if (over) return;
        if (lastAt && Date.now() - lastAt > this.stallMs) { stalled = true; stream.abort(); return; }
        watch();
      }, every);
    };
    const onAbort = () => stream.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('connect', () => { lastAt = Date.now(); });
    stream.on('streamEvent', () => { lastAt = Date.now(); });
    stream.on('text', delta => { if (!firstAt) firstAt = Date.now(); out.push(delta); });
    watch();
    let message;
    try {
      // With eager tool-input streaming, tool input that cannot be parsed at all rejects here too:
      // anything that is not an API error is treated as that.
      message = await stream.finalMessage();
    } catch (e) {
      if (signal && signal.aborted) return {};
      throw this._explain(Anthropic, e, stalled);
    } finally {
      over = true;
      if (timer) clearTimer(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal && signal.aborted) return {};
    out.end();
    const u = message.usage || {};
    this.last = { model: params.model, firstMs: firstAt ? firstAt - t0 : null, totalMs: Date.now() - t0, inputTokens: u.input_tokens, outputTokens: u.output_tokens, stop: message.stop_reason };
    this.log(`assistant: ${params.model}, first text after ${this.last.firstMs === null ? 'none' : this.last.firstMs + ' ms'}, finished after ${this.last.totalMs} ms; ${u.input_tokens} tokens in, ${u.output_tokens} out; stop reason ${message.stop_reason}`);

    // A refusal can cut a tool call off half-way, and so can running out of room: nothing is carried out then.
    if (message.stop_reason === 'refusal') { if (!out.count) say(SPOKEN.refused); return {}; }
    const result = {};
    const calls = message.stop_reason === 'max_tokens' ? [] : (message.content || []).filter(b => b.type === 'tool_use');
    let did = false; let unusable = false;
    for (const block of calls) {
      const call = readToolCall(block);
      if (!call) { unusable = true; this.log(`assistant: unusable ${block.name} call: ${JSON.stringify(block.input).slice(0, 200)}`); continue; }
      if (call.action) { if (!result.action) { result.action = call.action; this.log('assistant: asked the quiz to ' + call.action); } did = true; continue; }
      if (call.topics && this.topics) {
        const r = this.topics.set(call.topics);
        this.log(`assistant: topics ${JSON.stringify(call.topics)} -> ${r && r.ok ? 'set' : 'refused'}`);
        say(r && r.ok ? (r.on && r.on.length ? `Okay. From the next question: ${listOf(r.on)}.` : SPOKEN.topicsOff) : SPOKEN.topicsKept);
        did = true;
      }
    }
    if (!out.count && !did) say(unusable ? SPOKEN.garbled : SPOKEN.empty);
    return result;
  }

  /** Turns whatever went wrong into something that can be said aloud. Most specific first. */
  _explain (Anthropic, e, stalled) {
    const detail = (e && (e.message || String(e))) || 'unknown error';
    const is = name => typeof Anthropic[name] === 'function' && e instanceof Anthropic[name];
    let spoken;
    if (stalled) spoken = SPOKEN.slow;
    else if (is('APIUserAbortError')) spoken = SPOKEN.slow;
    else if (is('APIConnectionTimeoutError')) spoken = SPOKEN.slow;
    else if (is('APIConnectionError')) spoken = SPOKEN.reach;
    else if (is('AuthenticationError')) spoken = SPOKEN.auth;
    else if (is('PermissionDeniedError')) spoken = SPOKEN.permission;
    else if (is('NotFoundError')) spoken = SPOKEN.model;
    else if (is('RateLimitError')) spoken = SPOKEN.rate;
    else if (is('BadRequestError')) spoken = SPOKEN.request;
    else if (is('InternalServerError')) spoken = SPOKEN.server;
    // Anything else from the API, including an error that arrives part-way through a reply (which has
    // no status): told apart by the error's documented type. Unknown trouble is taken to be passing.
    else if (is('APIError')) spoken = SPOKEN[BY_TYPE[e.type]] || (e.status === 402 ? SPOKEN.billing : (e.status && e.status < 500 ? SPOKEN.request : SPOKEN.server));
    else spoken = SPOKEN.garbled; // not an API error: tool input that could not be read
    this.last = { model: this.model(), error: detail, status: e && e.status };
    return new AssistantError(spoken, detail, e);
  }
}

function listOf (names) {
  const n = (names || []).filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}
