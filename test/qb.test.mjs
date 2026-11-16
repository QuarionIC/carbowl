import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_TREE, ALL_SUBCATEGORIES, ALL_ALTERNATES, DIFFICULTIES, defaultFilters, sanitizeFilters, buildParams, isValidQuestion, activeCategories, filterSignature, QuestionFeed, NoQuestionsError, QUICK_TOPICS, topicOn, setTopic } from '../docs/js/qb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const params = (f, n = 10, extra) => Object.fromEntries(buildParams(f, n, extra));
const memoryStore = () => { const m = new Map(); return { get: (k, d) => m.has(k) ? JSON.parse(m.get(k)) : d, set: (k, v) => m.set(k, JSON.stringify(v)), m }; };
const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('category tree matches QBReader: 12 categories, 31 subcategories, 25 alternate subcategories, 11 difficulties', () => {
  assert.equal(CATEGORY_TREE.length, 12); assert.equal(ALL_SUBCATEGORIES.length, 31); assert.equal(ALL_ALTERNATES.length, 25); assert.equal(DIFFICULTIES.length, 11);
  assert.equal(new Set(ALL_SUBCATEGORIES).size, 31); assert.equal(new Set(ALL_ALTERNATES).size, 25);
  assert.deepEqual(DIFFICULTIES.map(d => d.value), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(DIFFICULTIES.find(d => d.value === 7).dots, 2, 'medium college is the two-dot level');
});

test('defaults: philosophy only, medium college and harder', () => {
  const f = defaultFilters();
  assert.deepEqual(f.subs, ['Philosophy']); assert.deepEqual(f.difficulties, [7, 8, 9, 10]);
  assert.deepEqual(params(f), { difficulties: '7,8,9,10', categories: 'Philosophy', subcategories: 'Philosophy', minYear: '2010', maxYear: '2026', number: '10' });
});

test('query building follows the ticked subcategories and alternates', () => {
  const f = { ...defaultFilters(), subs: ['Philosophy', 'Biology', 'Other Science'], alts: ['Math', 'Poetry'] };
  const p = params(f, 5, { threePartBonuses: true });
  assert.equal(p.categories, 'Science,Philosophy'); assert.equal(p.subcategories, 'Biology,Other Science,Philosophy');
  assert.equal(p.alternateSubcategories, 'Math', 'alternates of categories that are off are not sent');
  assert.equal(p.number, '5'); assert.equal(p.threePartBonuses, 'true');
  assert.equal(params({ ...f, difficulties: [] }).difficulties, undefined, 'no difficulty ticked means any');
  assert.deepEqual(activeCategories(f).map(c => c.name), ['Science', 'Philosophy']);
});

test('stored filters are repaired', () => {
  assert.deepEqual(sanitizeFilters(null), defaultFilters());
  const f = sanitizeFilters({ subs: ['Philosophy', 'Nonsense'], alts: 'x', difficulties: [7, 99, '8'], minYear: 2020, maxYear: 2012 });
  assert.deepEqual(f.subs, ['Philosophy']); assert.deepEqual(f.difficulties, [7]); assert.equal(f.alts.length, 25);
  assert.equal(f.minYear, 2012); assert.equal(f.maxYear, 2020);
});

test('client-side validity mirrors QBReader', () => {
  const f = { ...defaultFilters(), subs: ['Philosophy', 'Other Science'], alts: ['Math'], difficulties: [7] };
  assert.ok(isValidQuestion({ category: 'Philosophy', subcategory: 'Philosophy', difficulty: 7 }, f));
  assert.ok(isValidQuestion({ category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Math', difficulty: 7 }, f));
  // QBReader lets a question with no alternate tag through; with the alternates narrowed to Math
  // that would bring in untagged astronomy, so it is turned away unless tagged questions run out.
  assert.ok(!isValidQuestion({ category: 'Science', subcategory: 'Other Science', difficulty: 7 }, f), 'untagged is turned away when narrowed');
  assert.ok(isValidQuestion({ category: 'Science', subcategory: 'Other Science', difficulty: 7 }, f, { allowUntagged: true }));
  assert.ok(isValidQuestion({ category: 'Science', subcategory: 'Other Science', difficulty: 7 }, { ...f, alts: ALL_ALTERNATES.slice() }), 'untagged passes when nothing is narrowed');
  assert.ok(!isValidQuestion({ category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Astronomy', difficulty: 7 }, f));
  assert.ok(!isValidQuestion({ category: 'Science', subcategory: 'Biology', difficulty: 7 }, f));
  assert.ok(!isValidQuestion({ category: 'History', subcategory: 'World History', difficulty: 7 }, f));
  assert.ok(!isValidQuestion({ category: 'Philosophy', subcategory: 'Philosophy', difficulty: 3 }, f));
  assert.notEqual(filterSignature(f), filterSignature(defaultFilters()));
});

test('feed: buffers, never repeats, refills, and persists', async () => {
  const tossups = fx('tossups-philosophy.json').tossups;
  let calls = 0; const urls = [];
  const fetchImpl = async url => { urls.push(url); const start = (calls++ * 10) % tossups.length; return respond({ tossups: tossups.slice(start, start + 10) }); };
  const store = memoryStore();
  const feed = new QuestionFeed({ fetchImpl, store });
  feed.setFilters(defaultFilters());
  const seen = new Set();
  for (let i = 0; i < 25; i++) { const q = await feed.next('tossup'); assert.equal(q.type, 'tossup'); assert.ok(!seen.has(q._id), 'repeat ' + q._id); seen.add(q._id); }
  assert.ok(urls[0].startsWith('https://www.qbreader.org/api/random-tossup?')); assert.ok(urls[0].includes('categories=Philosophy'));
  assert.ok(calls >= 3 && calls <= 6, 'calls ' + calls);
  await feed.prefetch('tossup');
  // A new session with the same store does not replay what was heard and keeps the buffered questions.
  const again = new QuestionFeed({ fetchImpl, store });
  again.setFilters(defaultFilters());
  assert.ok(again.buffered('tossup') > 0, 'buffer restored');
  const q = await again.next('tossup');
  assert.ok(!seen.has(q._id));
});

test('feed: bonuses ask for three parts; unusable and off-filter questions are dropped', async () => {
  const bonuses = fx('bonuses-philosophy.json').bonuses;
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return respond({ bonuses: [{ _id: 'bad1' }, { ...bonuses[0], category: 'History', subcategory: 'World History' }, { ...bonuses[1], parts_sanitized: ['only one'] }, bonuses[2], bonuses[3]] }); };
  const feed = new QuestionFeed({ fetchImpl });
  feed.setFilters(defaultFilters());
  const q = await feed.next('bonus');
  assert.equal(q._id, bonuses[2]._id); assert.equal(q.type, 'bonus');
  assert.ok(urls[0].includes('random-bonus') && urls[0].includes('threePartBonuses=true'));
});

test('feed: network trouble is retried and reported once; nothing matching is an error', async () => {
  const tossups = fx('tossups-philosophy.json').tossups;
  let n = 0; let waits = 0;
  const flaky = async () => { n++; if (n <= 2) throw new TypeError('Failed to fetch'); return respond({ tossups: tossups.slice(0, 5) }); };
  const feed = new QuestionFeed({ fetchImpl: flaky });
  feed.setFilters(defaultFilters());
  const q = await feed.next('tossup', { onWaiting: () => waits++ });
  assert.ok(q._id); assert.equal(waits, 1); assert.equal(n, 3);
  const none = new QuestionFeed({ fetchImpl: async () => respond({ tossups: [] }, 404) });
  none.setFilters(defaultFilters());
  await assert.rejects(() => none.next('tossup'), e => e instanceof NoQuestionsError);
});

test('feed: changing filters discards the old buffer and ignores late replies', async () => {
  const tossups = fx('tossups-philosophy.json').tossups; const mixed = fx('tossups-mixed.json').tossups.filter(t => t.category === 'History');
  let release;
  const slow = url => new Promise(resolve => { release = () => resolve(respond({ tossups: tossups.slice(0, 10) })); });
  const feed = new QuestionFeed({ fetchImpl: slow });
  feed.setFilters(defaultFilters());
  const pending = feed.prefetch('tossup');
  feed.fetch = async () => respond({ tossups: mixed });
  feed.setFilters({ ...defaultFilters(), subs: ['World History', 'American History', 'European History', 'Ancient History', 'Other History'], difficulties: [] });
  release(); await pending;
  assert.equal(feed.buffered('tossup'), 0, 'the late philosophy batch was ignored');
  const q = await feed.next('tossup');
  assert.equal(q.category, 'History');
});

test('quick topics: Math and Computer Science switch on and off without dragging in the rest of Other Science', () => {
  const [phil, math, cs] = QUICK_TOPICS;
  let f = defaultFilters();
  assert.ok(topicOn(f, phil)); assert.ok(!topicOn(f, math)); assert.ok(!topicOn(f, cs));
  f = setTopic(f, math, true);
  assert.ok(topicOn(f, math)); assert.ok(!topicOn(f, cs), 'Math alone does not switch Computer Science on');
  assert.deepEqual(params(f).alternateSubcategories, 'Math');
  assert.equal(params(f).categories, 'Science,Philosophy'); assert.equal(params(f).subcategories, 'Other Science,Philosophy');
  f = setTopic(f, cs, true);
  assert.ok(topicOn(f, math) && topicOn(f, cs)); assert.equal(params(f).alternateSubcategories, 'Math,Computer Science');
  assert.ok(isValidQuestion({ category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Computer Science', difficulty: 8 }, f));
  assert.ok(!isValidQuestion({ category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Astronomy', difficulty: 8 }, f));
  assert.ok(!isValidQuestion({ category: 'Science', subcategory: 'Physics', difficulty: 8 }, f));
  f = setTopic(f, math, false);
  assert.ok(!topicOn(f, math) && topicOn(f, cs));
  f = setTopic(f, cs, false);
  assert.ok(!f.subs.includes('Other Science'), 'the subcategory goes when its last topic goes');
  assert.deepEqual(params(f), params(defaultFilters()), 'back to where it started');
  // Other categories' alternates are never touched.
  assert.equal(f.alts.filter(a => ['Drama', 'Poetry', 'Film', 'Economics'].includes(a)).length, 4);
  f = setTopic(f, phil, false);
  assert.ok(!topicOn(f, phil)); assert.deepEqual(f.subs, []);
  // A listener who ticked all of Other Science in Settings sees both switches on, and can take one out.
  let g = { ...defaultFilters(), subs: ['Philosophy', 'Other Science'] };
  assert.ok(topicOn(g, math) && topicOn(g, cs));
  g = setTopic(g, math, false);
  assert.ok(!topicOn(g, math) && topicOn(g, cs)); assert.ok(g.alts.includes('Astronomy'));
});

test('feed: a narrowed topic turns untagged questions away, until only untagged ones are left', async () => {
  const mk = (id, alt) => ({ _id: id, category: 'Science', subcategory: 'Other Science', ...(alt ? { alternate_subcategory: alt } : {}), difficulty: 8, question_sanitized: 'Q ' + id, answer_sanitized: 'A ' + id });
  const f = setTopic({ ...defaultFilters(), subs: [] }, QUICK_TOPICS[1], true);
  const tagged = new QuestionFeed({ fetchImpl: async () => respond({ tossups: [mk('u1'), mk('m1', 'Math'), mk('a1', 'Astronomy'), mk('u2')] }) });
  tagged.setFilters(f);
  assert.equal((await tagged.next('tossup'))._id, 'm1');
  const logs = [];
  const bare = new QuestionFeed({ fetchImpl: async () => respond({ tossups: [mk('u1'), mk('a1', 'Astronomy'), mk('u2')] }), log: m => logs.push(m) });
  bare.setFilters(f);
  const q = await bare.next('tossup');
  assert.equal(q._id, 'u1', 'untagged questions are used rather than stalling');
  assert.ok(logs.some(l => /untagged/.test(l)));
});

test('feed: when everything has been heard, repeats are allowed rather than stalling', async () => {
  const tossups = fx('tossups-philosophy.json').tossups.slice(0, 3);
  const feed = new QuestionFeed({ fetchImpl: async () => respond({ tossups }) });
  feed.setFilters(defaultFilters());
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await feed.next('tossup'))._id);
  assert.equal(new Set(ids.slice(0, 3)).size, 3);
  assert.equal(ids.length, 7);
});
