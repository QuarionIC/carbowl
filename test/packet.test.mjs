// Review shows a question the way its packet printed it (packet.js): the layout, where a buzz is
// marked in the printed text, what is kept of the printed text, and fetching it for older history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePacketHtml, printedHtml, buzzPoint, packetView, packetHtml, hasPacketText, packetSource, sourceFields, applyPacketSource } from '../docs/js/packet.js';
import { prepareTossup, prepareBonus } from '../docs/js/speechtext.js';
import { slimRecord, expandRecord } from '../docs/js/history.js';
import { fetchQuestionById, API_BASE } from '../docs/js/qb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const tossups = fixture('tossups-philosophy.json').tossups;
const bonuses = fixture('bonuses-philosophy.json').bonuses;
const mixed = fixture('bonuses-mixed.json').bonuses;

const strip = html => html.replace(/<[^>]*>/g, '');
const norm = w => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const lastWord = s => { const w = s.trim().split(/\s+/).map(norm).filter(Boolean); return w[w.length - 1] || ''; };

/** A history record as the game makes it for a tossup that was buzzed on at `buzzOffset`. */
function played (q, { buzzOffset = null, result = 'ten', points = 10 } = {}) {
  const prep = prepareTossup(q);
  return { id: q._id, type: 'tossup', q, text: prep.text, powerOffset: prep.powerOffset, answer: q.answer || q.answer_sanitized, answerText: 'x', result, points, heard: '', buzzOffset, at: 1000 };
}
function playedBonus (q, results = ['correct', 'wrong', null]) {
  const prep = prepareBonus(q);
  return { id: q._id, type: 'bonus', q, leadin: prep.leadin.text, parts: prep.parts.map((p, i) => ({ text: p.text, answer: (q.answers && q.answers[i]) || q.answers_sanitized[i], answerText: 'x', result: results[i], points: results[i] === 'correct' ? 10 : 0, heard: '' })), points: 10, at: 2000 };
}

test('question text from outside is made safe: only plain formatting survives, and nothing is left open', () => {
  assert.equal(safePacketHtml('<b>bold</b> <i>title</i> H<sub>2</sub>O x<sup>2</sup> <u>line</u>'), '<b>bold</b> <i>title</i> H<sub>2</sub>O x<sup>2</sup> <u>line</u>');
  assert.equal(safePacketHtml('<script>alert(1)</script><img src=x onerror=alert(1)>'), '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(safePacketHtml('<b onclick="x()">no</b>'), '&lt;b onclick="x()"&gt;no');
  assert.equal(safePacketHtml('a < b & c &amp; d &#8217;'), 'a &lt; b &amp; c &amp; d &#8217;');
  // A tag left open would make everything after it on the screen bold.
  assert.equal(safePacketHtml('<b>power (*) rest'), '<b>power (*) rest</b>');
  assert.equal(safePacketHtml('rest</b> of <i>it'), 'rest of <i>it</i>');
  assert.equal(safePacketHtml('<b><u>crossed</b></u> over'), '<b><u>crossed</u></b> over');
  assert.equal(safePacketHtml(null), '');
  // QBReader's copy has a stray space wherever the packet changed face before punctuation; the packet has none.
  assert.equal(printedHtml('scientific <b><u>method</u></b> [or scientific <b><u>methodology</u></b> ; accept <i>Against <b><u>Method</u></b></i> ; prompt on <u>science</u> ]'), 'scientific <b><u>method</u></b> [or scientific <b><u>methodology</u></b>; accept <i>Against <b><u>Method</u></b></i>; prompt on <u>science</u>]');
  assert.equal(printedHtml('the book <i>Novum Organum </i>. The  modern form , it says ...'), 'the book <i>Novum Organum</i>. The modern form, it says ...');
  assert.equal(printedHtml('in .NET and C# : no ; x < y ?'), 'in .NET and C#: no; x &lt; y?');
});

test('a tossup is laid out as its packet prints it', () => {
  const q = tossups[0];
  const v = packetView(played(q));
  assert.equal(v.buzz, '', 'no buzz to mark');
  assert.ok(v.html.startsWith('<div class="packet"><p class="p-head">2016 MYSTERIUM · Packet 2</p><p class="p-q">1. <b>This book accuses both Locke and Leibniz'), v.html.slice(0, 160));
  assert.ok(v.html.includes('begins with the unity of (*)</b> apperception.'), 'the power is bold up to its mark');
  assert.ok(v.html.includes('<p class="p-ans">ANSWER: <b><u>Critique of Pure Reason</u></b> [or <b><u>Kritik der reinen Vernunft</u></b>; or Kant’s <b><u>First Critique</u></b>]</p>'));
  assert.ok(v.html.endsWith('<p class="p-tag">&lt;Philosophy&gt;</p></div>'));
  // A packet named for its writers keeps the name beside its number; a science question carries both of its tags.
  const named = packetView(played({ ...q, packet: { name: 'Editors 2', number: 5 }, category: 'Science', subcategory: 'Other Science', alternate_subcategory: 'Math' })).html;
  assert.ok(named.includes('2016 MYSTERIUM · Packet 5 (Editors 2)') && named.endsWith('&lt;Other Science – Math&gt;</p></div>'));
  // The packet's number is said once, however QBReader names the packet.
  const headOf = packet => packetView(played({ ...q, packet })).html.match(/<p class="p-head">([^<]*)<\/p>/)[1];
  assert.equal(headOf({ name: '15 - Editors 1', number: 15 }), '2016 MYSTERIUM · Packet 15 (Editors 1)');
  assert.equal(headOf({ name: 'Packet 7', number: 7 }), '2016 MYSTERIUM · Packet 7');
  assert.equal(headOf({ name: '3', number: 3 }), '2016 MYSTERIUM · Packet 3');
  assert.equal(headOf({ name: 'GMU + Sheffield A + Chicago C', number: 8 }), '2016 MYSTERIUM · Packet 8 (GMU + Sheffield A + Chicago C)');
  assert.equal(headOf({ name: '12 Angry Editors', number: 1 }), '2016 MYSTERIUM · Packet 1 (12 Angry Editors)');
  assert.equal(headOf({ name: 'Finals', number: null }), '2016 MYSTERIUM · Finals');
  // Every fixture lays out without a stray or unclosed tag.
  for (const t of tossups) {
    const html = packetView(played(t)).html;
    const opened = (html.match(/<(b|u|i|em|strong|sub|sup)>/g) || []).length; const closed = (html.match(/<\/(b|u|i|em|strong|sub|sup)>/g) || []).length;
    assert.equal(opened, closed, t._id);
    assert.ok(!/<(?!\/?(?:div|p|b|u|i|em|strong|sub|sup|span)\b)/.test(html), 'no other tags: ' + t._id);
  }
});

test('the buzz is marked after the word that was being read, in the printed text', () => {
  const q = tossups[0]; const prep = prepareTossup(q);
  const at = prep.text.indexOf('schemata') + 3; // the buzz came in the middle of "schemata"
  const rec = played(q, { buzzOffset: at, result: 'power', points: 15 });
  const v = packetView(rec);
  assert.equal(v.buzz, 'good');
  const [before, after] = v.html.split(/<span class="p-buzz good"[^>]*><\/span>/);
  assert.ok(before.endsWith('It argues that we have to use “schemata”'), before.slice(-60));
  assert.ok(after.startsWith(' to perceive things'), after.slice(0, 40));
  assert.ok(packetHtml(rec).includes('where you buzzed (right)</p>'));
  // Wrong answers are marked in the other colour; a question nobody buzzed on has no mark at all.
  assert.equal(packetView(played(q, { buzzOffset: at, result: 'neg', points: -5 })).buzz, 'bad');
  assert.ok(packetHtml(played(q, { buzzOffset: at, result: 'neg', points: -5 })).includes('class="p-buzz bad"'));
  assert.equal(packetView(played(q, { buzzOffset: null, result: 'dead', points: 0 })).buzz, '');
  assert.ok(!packetHtml(played(q, { buzzOffset: null, result: 'dead', points: 0 })).includes('p-buzz'));
  assert.ok(!packetHtml(played(q, { buzzOffset: 40, result: 'skipped', points: 0 })).includes('p-buzz'));
  // Read to the end before the buzz: the mark stands after the last word.
  const end = packetView(played(q, { buzzOffset: prep.text.length, result: 'ten' })).html;
  assert.ok(/Immanuel Kant\.<span class="p-buzz good"[^>]*><\/span><\/p><p class="p-ans">/.test(end));
  // A buzz before anything was read: the mark stands before the first word, after the number.
  assert.ok(packetView(played(q, { buzzOffset: 0, result: 'neg' })).html.includes('<p class="p-q">1. <span class="p-buzz bad"'));
  assert.equal(buzzPoint('<b>One two</b> three', 'One two three', undefined), -1);
  assert.equal(buzzPoint('', 'One two three', 4), -1);
});

test('the mark follows the reading through every fixture, although what is read differs from what is printed', () => {
  let checks = 0; let agree = 0; let withGuides = 0;
  for (const q of tossups) {
    const prep = prepareTossup(q); const html = safePacketHtml(q.question);
    const spoken = [...prep.text.matchAll(/\S+/g)];
    if (strip(html).split(/\s+/).length !== spoken.length + (prep.powerOffset >= 0 ? 1 : 0)) withGuides++;
    let last = -1;
    for (let k = 0; k < spoken.length; k += 5) {
      const offset = spoken[k].index + 1; // while word k is being said
      const p = buzzPoint(html, prep.text, offset);
      assert.ok(p >= last, `the mark never moves back (${q._id}, word ${k})`);
      last = p;
      const want = norm(spoken[k][0]); if (!want) continue;
      checks++;
      if (lastWord(strip(html.slice(0, p))) === want) agree++;
    }
    // After the last word.
    assert.equal(buzzPoint(html, prep.text, prep.text.length), html.replace(/(<\/[a-z]+>)+$/, '').length);
  }
  assert.ok(withGuides >= 3, `some fixtures read differently from how they are printed (${withGuides})`);
  assert.ok(agree / checks > 0.97, `the mark stands after the word being read in ${agree} of ${checks} places`);
});

test('where the printed text was left out when read aloud, the mark stays on the right side of it', () => {
  const printed = 'This thinker, S&oslash;ren <i>Kierkegaard</i> (“KEER-kuh-gard”), wrote <i>Either/Or</i> &amp; argued that x<sup>2</sup> matters.';
  const q = { _id: 'x', question: printed, question_sanitized: 'This thinker, Søren Kierkegaard ("KEER-kuh-gard"), wrote Either/Or & argued that x^2 matters.', answer: '<b><u>K</u></b>', answer_sanitized: 'K' };
  const prep = prepareTossup(q);
  assert.equal(prep.text, 'This thinker, Søren Kierkegaard, wrote Either/Or and argued that x squared matters.');
  const html = safePacketHtml(printed);
  const cut = at => strip(html.slice(0, buzzPoint(html, prep.text, prep.text.indexOf(at) + 1)));
  assert.equal(cut('Kierkegaard'), 'This thinker, S&oslash;ren Kierkegaard', 'before the pronunciation guide, which was not read');
  assert.equal(cut('wrote'), 'This thinker, S&oslash;ren Kierkegaard (“KEER-kuh-gard”), wrote');
  assert.equal(cut('and argued'), 'This thinker, S&oslash;ren Kierkegaard (“KEER-kuh-gard”), wrote Either/Or', '"and" was printed as an ampersand, which is no word: the mark waits before it');
  assert.equal(cut('argued'), 'This thinker, S&oslash;ren Kierkegaard (“KEER-kuh-gard”), wrote Either/Or &amp; argued');
  assert.equal(cut('squared'), 'This thinker, S&oslash;ren Kierkegaard (“KEER-kuh-gard”), wrote Either/Or &amp; argued that x2', '"x squared" was printed as a power');
});

test('a bonus is laid out as lead-in, parts with their values, and an answer under each', () => {
  const plain = bonuses[0];
  const html = packetView(playedBonus(plain)).html;
  assert.ok(html.startsWith('<div class="packet"><p class="p-head">2021 WORKSHOP · Packet 5</p><p class="p-q">4. One of this thinker’s students, Heinrich Hotho'), html.slice(0, 140));
  assert.ok(html.includes('For 10 points each:</p><p class="p-q">[10] Name this German idealist thinker'));
  assert.ok(html.includes('<p class="p-ans">ANSWER: Georg Wilhelm Friedrich <b><u>Hegel</u></b></p><p class="p-q">[10] Hegel called this medium'));
  assert.ok(html.includes('<p class="p-ans">ANSWER: <b><u>spirit</u></b> [or <b><u>geiste</u></b>s]</p><p class="p-tag">&lt;Philosophy&gt;</p></div>'));
  assert.equal((html.match(/class="p-ans"/g) || []).length, 3);
  assert.ok(!html.includes('p-buzz'), 'a bonus has no buzz');
  // Newer sets say how hard each part is.
  const graded = [...bonuses, ...mixed].find(b => Array.isArray(b.difficultyModifiers) && b.difficultyModifiers.length === 3);
  const g = packetView(playedBonus(graded)).html;
  graded.difficultyModifiers.forEach(m => assert.ok(g.includes(`<p class="p-q">[10${m}] `), `[10${m}]`));
  // A value written into the part itself is not printed twice.
  const marked = packetView(playedBonus({ ...plain, parts: plain.parts.map(p => '[10] ' + p), parts_sanitized: plain.parts_sanitized.map(p => '[10] ' + p) })).html;
  assert.ok(!marked.includes('[10] [10]') && marked.includes('[10] Name this German idealist thinker'));
});

test('history keeps the printed text, and gives it back', () => {
  const live = played(tossups[0], { buzzOffset: 120, result: 'ten' });
  const slim = slimRecord(live, 500);
  assert.equal(slim.src.question, tossups[0].question);
  assert.deepEqual(slim.src.packet, { name: '02', number: 2 }); assert.equal(slim.src.number, 1); assert.equal(slim.src.year, 2016);
  assert.doesNotThrow(() => JSON.stringify(slim));
  const back = expandRecord(JSON.parse(JSON.stringify(slim)));
  assert.ok(hasPacketText(back));
  assert.equal(packetHtml(back), packetHtml(live), 'a question looks the same after a reload');
  assert.deepEqual(slimRecord(back, 500), slim, 'saving it again changes nothing');
  const b = playedBonus(bonuses[1]); const bs = slimRecord(b, 500);
  assert.deepEqual(bs.src.parts, bonuses[1].parts); assert.equal(bs.src.leadin, bonuses[1].leadin);
  const bb = expandRecord(JSON.parse(JSON.stringify(bs)));
  assert.equal(packetHtml(bb), packetHtml(b)); assert.deepEqual(slimRecord(bb, 500), bs);
  assert.deepEqual(sourceFields(packetSource(bonuses[1])).parts, bonuses[1].parts);
  assert.equal(packetSource({}), null); assert.equal(packetSource(null), null);
});

test('a question kept before the printed text was stored is shown from what was read, then completed from QBReader', async () => {
  const q = tossups[0]; const prep = prepareTossup(q);
  // As records were kept up to 0.3.4: no printed text, no number, no packet.
  const old = expandRecord({ key: '1000-' + q._id, session: 500, id: q._id, type: 'tossup', at: 1000, result: 'neg', points: -5, set: q.set.name, cat: 'Philosophy', sub: 'Philosophy', alt: '', difficulty: 7, text: prep.text, answer: q.answer, answerText: 'x', heard: 'hume', buzzOffset: prep.text.indexOf('schemata') + 2, powerOffset: prep.powerOffset });
  assert.equal(hasPacketText(old), false);
  const standIn = packetView(old);
  assert.ok(standIn.html.startsWith('<div class="packet"><p class="p-head">2016 MYSTERIUM</p><p class="p-q"><b>This book accuses both Locke'), 'no number or packet is known');
  assert.ok(standIn.html.includes('begins with the unity of (*)</b> apperception.'), 'the power is still marked, from where it was when read');
  assert.ok(/use &quot;schemata&quot;<span class="p-buzz bad"/.test(standIn.html), 'and so is the buzz');
  // What QBReader returns for the id fills in the rest.
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push([url, o]); return { status: 200, ok: true, json: async () => ({ tossup: q }) }; };
  const got = await fetchQuestionById('tossup', q._id, fetchImpl);
  assert.equal(calls[0][0], `${API_BASE}/tossup-by-id?id=${q._id}`);
  assert.equal(applyPacketSource(old, got), true);
  assert.ok(hasPacketText(old));
  const full = packetView(old).html;
  assert.ok(full.startsWith('<div class="packet"><p class="p-head">2016 MYSTERIUM · Packet 2</p><p class="p-q">1. <b>This book'));
  assert.ok(/use “schemata”<span class="p-buzz bad"/.test(full), 'the buzz is found again in the printed text');
  assert.equal(slimRecord(old, 500).src.question, q.question, 'and it is kept from then on');
  assert.equal(old.result, 'neg'); assert.equal(old.heard, 'hume');
  // A bonus is only completed by one with the same number of parts.
  const bo = expandRecord(slimRecord({ ...playedBonus(bonuses[0]), q: { set: { name: 'S' }, category: 'Philosophy', subcategory: 'Philosophy' } }, 1));
  assert.equal(hasPacketText(bo), false);
  assert.ok(packetView(bo).html.includes('<p class="p-q">[10] Name this German idealist thinker'), 'shown from what was read meanwhile');
  assert.equal(applyPacketSource(bo, { ...bonuses[0], parts: bonuses[0].parts.slice(0, 2) }), false);
  assert.equal(applyPacketSource(bo, bonuses[0]), true);
  assert.ok(packetView(bo).html.includes('<p class="p-q">4. One of this thinker’s students'));
  assert.equal(applyPacketSource(old, null), false);
});

test('fetching one question by id: gone means null, a broken service is an error, and nothing is asked for ids that are not QBReader\'s', async () => {
  let asked = 0;
  const answer = (status, body) => async () => { asked++; return { status, ok: status >= 200 && status < 300, json: async () => body }; };
  assert.equal(await fetchQuestionById('tossup', 't1', answer(200, {})), null); assert.equal(asked, 0, 'a test question is not looked up');
  assert.equal(await fetchQuestionById('bonus', '62f1b8aed2b97d3109c68386', answer(404, null)), null); assert.equal(asked, 1);
  assert.deepEqual(await fetchQuestionById('bonus', '62f1b8aed2b97d3109c68386', async url => { assert.equal(url, `${API_BASE}/bonus-by-id?id=62f1b8aed2b97d3109c68386`); return { status: 200, ok: true, json: async () => ({ bonus: { _id: 'b' } }) }; }), { _id: 'b' });
  assert.equal(await fetchQuestionById('tossup', '6302ccab3e73f93749c0dbca', answer(200, { bonus: {} })), null);
  await assert.rejects(fetchQuestionById('tossup', '6302ccab3e73f93749c0dbca', answer(503, null)), /HTTP 503/);
  await assert.rejects(fetchQuestionById('tossup', '6302ccab3e73f93749c0dbca', async () => { throw new TypeError('Failed to fetch'); }), /Failed to fetch/);
});
