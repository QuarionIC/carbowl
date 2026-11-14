import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_TREE, ALL_SUBCATEGORIES, ALL_ALTERNATES, DIFFICULTIES, defaultFilters, sanitizeFilters, buildParams, isValidQuestion, activeCategories, filterSignature, QuestionFeed, NoQuestionsError } from '../docs/js/qb.js';

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
  assert.ok(isValidQuestion({ category: 'Science', subcategory: 'Other Science', difficulty: 7 }, f), 'untagged questions pass');
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

test('feed: when everything has been heard, repeats are allowed rather than stalling', async () => {
  const tossups = fx('tossups-philosophy.json').tossups.slice(0, 3);
  const feed = new QuestionFeed({ fetchImpl: async () => respond({ tossups }) });
  feed.setFilters(defaultFilters());
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await feed.next('tossup'))._id);
  assert.equal(new Set(ids.slice(0, 3)).size, 3);
  assert.equal(ids.length, 7);
});
