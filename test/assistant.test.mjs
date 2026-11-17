// The assistant: turning streamed text into sentences for the voice, what the model is told about
// the quiz, the request each model is sent, and the whole path through Anthropic's SDK (the very
// bundle the site ships) against a stand-in for the API that enforces the documented request rules.
// No network and no key: what a real model says, and how fast, is not tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Assistant, AssistantError, SpeechStream, replyForSpeech, describeQuiz, buildRequest, readToolCall, ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, ASSISTANT_PHRASES, TOOLS, SYSTEM } from '../docs/js/assistant.js';
import { startMock, validate, KEYS, lastUserText } from '../tools/mock-anthropic.mjs';

const sdk = () => import('../docs/vendor/anthropic-sdk.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FINISHED = {
  state: 'between', asked: 2,
  score: { points: 25, tossups: 2, powers: 1, tens: 1, negs: 0, bonuses: 0, ppb: 0 },
  current: { type: 'tossup', category: 'Philosophy', subcategory: 'Philosophy', set: '2021 ACF Regionals', difficulty: 'Regular College', live: false, question: 'This thinker was woken from his dogmatic slumber by David Hume. For 10 points, name this author of the Critique of Pure Reason.', answer: 'Immanuel Kant', heard: 'immanuel kant', result: 'power', points: 15 },
  earlier: [
    { type: 'tossup', question: 'This philosopher wrote On Liberty.', answer: 'John Stuart Mill', heard: 'mill', result: 'ten', points: 10 },
    { type: 'tossup', question: 'This thinker was woken from his dogmatic slumber by David Hume. For 10 points, name this author of the Critique of Pure Reason.', answer: 'Immanuel Kant', heard: 'immanuel kant', result: 'power', points: 15 }
  ]
};
const LIVE = {
  state: 'reading', asked: 1,
  score: { points: 10, tossups: 1, powers: 0, tens: 1, negs: 0, bonuses: 0, ppb: 0 },
  current: { type: 'tossup', category: 'Philosophy', subcategory: 'Philosophy', set: '2021 ACF Regionals', difficulty: 'Regular College', live: true, readSoFar: 'This thinker was woken from his dogmatic slumber by David Hume.' },
  earlier: [{ type: 'tossup', question: 'This philosopher wrote On Liberty.', answer: 'John Stuart Mill', heard: 'mill', result: 'ten', points: 10 }]
};
const TOPICS = { on: ['Philosophy'], off: ['Math', 'Computer Science'] };

function feed (text, sizes) {
  const out = []; const s = new SpeechStream(t => out.push(t));
  let i = 0; let k = 0;
  while (i < text.length) { const n = sizes[k++ % sizes.length]; s.push(text.slice(i, i + n)); i += n; }
  s.end();
  return out;
}

// ---- text as it streams in -> sentences for the voice ------------------------------------------

test('speech stream: whole sentences in order, however the text is cut into pieces', () => {
  const text = 'David Hume was a Scottish philosopher. He argued that causation is habit. Kant said Hume woke him.';
  const want = ['David Hume was a Scottish philosopher.', 'He argued that causation is habit.', 'Kant said Hume woke him.'];
  assert.deepEqual(feed(text, [1000]), want);
  assert.deepEqual(feed(text, [1]), want);
  assert.deepEqual(feed(text, [7]), want);
  assert.deepEqual(feed(text, [3, 11, 2, 40]), want);
});

test('speech stream: a sentence goes out as soon as the next one has begun, not when the reply ends', () => {
  const out = []; const s = new SpeechStream(t => out.push(t));
  s.push('David Hume was a Scottish philosopher.');
  assert.deepEqual(out, [], 'not yet known to be whole');
  s.push(' He');
  assert.deepEqual(out, ['David Hume was a Scottish philosopher.']);
  s.push(' argued a lot');
  assert.equal(out.length, 1);
  s.end();
  assert.deepEqual(out, ['David Hume was a Scottish philosopher.', 'He argued a lot']);
  assert.equal(s.count, 2);
  assert.equal(s.text, 'David Hume was a Scottish philosopher. He argued a lot');
});

test('speech stream: scraps are joined to what follows; initials and abbreviations do not end a sentence', () => {
  assert.deepEqual(feed('Yes. He was born in Edinburgh in 1711. That is all.', [5]), ['Yes. He was born in Edinburgh in 1711.', 'That is all.']);
  assert.deepEqual(feed('No.', [1]), ['No.']);
  assert.deepEqual(feed('J. L. Austin wrote How to Do Things with Words. Dr. Johnson kicked a stone.', [4]), ['J. L. Austin wrote How to Do Things with Words.', 'Dr. Johnson kicked a stone.']);
});

test('speech stream: marks of written text are not read out; notation is said as words', () => {
  const md = '**Sure.** Here are two points:\n\n- The first one, with `code`.\n- The second one, where x^2 + y^2 = r^2.\n';
  for (const sizes of [[1000], [1], [6], [13]]) {
    const out = feed(md, sizes);
    const all = out.join(' ');
    assert.equal(/[*`#_]|\n|(^|\s)-\s/.test(all), false, `no marks left (pieces of ${sizes[0]}): ${JSON.stringify(out)}`);
    assert.match(all, /^Sure\. Here are two points: The first one, with code\. The second one, where x squared plus y squared equals r squared\.$/);
  }
  assert.equal(replyForSpeech('See [the SEP entry](https://plato.stanford.edu/entries/hume/) for *more*.'), 'See the SEP entry for more.');
  assert.equal(replyForSpeech('## Heading\nC++ is not C#.'), 'Heading C plus plus is not C sharp.');
  assert.deepEqual(feed('   \n\n ... \n', [2]), [], 'nothing but space and dots is nothing to say');
});

test('speech stream: a very long sentence is handed over in parts the voice can manage', () => {
  const long = 'Hume held that ' + Array.from({ length: 30 }, (_, i) => `impression number ${i + 1} gives rise to an idea`).join(', and ') + '.';
  const out = feed(long, [9]);
  assert.ok(out.length > 3);
  assert.ok(out.every(p => p.length <= 240), 'no part over 240 characters');
  assert.equal(out.join(' ').replace(/\s+/g, ' '), long);
});

// ---- what the model is told ------------------------------------------------------------------

test('quiz state: a question in play is described without its answer; a finished one with everything', () => {
  const live = describeQuiz(LIVE, TOPICS);
  assert.match(live, /QUESTION IN PLAY \(its answer is withheld from you\): tossup, Philosophy, from 2021 ACF Regionals, Regular College level\./);
  assert.match(live, /Read aloud so far: "This thinker was woken from his dogmatic slumber by David Hume\."/);
  assert.match(live, /Topics switched on: Philosophy\. Switched off: Math, Computer Science\./);
  assert.match(live, /EARLIER QUESTIONS, oldest first:\n1\. Tossup\. Text: "This philosopher wrote On Liberty\."\nAnswer line: "John Stuart Mill"\nThe listener answered "mill": correct \(10 points\)\./);
  assert.equal(live.includes('Kant'), false);

  const done = describeQuiz(FINISHED, TOPICS);
  assert.match(done, /THE QUESTION JUST FINISHED: tossup/);
  assert.match(done, /Answer line: "Immanuel Kant"\nThe listener answered "immanuel kant": correct, for power \(15 points\)\./);
  assert.match(done, /Score so far: 25 points \(tossups: 2 right of 2 heard, 1 for power\)\./);
  assert.equal(done.match(/Critique of Pure Reason/g).length, 1, 'the question just finished is not repeated among the earlier ones');
  assert.match(done, /1\. Tossup\. Text: "This philosopher wrote On Liberty\."/);

  assert.match(describeQuiz({ state: 'idle', score: {}, asked: 0, earlier: [] }), /No questions have been scored yet\.\n\nNo question has been read yet\./);
});

test('quiz state: a bonus shows the parts answered and keeps back the part in play', () => {
  const bonus = { state: 'waiting', score: { points: 10, tossups: 0, bonuses: 0 }, asked: 0, earlier: [], current: { type: 'bonus', category: 'Philosophy', subcategory: 'Philosophy', set: 'Set', difficulty: 'Regular College', live: true, leadin: 'Answer the following about colour:', partsAnswered: [{ question: 'Name this work by Hume.', answer: 'An Enquiry Concerning Human Understanding', heard: 'the enquiry', result: 'correct' }], partInPlay: { number: 2, readSoFar: 'This philosopher used grue' } } };
  const text = describeQuiz(bonus);
  assert.match(text, /QUESTION IN PLAY \(its answer is withheld from you\): bonus/);
  assert.match(text, /Lead-in: "Answer the following about colour:"/);
  assert.match(text, /Part 1: "Name this work by Hume\." Answer line: "An Enquiry Concerning Human Understanding" The listener answered "the enquiry": correct\./);
  assert.match(text, /Part 2 is in play\. Read aloud so far: "This philosopher used grue"/);
  assert.equal(text.includes('Topics switched'), false, 'no topics line when the app offers no topic switches');
});

test('request: each model gets the settings its documentation asks for, and passes the documented rules', () => {
  const headers = { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' };
  for (const m of ASSISTANT_MODELS) {
    const r = buildRequest({ model: m.id, text: 'who was hume', context: LIVE, talk: [], topics: TOPICS });
    assert.equal(r.model, m.id);
    assert.deepEqual(r.output_config, { effort: 'low' });
    assert.equal(validate(headers, { ...r, stream: true }), null, `${m.id}: acceptable`);
    for (const p of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.equal(p in r, false, `${p} is not sent`);
  }
  const opus = buildRequest({ model: 'claude-opus-5-5', text: 'x', context: LIVE });
  assert.equal('thinking' in opus, false, 'Opus 5.5 always thinks: no thinking setting is sent');
  assert.deepEqual(buildRequest({ model: 'claude-haiku-5-5', text: 'x', context: LIVE }).thinking, { type: 'disabled' });
  assert.equal('thinking' in buildRequest({ model: 'claude-sonnet-5-5', text: 'x', context: LIVE }), false);
  assert.equal(buildRequest({ model: 'no-such-model', text: 'x', context: LIVE }).model, DEFAULT_ASSISTANT_MODEL);
  assert.equal(DEFAULT_ASSISTANT_MODEL, 'claude-opus-5-5');
  // The stand-in really does refuse what the documentation says is refused.
  assert.match(validate(headers, { ...opus, thinking: { type: 'disabled' } }).body.error.message, /not supported for this model/);
  assert.match(validate(headers, { ...opus, tool_choice: { type: 'any' } }).body.error.message, /tool_choice/);
  assert.equal(validate(headers, { ...opus, temperature: 0 }).status, 400);
});

test('request: earlier turns go back as plain text; the newest turn carries the quiz state and what was said', () => {
  const talk = [{ role: 'assistant', text: 'stray' }, { role: 'user', text: 'who was hume' }, { role: 'assistant', text: 'A Scottish philosopher.' }, { role: 'user', text: 'skip it' }, { role: 'assistant', text: '   ' }];
  const r = buildRequest({ model: 'claude-opus-5-5', text: 'and "kant"?', context: FINISHED, talk, topics: TOPICS });
  assert.deepEqual(r.messages.slice(0, -1), [{ role: 'user', content: 'who was hume' }, { role: 'assistant', content: 'A Scottish philosopher.' }, { role: 'user', content: 'skip it' }]);
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, 2);
  assert.match(last.content[0].text, /^<quiz_state>\n[\s\S]*\n<\/quiz_state>$/);
  assert.equal(last.content[1].text, 'The listener said (as heard by speech recognition): "and "kant"?"');
  assert.equal(r.system, SYSTEM);
  assert.deepEqual(r.tools.map(t => t.name), ['quiz_action', 'set_topics']);
  assert.deepEqual(buildRequest({ model: 'claude-opus-5-5', text: 'x', context: LIVE }).tools.map(t => t.name), ['quiz_action'], 'no topic tool without topic switches');
  assert.ok(TOOLS.every(t => t.eager_input_streaming === true && t.input_schema.additionalProperties === false));
  // The same question twice gives the same bytes: nothing in a request depends on the clock.
  assert.equal(JSON.stringify(buildRequest({ model: 'claude-opus-5-5', text: 'x', context: LIVE, topics: TOPICS })), JSON.stringify(buildRequest({ model: 'claude-opus-5-5', text: 'x', context: LIVE, topics: TOPICS })));
});

test('tool calls are checked before anything is done with them', () => {
  assert.deepEqual(readToolCall({ name: 'quiz_action', input: { action: 'skip_question' } }), { action: 'skip' });
  assert.deepEqual(readToolCall({ name: 'quiz_action', input: { action: 'go_back_a_sentence' } }), { action: 'back' });
  assert.deepEqual(readToolCall({ name: 'quiz_action', input: { action: 'mark_correct' } }), { action: 'mark_right' });
  assert.deepEqual(readToolCall({ name: 'set_topics', input: { philosophy: false, math: true, computer_science: true } }), { topics: { philosophy: false, math: true, cs: true } });
  for (const bad of [{ name: 'quiz_action', input: { action: 'delete_everything' } }, { name: 'quiz_action', input: {} }, { name: 'quiz_action', input: { action: 'toString' } }, { name: 'quiz_action', input: null }, { name: 'quiz_action', input: 'skip_question' }, { name: 'set_topics', input: { philosophy: true, math: 'yes', computer_science: false } }, { name: 'set_topics', input: { math: true } }, { name: 'other_tool', input: { action: 'skip_question' } }, null]) {
    assert.equal(readToolCall(bad), null, JSON.stringify(bad));
  }
});

// ---- the whole path: assistant -> Anthropic's SDK (the bundle the site ships) -> stand-in API ----

function world ({ reply, key = 'test-key', model = 'claude-opus-5-5', topics, stallMs, timeoutMs } = {}) {
  return startMock(reply ? { reply } : {}).then(mock => {
    const logs = []; const set = [];
    const topicHooks = topics === null ? undefined : { get: () => TOPICS, set: t => { set.push(t); const on = [t.philosophy && 'Philosophy', t.math && 'Math', t.cs && 'Computer Science'].filter(Boolean); return on.length ? { ok: true, on } : { ok: false, on: TOPICS.on }; } };
    const a = new Assistant({ key: () => key, model: () => model, sdk, baseURL: mock.url, log: l => logs.push(l), topics: topicHooks, ...(stallMs ? { stallMs } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
    const said = [];
    const ask = (text, o = {}) => a.ask({ text, context: FINISHED, talk: [], say: s => said.push(s), ...o });
    return { mock, a, said, logs, set, ask, close: () => mock.close() };
  });
}
const failure = async p => { try { await p; } catch (e) { return e; } assert.fail('expected the request to fail'); };

test('assistant: the reply is spoken sentence by sentence while it is still arriving', async () => {
  const text = 'David Hume was a Scottish philosopher of the eighteenth century. He argued that causation is only habit. Kant said that Hume woke him from his dogmatic slumber.';
  const w = await world({ reply: () => ({ thinking: true, text, chunkChars: 6, chunkMs: 8 }) });
  try {
    const at = []; const t0 = Date.now();
    const r = await w.a.ask({ text: 'who was david hume', context: FINISHED, talk: [], say: s => { at.push(Date.now() - t0); w.said.push(s); } });
    const total = Date.now() - t0;
    assert.deepEqual(r, {});
    assert.deepEqual(w.said, ['David Hume was a Scottish philosopher of the eighteenth century.', 'He argued that causation is only habit.', 'Kant said that Hume woke him from his dogmatic slumber.']);
    assert.ok(at[0] < total - 80, `the first sentence was handed over ${total - at[0]} ms before the reply ended`);
    assert.ok(at[0] <= at[1] && at[1] <= at[2]);
    const req = w.mock.requests[0];
    assert.equal(w.mock.requests.length, 1, 'one request per question');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.ok(req.headers['anthropic-version']);
    assert.match(lastUserText(req.body), /The listener said \(as heard by speech recognition\): "who was david hume"/);
    assert.match(lastUserText(req.body), /Answer line: "Immanuel Kant"/);
    assert.equal(w.a.last.model, 'claude-opus-5-5'); assert.equal(w.a.last.stop, 'end_turn');
    assert.ok(w.a.last.firstMs >= 0 && w.a.last.totalMs >= w.a.last.firstMs && w.a.last.inputTokens > 0);
    assert.ok(w.logs.some(l => /first text after \d+ ms, finished after \d+ ms; \d+ tokens in, \d+ out; stop reason end_turn/.test(l)));
    assert.equal(w.logs.join('\n').includes('test-key'), false, 'the key is never written to the log');
  } finally { await w.close(); }
});

test('assistant: every model on offer gets through, and the conversation so far is sent along', async () => {
  for (const m of ASSISTANT_MODELS) {
    const w = await world({ model: m.id });
    try {
      await w.ask('and who was kant', { talk: [{ role: 'user', text: 'who was hume' }, { role: 'assistant', text: 'A Scottish philosopher.' }] });
      assert.ok(w.said.length >= 1, m.id);
      const body = w.mock.requests[0].body;
      assert.equal(body.model, m.id);
      assert.deepEqual(body.messages.slice(0, 2), [{ role: 'user', content: 'who was hume' }, { role: 'assistant', content: 'A Scottish philosopher.' }]);
      assert.deepEqual(body.thinking, m.id === 'claude-haiku-5-5' ? { type: 'disabled' } : undefined);
    } finally { await w.close(); }
  }
});

test('assistant: what the model asks the quiz to do comes back as an action, with nothing made up to say', async () => {
  const w = await world({ reply: body => /skip/.test(lastUserText(body).split('The listener said').pop()) ? { thinking: true, tools: [{ name: 'quiz_action', input: { action: 'skip_question' } }] } : { text: 'Reading it again.', tools: [{ name: 'quiz_action', input: { action: 'repeat_question' } }, { name: 'quiz_action', input: { action: 'skip_question' } }] } });
  try {
    assert.deepEqual(await w.ask('skip this one please'), { action: 'skip' });
    assert.deepEqual(w.said, []);
    assert.deepEqual(await w.ask('read it again'), { action: 'repeat' }, 'the first of several actions is the one taken');
    assert.deepEqual(w.said, ['Reading it again.']);
    assert.ok(w.logs.some(l => /asked the quiz to skip/.test(l)));
  } finally { await w.close(); }
});

test('assistant: "switch to math" sets the topics through the app and confirms aloud', async () => {
  let input = { philosophy: false, math: true, computer_science: true };
  const w = await world({ reply: () => ({ tools: [{ name: 'set_topics', input }] }) });
  try {
    assert.deepEqual(await w.ask('math and computer science instead'), {});
    assert.deepEqual(w.set, [{ philosophy: false, math: true, cs: true }]);
    assert.deepEqual(w.said, ['Okay. From the next question: Math and Computer Science.']);
    input = { philosophy: false, math: false, computer_science: false };
    w.said.length = 0;
    await w.ask('turn everything off');
    assert.deepEqual(w.said, [ASSISTANT_PHRASES.topicsKept]);
    assert.ok(w.mock.requests[0].body.tools.some(t => t.name === 'set_topics'));
  } finally { await w.close(); }
  const none = await world({ topics: null, reply: () => ({ text: 'Okay.' }) });
  try { await none.ask('hello there'); assert.deepEqual(none.mock.requests[0].body.tools.map(t => t.name), ['quiz_action']); } finally { await none.close(); }
});

test('assistant: tool input that cannot be used is not acted on', async () => {
  for (const tools of [[{ name: 'quiz_action', input: { action: 'format_the_phone' } }], [{ name: 'set_topics', input: { math: true } }], [{ name: 'quiz_action', rawJson: '{"action": "skip_que' }], [{ name: 'quiz_action', rawJson: 'not json at all' }]]) {
    const w = await world({ reply: () => ({ tools }) });
    try {
      let r = {}; let err = null;
      try { r = await w.ask('do something odd'); } catch (e) { err = e; }
      assert.equal(r.action, undefined, 'nothing is done: ' + JSON.stringify(tools));
      assert.deepEqual(w.set, []);
      const heard = err ? [err.spoken] : w.said;
      assert.deepEqual(heard, [ASSISTANT_PHRASES.garbled], JSON.stringify(tools));
      if (err) assert.ok(err instanceof AssistantError);
    } finally { await w.close(); }
  }
  // Cut off for lack of room: the tool call may be half-written, so it is not carried out.
  const cut = await world({ reply: () => ({ text: 'Skipping.', tools: [{ name: 'quiz_action', input: { action: 'skip_question' } }], stop_reason: 'max_tokens' }) });
  try { assert.deepEqual(await cut.ask('skip'), {}); assert.deepEqual(cut.said, ['Skipping.']); } finally { await cut.close(); }
});

test('assistant: a refusal or an empty reply still gets the listener an answer', async () => {
  const refused = await world({ reply: () => ({ stop_reason: 'refusal', tools: [{ name: 'quiz_action', input: { action: 'skip_question' } }] }) });
  try { assert.deepEqual(await refused.ask('something'), {}); assert.deepEqual(refused.said, [ASSISTANT_PHRASES.refused]); } finally { await refused.close(); }
  const empty = await world({ reply: () => ({ thinking: true, text: '' }) });
  try { assert.deepEqual(await empty.ask('something'), {}); assert.deepEqual(empty.said, [ASSISTANT_PHRASES.empty]); } finally { await empty.close(); }
});

test('assistant: each kind of failure is put into words the listener can act on', async () => {
  const cases = [
    [{ key: KEYS.bad }, ASSISTANT_PHRASES.auth, 401],
    [{ key: KEYS.forbidden }, ASSISTANT_PHRASES.permission, 403],
    [{ key: KEYS.broke }, ASSISTANT_PHRASES.billing, 402],
    [{ key: KEYS.limited }, ASSISTANT_PHRASES.rate, 429],
    [{ key: KEYS.overloaded }, ASSISTANT_PHRASES.server, 529],
    [{ reply: () => ({ error: 'not_found_error', status: 404, message: 'model: claude-opus-5-5' }) }, ASSISTANT_PHRASES.model, 404],
    [{ reply: () => ({ error: 'invalid_request_error', status: 400, message: 'messages: something was wrong' }) }, ASSISTANT_PHRASES.request, 400],
    [{ reply: () => ({ error: 'api_error', status: 500, message: 'Internal server error' }) }, ASSISTANT_PHRASES.server, 500]
  ];
  for (const [opts, spoken, status] of cases) {
    const w = await world(opts);
    try {
      const e = await failure(w.ask('who was hume'));
      assert.ok(e instanceof AssistantError, `${status}: ${e}`);
      assert.equal(e.spoken, spoken, `${status}: ${e.message}`);
      assert.equal(w.a.last.status, status);
      assert.deepEqual(w.said, []);
      assert.equal(String(e.message).includes(opts.key || 'test-key'), false, 'the key is not in the error');
      // Passing trouble is tried once more; a refusal that will not change is not.
      assert.equal(w.mock.requests.length, status === 429 || status >= 500 ? 2 : 1, `${status}: ${w.mock.requests.length} request(s)`);
    } finally { await w.close(); }
  }
});

test('assistant: no key, no connection, or no SDK are each said plainly', async () => {
  const w = await world({ key: '' });
  try {
    assert.equal(w.a.available(), false);
    assert.equal((await failure(w.ask('hello'))).spoken, ASSISTANT_PHRASES.noKey);
    assert.equal(w.mock.requests.length, 0);
  } finally { await w.close(); }
  const gone = await world();
  await gone.close(); // nothing is listening at that address any more
  const e = await failure(gone.ask('hello'));
  assert.equal(e.spoken, ASSISTANT_PHRASES.reach, e.message);
  let loads = 0;
  const broken = new Assistant({ key: () => 'test-key', model: () => 'claude-opus-5-5', sdk: async () => { loads++; throw new Error('offline'); } });
  assert.equal(broken.available(), true);
  assert.equal((await failure(broken.ask({ text: 'x', context: LIVE, say () {} }))).spoken, ASSISTANT_PHRASES.load);
  assert.equal((await failure(broken.ask({ text: 'x', context: LIVE, say () {} }))).spoken, ASSISTANT_PHRASES.load);
  assert.equal(loads, 2, 'a failed load is tried again next time');
});

test('assistant: a reply that breaks off or goes quiet is given up on, after saying what had arrived', async () => {
  const text = 'David Hume was a Scottish philosopher. He argued that causation is only habit. Kant said that Hume woke him.';
  const broke = await world({ reply: () => ({ text, chunkChars: 8, failAfter: 60 }) });
  try {
    const e = await failure(broke.ask('who was hume'));
    assert.equal(e.spoken, ASSISTANT_PHRASES.server, e.message);
    assert.deepEqual(broke.said, ['David Hume was a Scottish philosopher.']);
  } finally { await broke.close(); }
  const quiet = await world({ stallMs: 200, reply: () => ({ text, chunkChars: 8, stallAfter: 60, stallMs: 5000 }) });
  try {
    const t0 = Date.now();
    const e = await failure(quiet.ask('who was hume'));
    assert.equal(e.spoken, ASSISTANT_PHRASES.slow, e.message);
    assert.ok(Date.now() - t0 < 2000, `gave up after ${Date.now() - t0} ms`);
    assert.deepEqual(quiet.said, ['David Hume was a Scottish philosopher.']);
  } finally { await quiet.close(); }
});

test('assistant: when the listener cuts the reply short the request is dropped at once and nothing more is said', async () => {
  const text = 'David Hume was a Scottish philosopher. He argued that causation is only habit. Kant said that Hume woke him. And so on for a long time.';
  const w = await world({ reply: () => ({ text, chunkChars: 4, chunkMs: 25 }) });
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = w.ask('who was hume', { signal: ac.signal });
    while (!w.said.length && Date.now() - t0 < 3000) await sleep(10);
    assert.equal(w.said.length, 1, 'cut short after the first sentence');
    ac.abort();
    const cutAt = Date.now();
    assert.deepEqual(await p, {});
    assert.ok(Date.now() - cutAt < 300, `returned ${Date.now() - cutAt} ms after the cut`);
    await sleep(150);
    assert.equal(w.said.length, 1);
    // Already cut short before it began: no request is made at all.
    const before = w.mock.requests.length;
    const done = new AbortController(); done.abort();
    assert.deepEqual(await w.ask('again', { signal: done.signal }), {});
    assert.equal(w.mock.requests.length, before);
  } finally { await w.close(); }
});
