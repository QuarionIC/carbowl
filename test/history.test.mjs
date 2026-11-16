import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore, MemoryBackend, slimRecord, expandRecord, groupSessions, resumableSession, scoreOf, missedLines, byCategory, RESUME_WINDOW_MS } from '../docs/js/history.js';

const tossup = (id, at, result, points, extra = {}) => ({ id, type: 'tossup', at, result, points, text: 'Question ' + id, answer: '<b><u>Answer ' + id + '</u></b>', answerText: 'Answer ' + id, heard: 'heard ' + id, buzzOffset: 12, powerOffset: 40, q: { set: { name: 'Set A' }, category: 'Philosophy', subcategory: 'Philosophy', difficulty: 8 }, ...extra });
const bonus = (id, at, results) => ({ id, type: 'bonus', at, result: null, points: results.filter(r => r === 'correct').length * 10, leadin: 'Lead ' + id, parts: results.map((r, i) => ({ text: `Part ${i}`, answer: `<u>P${i}</u>`, answerText: `P${i}`, result: r, points: r === 'correct' ? 10 : 0, heard: '' })), q: { set: { name: 'Set B' }, category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Math', difficulty: 7 } });

test('records are slimmed to plain data and expand back to what the review screen uses', () => {
  const live = tossup('t1', 1000, 'power', 15, { q: { set: { name: 'ACF' }, category: 'Philosophy', subcategory: 'Philosophy', difficulty: 9, question_sanitized: 'long text that is not kept' }, reading: { some: 'live object' } });
  const slim = slimRecord(live, 500);
  assert.equal(slim.key, '1000-t1'); assert.equal(slim.session, 500); assert.equal(slim.set, 'ACF'); assert.equal(slim.cat, 'Philosophy'); assert.equal(slim.difficulty, 9);
  assert.equal(slim.q, undefined); assert.equal(slim.reading, undefined);
  assert.doesNotThrow(() => JSON.stringify(slim));
  const back = expandRecord(slim);
  assert.equal(back.q.set.name, 'ACF'); assert.equal(back.q.category, 'Philosophy'); assert.equal(back.result, 'power'); assert.equal(back.buzzOffset, 12);
  const b = slimRecord(bonus('b1', 2000, ['correct', 'wrong', 'none']), 500);
  assert.equal(b.parts.length, 3); assert.equal(b.alt, 'Math'); assert.equal(b.points, 10);
  // Slimming an already slim record (as happens when a restored session is saved again) changes nothing.
  assert.deepEqual(slimRecord(expandRecord(slim), 500), slim);
  assert.deepEqual(slimRecord(expandRecord(b), 500), b);
});

test('store: saves, replaces after an overruled verdict, survives reopening, and clears', async () => {
  const backend = new MemoryBackend();
  const store = new HistoryStore({ backend });
  const a = tossup('t1', 1000, 'neg', -5); const b = bonus('b1', 2000, ['correct', 'wrong', 'none']);
  store.save(a, 900); store.save(b, 900);
  let all = await store.all();
  assert.deepEqual(all.map(r => r.id), ['t1', 'b1']);
  a.result = 'ten'; a.points = 10; a.overridden = true;
  await store.save(a, 900);
  all = await store.all();
  assert.equal(all.length, 2, 'the same question is replaced, not added twice');
  assert.equal(all[0].result, 'ten'); assert.equal(all[0].overridden, true);
  const again = new HistoryStore({ backend });
  assert.equal((await again.all()).length, 2);
  await store.save(tossup('t2', 9000, 'dead', 0), 8000);
  await store.removeSession(900);
  assert.deepEqual((await store.all()).map(r => r.id), ['t2']);
  await store.clear();
  assert.deepEqual(await store.all(), []);
});

test('store: a failing backend never throws into the quiz', async () => {
  const logs = [];
  const store = new HistoryStore({ backend: { open: async () => true, put: async () => { throw new Error('quota exceeded'); }, all: async () => { throw new Error('unreadable'); }, deleteWhere: async () => {}, clear: async () => {} }, log: m => logs.push(m) });
  await store.save(tossup('t1', 1, 'ten', 10), 1);
  assert.deepEqual(await store.all(), []);
  assert.ok(logs.some(l => /quota exceeded/.test(l)) && logs.some(l => /unreadable/.test(l)));
});

test('sessions: grouped newest first, scored, and only a recent one is carried on', () => {
  const recs = [slimRecord(tossup('a', 1000, 'power', 15), 900), slimRecord(bonus('b', 2000, ['correct', 'correct', 'wrong']), 900), slimRecord(tossup('c', 500000, 'neg', -5), 400000), slimRecord(tossup('d', 600000, 'skipped', 0), 400000)];
  const g = groupSessions(recs);
  assert.deepEqual(g.map(x => x.session), [400000, 900]);
  assert.equal(g[1].score.points, 35); assert.equal(g[1].score.tossups, 1); assert.equal(g[1].score.powers, 1); assert.equal(g[1].score.ppb, 20);
  assert.equal(g[0].score.tossups, 1, 'a skipped question is not counted'); assert.equal(g[0].score.negs, 1);
  assert.equal(resumableSession(recs, 600000 + 1000).session, 400000);
  assert.equal(resumableSession(recs, 600000 + RESUME_WINDOW_MS + 1), null, 'an old session is history, not something to carry on');
  assert.equal(resumableSession([], 1), null);
  assert.deepEqual(scoreOf([]), { tossups: 0, powers: 0, tens: 0, negs: 0, tossupPoints: 0, bonuses: 0, bonusPoints: 0, bonusParts: 0, bonusCorrect: 0, points: 0, ppb: 0 });
});

test('missed questions and the per-category tally', () => {
  const items = [slimRecord(tossup('a', 1, 'power', 15), 1), slimRecord(tossup('b', 2, 'neg', -5), 1), slimRecord(tossup('c', 3, 'dead', 0), 1), slimRecord(bonus('d', 4, ['correct', 'wrong', 'none']), 1)];
  const lines = missedLines(items);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('TOSSUP: Question b\nANSWER: Answer b'));
  assert.ok(lines[2].startsWith('BONUS PART: Part 1\nANSWER: P1'));
  const cats = byCategory(items);
  assert.deepEqual(cats, [{ cat: 'Philosophy', asked: 3, right: 1 }, { cat: 'Math', asked: 3, right: 1 }]);
});
