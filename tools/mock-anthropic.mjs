// A stand-in for Anthropic's Messages API, for tests and for trying the assistant locally without
// a real key. It speaks the documented streaming format (server-sent events) and enforces the
// request rules of the models Carbowl offers as Anthropic's documentation states them, so that a
// request the real API would reject is rejected here too. It is NOT the real API: what a model
// would actually say, and how fast, cannot be learned from it.
//
//   node tools/mock-anthropic.mjs [--port 8392]        (keys: any text; see KEYS below for special ones)
//
// In tests: const mock = await startMock({ reply }); ... await mock.close();
import http from 'node:http';

// Special keys, for trying error handling by hand.
export const KEYS = { bad: 'bad-key', broke: 'no-credit-key', limited: 'rate-limit-key', overloaded: 'overloaded-key', forbidden: 'forbidden-key' };

const MODELS = {
  'claude-opus-5-5': { thinking: ['adaptive'], forcedTools: false },
  'claude-sonnet-5-5': { thinking: ['adaptive', 'between_tools'], forcedTools: false },
  'claude-haiku-5-5': { thinking: ['adaptive', 'disabled'], forcedTools: true }
};

const apiError = (status, type, message) => ({ status, body: { type: 'error', error: { type, message }, request_id: 'req_mock' } });

/** The request rules, as documented. Returns an error to send, or null when the request is acceptable. */
export function validate (headers, body) {
  const key = headers['x-api-key'] || String(headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key) return apiError(401, 'authentication_error', 'x-api-key header is required');
  if (key === KEYS.bad) return apiError(401, 'authentication_error', 'invalid x-api-key');
  if (key === KEYS.forbidden) return apiError(403, 'permission_error', 'This key may not use this model.');
  if (key === KEYS.broke) return apiError(402, 'billing_error', 'Your credit balance is too low.');
  if (key === KEYS.limited) return apiError(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit.');
  if (key === KEYS.overloaded) return apiError(529, 'overloaded_error', 'Overloaded');
  if (!headers['anthropic-version']) return apiError(400, 'invalid_request_error', 'anthropic-version header is required');
  if (!body || typeof body !== 'object') return apiError(400, 'invalid_request_error', 'The request body is not valid JSON.');
  const m = MODELS[body.model];
  if (!body.model) return apiError(400, 'invalid_request_error', 'model: Field required');
  if (!m) return apiError(404, 'not_found_error', `model: ${body.model}`);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return apiError(400, 'invalid_request_error', 'max_tokens: Field required');
  if (!Array.isArray(body.messages) || !body.messages.length) return apiError(400, 'invalid_request_error', 'messages: at least one message is required');
  if (body.messages[0].role !== 'user') return apiError(400, 'invalid_request_error', 'messages: first message must use the "user" role');
  if (body.messages[body.messages.length - 1].role !== 'user') return apiError(400, 'invalid_request_error', 'This model does not support assistant message prefill. The conversation must end with a user message.');
  for (const [i, msg] of body.messages.entries()) {
    if (msg.role !== 'user' && msg.role !== 'assistant') return apiError(400, 'invalid_request_error', `messages.${i}.role: unexpected value`);
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content;
    if (!Array.isArray(blocks) || !blocks.length) return apiError(400, 'invalid_request_error', `messages.${i}.content: must not be empty`);
    for (const [k, b] of blocks.entries()) if (b.type === 'text' && !String(b.text || '').trim()) return apiError(400, 'invalid_request_error', `messages.${i}.content.${k}: text content blocks must be non-empty`);
  }
  for (const p of ['temperature', 'top_p', 'top_k']) if (body[p] !== undefined) return apiError(400, 'invalid_request_error', `${p}: sampling parameters are not supported for this model`);
  const effort = body.output_config && body.output_config.effort;
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return apiError(400, 'invalid_request_error', 'output_config.effort: unexpected value');
  if (body.thinking !== undefined) {
    const type = body.thinking && body.thinking.type;
    if (!m.thinking.includes(type)) return apiError(400, 'invalid_request_error', `"thinking.type.${type}" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`);
    if ((type === 'disabled' || type === 'between_tools') && (effort === 'xhigh' || effort === 'max')) return apiError(400, 'invalid_request_error', `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`);
  }
  const choice = body.tool_choice && body.tool_choice.type;
  if ((choice === 'any' || choice === 'tool') && !m.forcedTools) return apiError(400, 'invalid_request_error', 'tool_choice: type "tool" and "any" are not supported for this model.');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return apiError(400, 'invalid_request_error', 'tools: must be a list');
    for (const [i, t] of body.tools.entries()) {
      if (!t || !/^[a-zA-Z0-9_-]{1,128}$/.test(t.name || '')) return apiError(400, 'invalid_request_error', `tools.${i}.name: invalid`);
      if (!t.input_schema || t.input_schema.type !== 'object') return apiError(400, 'invalid_request_error', `tools.${i}.input_schema.type: must be "object"`);
    }
  }
  return null;
}

/** The newest thing the user said, whatever shape the content has. */
export function lastUserText (body) {
  const last = body.messages[body.messages.length - 1];
  return typeof last.content === 'string' ? last.content : last.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/**
 * What the stand-in "model" says when no script is given: canned answers picked by keyword, enough
 * to try each path of the app by hand.
 */
export function defaultReply (body) {
  const all = lastUserText(body);
  const said = (all.match(/The listener said[^:]*: "([^"]*)"/) || [null, all])[1].toLowerCase();
  const thinking = !(body.thinking && body.thinking.type === 'disabled');
  const act = action => ({ thinking, tools: [{ name: 'quiz_action', input: { action } }] });
  if (/\bskip\b|next one/.test(said)) return act('skip_question');
  if (/from the (start|top|beginning)|whole question again/.test(said)) return act('repeat_question');
  if (/last (sentence|bit)|just said/.test(said)) return act('go_back_a_sentence');
  if (/slow/.test(said)) return act('read_slower');
  if (/count that|i was right|mark (it|that) (right|correct)/.test(said)) return act('mark_correct');
  if (/\b(math|computer science|philosophy)\b.*\b(only|instead|switch|add|too|as well)\b|\b(switch|change) to\b/.test(said)) {
    const on = k => new RegExp(k).test(said);
    const only = /only|instead|switch to|change to/.test(said);
    const now = (all.match(/Topics switched on: ([^.]*)\./) || [null, ''])[1].toLowerCase();
    const keep = k => !only && now.includes(k);
    return { thinking, tools: [{ name: 'set_topics', input: { philosophy: on('philosophy') || keep('philosophy'), math: on('math') || keep('math'), computer_science: on('computer science') || keep('computer science') } }] };
  }
  if (/hume/.test(said)) return { thinking, text: 'David Hume was a Scottish philosopher of the eighteenth century. He argued that our idea of cause and effect comes from habit, not from reason. Kant said that reading Hume woke him from his dogmatic slumber.' };
  if (/answer/.test(said) && /QUESTION IN PLAY/.test(all)) return { thinking, text: 'That would be telling. Say skip if you want to hear the answer.' };
  if (/why/.test(said)) return { thinking, text: 'Because the clues all point one way. The last clue names the work he is best known for.' };
  if (/markdown/.test(said)) return { thinking, text: '**Sure.** Here are two points:\n\n- The first one, with `code`.\n- The second one, where x^2 + y^2 = r^2.\n' };
  if (/refuse/.test(said)) return { thinking: false, stop_reason: 'refusal' };
  if (/nothing/.test(said)) return { thinking, text: '' };
  return { thinking, text: `You asked: ${said}. This is the stand-in assistant, so that is all I can say.` };
}

function sse (res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Sends a reply as a stream of events, in the documented order and shapes. */
async function streamReply (res, body, r, alive) {
  const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 0 };
  sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  sse(res, 'ping', { type: 'ping' });
  let index = 0;
  if (r.thinking) {
    // Thinking as it comes back by default on these models: no readable text, a signature only.
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    await wait(r.thinkMs === undefined ? 30 : r.thinkMs);
    if (!alive()) return;
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock-signature' } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++; usage.output_tokens += 20;
  }
  if (r.text) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    const size = r.chunkChars || 7;
    for (let i = 0; i < r.text.length; i += size) {
      if (!alive()) return;
      if (r.stallAfter !== undefined && i >= r.stallAfter) { await wait(r.stallMs || 60000); return; }
      if (r.failAfter !== undefined && i >= r.failAfter) { sse(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }); res.end(); return; }
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: r.text.slice(i, i + size) } });
      usage.output_tokens += 2;
      if (r.chunkMs) await wait(r.chunkMs);
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }
  for (const t of r.tools || []) {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_mock_${index}`, name: t.name, input: {} } });
    const json = t.rawJson !== undefined ? t.rawJson : JSON.stringify(t.input);
    for (let i = 0; i < json.length; i += 9) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 9) } });
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++; usage.output_tokens += 15;
  }
  const stop = r.stop_reason || ((r.tools || []).length ? 'tool_use' : 'end_turn');
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'mock refusal' } } : {}) }, usage: { output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * @param {object} [o]
 * @param {number} [o.port] 0 picks a free one
 * @param {(body: object, headers: object) => object} [o.reply] what to answer: { text, thinking, tools: [{ name, input | rawJson }],
 *   stop_reason, chunkMs, chunkChars, thinkMs, delayMs, stallAfter, failAfter, status, error }
 * @returns {Promise<{ url: string, port: number, requests: object[], preflights: object[], close: () => Promise<void> }>}
 */
export function startMock ({ port = 0, reply = defaultReply, log = () => {} } = {}) {
  const requests = []; const preflights = [];
  const open = new Set();
  const server = http.createServer((req, res) => {
    open.add(res); res.on('close', () => open.delete(res));
    // A browser on another origin asks first whether it may send these headers.
    const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-expose-headers': 'request-id' };
    if (req.method === 'OPTIONS') {
      preflights.push({ url: req.url, asked: req.headers['access-control-request-headers'] || '' });
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*', 'access-control-max-age': '600' });
      res.end(); return;
    }
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && path === '/__requests') {
      // For tests in a browser: what arrived (header names only: values may hold a key).
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ requests: requests.map(r => ({ headerNames: Object.keys(r.headers), body: r.body })), preflights })); return;
    }
    if (req.method !== 'POST' || path !== '/v1/messages') {
      res.writeHead(req.method === 'GET' && path === '/' ? 200 : 404, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
      res.end(path === '/' ? 'Carbowl stand-in for the Anthropic Messages API (tests only). POST /v1/messages.' : 'not found'); return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', d => { raw += d; });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (e) { /* reported by validate */ }
      requests.push({ headers: req.headers, body });
      const send = ({ status, body: b }) => { res.writeHead(status, { ...cors, 'content-type': 'application/json', 'request-id': 'req_mock', ...(status === 429 || status === 529 ? { 'retry-after': '0' } : {}) }); res.end(JSON.stringify(b)); };
      const bad = validate(req.headers, body);
      if (bad) { log(`${bad.status} ${bad.body.error.type}: ${bad.body.error.message}`); send(bad); return; }
      let r;
      try { r = (await reply(body, req.headers)) || {}; } catch (e) { send(apiError(500, 'api_error', 'mock reply failed: ' + e.message)); return; }
      if (r.error) { send(apiError(r.status || 500, r.error, r.message || r.error)); return; }
      if (r.delayMs) await wait(r.delayMs);
      if (res.destroyed) return;
      log(`200 ${body.model} ${body.stream ? 'stream' : 'whole'}: ${(r.text || '').slice(0, 50)}${(r.tools || []).map(t => ' [' + t.name + ']').join('')}`);
      if (!body.stream) {
        const content = [];
        if (r.text) content.push({ type: 'text', text: r.text });
        for (const [i, t] of (r.tools || []).entries()) content.push({ type: 'tool_use', id: 'toolu_mock_' + i, name: t.name, input: t.input });
        res.writeHead(200, { ...cors, 'content-type': 'application/json', 'request-id': 'req_mock' });
        res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content, stop_reason: r.stop_reason || (content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
        return;
      }
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
      try { await streamReply(res, body, r, () => !res.destroyed && !res.writableEnded); } catch (e) { if (!res.writableEnded) res.end(); }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        url: `http://127.0.0.1:${p}`, port: p, requests, preflights,
        close: () => new Promise(done => { for (const r of open) r.destroy(); server.close(() => done()); })
      });
    });
  });
}

// Run directly: serve until stopped.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const i = process.argv.indexOf('--port');
  const mock = await startMock({ port: i > 0 ? Number(process.argv[i + 1]) : 8392, log: line => console.log(line) });
  console.log(`Stand-in Anthropic API (tests only): ${mock.url}`);
}
