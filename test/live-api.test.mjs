// Talks to the real QBReader API. Skipped unless CARBOWL_LIVE=1 so that ordinary test runs stay offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionFeed, defaultFilters, isValidQuestion, NoQuestionsError, ALL_ALTERNATES } from '../docs/js/qb.js';
import { prepareTossup, prepareBonus, mainAnswer } from '../docs/js/speechtext.js';

const live = process.env.CARBOWL_LIVE === '1';

test('live: default filters give college-level philosophy tossups and three-part bonuses', { skip: !live }, async () => {
  const feed = new QuestionFeed({});
  feed.setFilters(defaultFilters());
  for (let i = 0; i < 6; i++) {
    const t = await feed.next('tossup');
    assert.equal(t.category, 'Philosophy'); assert.ok([7, 8, 9, 10].includes(t.difficulty), 'difficulty ' + t.difficulty);
    assert.ok(prepareTossup(t).chunks.length > 0); assert.ok(mainAnswer(t.answer_sanitized));
    const b = await feed.next('bonus');
    assert.equal(b.category, 'Philosophy'); assert.ok([7, 8, 9, 10].includes(b.difficulty));
    assert.equal(b.parts_sanitized.length, 3); assert.equal(prepareBonus(b).parts.length, 3);
  }
});

test('live: subcategory and alternate filters are honoured', { skip: !live }, async () => {
  const feed = new QuestionFeed({ batch: 30 });
  const filters = { ...defaultFilters(), subs: ['Other Science', 'Biology'], alts: ['Math', 'Computer Science'], difficulties: [3, 4, 5] };
  feed.setFilters(filters);
  const seen = { sub: new Set(), alt: new Set() };
  for (let i = 0; i < 25; i++) {
    const t = await feed.next('tossup');
    assert.ok(isValidQuestion(t, filters));
    assert.equal(t.category, 'Science'); assert.ok(['Other Science', 'Biology'].includes(t.subcategory), t.subcategory);
    assert.ok(!t.alternate_subcategory || ['Math', 'Computer Science'].includes(t.alternate_subcategory), String(t.alternate_subcategory));
    assert.ok([3, 4, 5].includes(t.difficulty));
    seen.sub.add(t.subcategory); if (t.alternate_subcategory) seen.alt.add(t.alternate_subcategory);
  }
  assert.ok(seen.sub.size >= 1);
});

test('live: every category can be fetched on its own', { skip: !live }, async () => {
  const { CATEGORY_TREE } = await import('../docs/js/qb.js');
  for (const c of CATEGORY_TREE) {
    const feed = new QuestionFeed({ batch: 5 });
    feed.setFilters({ ...defaultFilters(), subs: c.subs.slice(), alts: ALL_ALTERNATES.slice(), difficulties: [] });
    const t = await feed.next('tossup');
    assert.equal(t.category, c.name);
  }
});

test('live: impossible filters report no questions instead of hanging', { skip: !live }, async () => {
  const feed = new QuestionFeed({});
  feed.setFilters({ ...defaultFilters(), subs: ['Philosophy'], difficulties: [1], minYear: 2000, maxYear: 2000 });
  await assert.rejects(() => feed.next('tossup', { maxAttempts: 2 }), e => e instanceof NoQuestionsError);
});

test('live: one question can be fetched again by its id, with the text as its packet printed it', { skip: !live }, async () => {
  const { fetchQuestionById } = await import('../docs/js/qb.js');
  const { packetView, applyPacketSource, hasPacketText } = await import('../docs/js/packet.js');
  const feed = new QuestionFeed({});
  feed.setFilters(defaultFilters());
  for (const type of ['tossup', 'bonus']) {
    const q = await feed.next(type);
    const again = await fetchQuestionById(type, q._id);
    assert.equal(again._id, q._id);
    assert.deepEqual(type === 'tossup' ? again.question : again.parts, type === 'tossup' ? q.question : q.parts);
    assert.ok(again.set && again.set.name && again.packet && Number.isFinite(again.number), 'it says which set, packet and number it was');
    // A record kept without the printed text is completed by it.
    const rec = type === 'tossup'
      ? { id: q._id, type, text: prepareTossup(q).text, powerOffset: prepareTossup(q).powerOffset, answer: q.answer, result: 'ten', points: 10, buzzOffset: 60, q: { set: { name: q.set.name } } }
      : { id: q._id, type, leadin: prepareBonus(q).leadin.text, parts: prepareBonus(q).parts.map((p, i) => ({ text: p.text, answer: q.answers[i], result: 'correct', points: 10 })), points: 30, q: { set: { name: q.set.name } } };
    assert.equal(hasPacketText(rec), false);
    assert.equal(applyPacketSource(rec, again), true);
    assert.ok(packetView(rec).html.includes(`<p class="p-q">${again.number}. `));
  }
  assert.equal(await fetchQuestionById('tossup', '000000000000000000000000'), null, 'an id QBReader does not have');
});
