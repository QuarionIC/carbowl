import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanForSpeech, chunkForSpeech, splitSentences, mainAnswer, isReaderNote, safeAnswerHtml, prepareTossup, prepareBonus, wordsOf } from '../docs/js/speechtext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const tossups = [...fx('tossups-philosophy.json').tossups, ...fx('tossups-mixed.json').tossups];
const bonuses = [...fx('bonuses-philosophy.json').bonuses, ...fx('bonuses-mixed.json').bonuses];

test('power mark is removed and its position recorded', () => {
  const { text, powerOffset } = cleanForSpeech('This thinker wrote of the unity of (*) apperception. For 10 points, name him.');
  assert.equal(text, 'This thinker wrote of the unity of apperception. For 10 points, name him.');
  assert.equal(text.slice(powerOffset), 'apperception. For 10 points, name him.');
});

test('no power mark gives -1', () => {
  assert.equal(cleanForSpeech('Name this thinker.').powerOffset, -1);
});

test('power mark at the very start or end', () => {
  assert.deepEqual(cleanForSpeech('(*) Name this thinker.'), { text: 'Name this thinker.', powerOffset: 0 });
  const end = cleanForSpeech('Name this thinker. (*)');
  assert.equal(end.text, 'Name this thinker.');
  assert.equal(end.powerOffset, end.text.length);
});

test('pronunciation guides are dropped, editorial brackets are kept', () => {
  const c = s => cleanForSpeech(s).text;
  assert.equal(c('Derek Parfit ("PAR-fit") wrote it.'), 'Derek Parfit wrote it.');
  assert.equal(c('Kierkegaard [KEER-kuh-gard] wrote it.'), 'Kierkegaard wrote it.');
  assert.equal(c('Cleanthes (klee-ANN-theez) led it.'), 'Cleanthes led it.');
  assert.equal(c('Mies van der Rohe ["meese van der roh"] built it.'), 'Mies van der Rohe built it.');
  assert.equal(c('Read this [emphasize] slowly [read slowly] please.'), 'Read this slowly please.');
  assert.equal(c('He said "restor[ing] the [this concept] matters."'), 'He said "restoring the this concept matters."');
  assert.equal(c('It was written (in 1781) by him.'), 'It was written (in 1781) by him.');
});

test('isReaderNote separates respellings from real asides', () => {
  for (const s of ['"PAR-fit"', 'KEER-kuh-gard', 'emphasize', 'read slowly', 'Note to moderator: skip this', '"mire"', '"nine four"']) assert.equal(isReaderNote(s), true, s);
  for (const s of ['in 1781', 'Symphony No. 1', 'this position', 'I think it had the weirdest scale on earth.', 'NATO']) assert.equal(isReaderNote(s), false, s);
  assert.equal(isReaderNote('shaw-krun', true), true);
  assert.equal(isReaderNote('well-known', false), false);
});

test('old abbreviations and symbols become speakable', () => {
  const c = s => cleanForSpeech(s).text;
  assert.equal(c('FTP, name this author.'), 'for 10 points, name this author.');
  assert.equal(c('FTPE, name these.'), 'for 10 points each, name these.');
  assert.equal(c('From 1900–1910 — really — he wrote.'), 'From 1900 to 1910, really, he wrote.');
  assert.equal(c('Sense & Sensibility'), 'Sense and Sensibility');
  assert.equal(c('[10e] Name this thinker.'), 'Name this thinker.');
  assert.equal(c('<b>Bold</b> &amp; <i>italic</i>&nbsp;text'), 'Bold and italic text');
});

test('sentences split at real boundaries only', () => {
  const s = t => splitSentences(t).map(x => x.text);
  assert.deepEqual(s('J. L. Austin wrote it. Dr. Smith agreed! Did W. V. O. Quine? Yes.'), ['J. L. Austin wrote it.', 'Dr. Smith agreed!', 'Did W. V. O. Quine?', 'Yes.']);
  assert.deepEqual(s('He called it "the end." Then he left.'), ['He called it "the end."', 'Then he left.']);
  assert.deepEqual(s('The U.S. Supreme Court ruled. It stood.'), ['The U.S. Supreme Court ruled.', 'It stood.']);
  assert.deepEqual(s('No terminator here'), ['No terminator here']);
  assert.deepEqual(s(''), []);
});

test('chunk offsets index into the cleaned text', () => {
  const text = 'First sentence here. Second one, which is rather longer, follows it. Third.';
  for (const c of chunkForSpeech(text)) assert.equal(text.slice(c.start, c.end), c.text);
});

test('long sentences are cut into balanced pieces at clause boundaries', () => {
  const long = 'That work by this thinker defines nature as the sum total of all objects of experience, and its 21st section provides three tables, the first of which, the logical table of judgments, categorizes its subject by quantity, quality, relation, and modality.';
  const chunks = chunkForSpeech(long, 240);
  assert.equal(chunks.length, 2);
  for (const c of chunks) { assert.ok(c.text.length <= 240); assert.ok(c.text.length >= 60, 'no dangling fragment: ' + c.text); assert.equal(long.slice(c.start, c.end), c.text); }
});

test('real questions: chunks reassemble, stay short, and carry no markup', () => {
  let n = 0;
  const texts = [...tossups.map(t => t.question_sanitized), ...bonuses.flatMap(b => [b.leadin_sanitized, ...b.parts_sanitized])];
  for (const raw of texts) {
    const { text, powerOffset } = cleanForSpeech(raw);
    assert.ok(text.length > 0, 'empty text for: ' + raw);
    assert.ok(!/[\u0001<>]/.test(text) || /[<>]/.test(raw.replace(/<[^>]*>/g, '')), 'markup left in: ' + text);
    assert.ok(!/\(\*\)/.test(text));
    assert.ok(powerOffset >= -1 && powerOffset <= text.length);
    const chunks = chunkForSpeech(text);
    assert.ok(chunks.length >= 1);
    let pos = 0;
    for (const c of chunks) {
      assert.equal(text.slice(c.start, c.end), c.text);
      assert.ok(c.start >= pos, 'chunks overlap');
      assert.equal(text.slice(pos, c.start).trim(), '', 'text lost between chunks');
      assert.ok(c.text.length <= 240, 'chunk too long: ' + c.text.length);
      pos = c.end; n++;
    }
    assert.equal(text.slice(pos).trim(), '', 'text lost after the last chunk');
  }
  assert.ok(n > 1000);
});

test('real tossups: power offset lands on a word start', () => {
  let withPower = 0;
  for (const t of tossups) {
    const p = prepareTossup(t);
    if (p.powerOffset < 0) continue;
    withPower++;
    assert.ok(p.powerOffset === 0 || p.powerOffset === p.text.length || p.text[p.powerOffset - 1] === ' ', `offset ${p.powerOffset} in "${p.text.slice(Math.max(0, p.powerOffset - 15), p.powerOffset + 15)}"`);
  }
  assert.ok(withPower > 50);
});

test('prepareBonus keeps parts aligned with answers', () => {
  for (const b of bonuses) {
    const p = prepareBonus(b);
    assert.equal(p.parts.length, b.answers_sanitized.length);
    for (const part of p.parts) assert.ok(part.chunks.length >= 1);
  }
});

test('mainAnswer gives the part worth saying', () => {
  assert.equal(mainAnswer('Critique of Pure Reason [or Kritik der reinen Vernunft; or Kant\'s First Critique]'), 'Critique of Pure Reason');
  assert.equal(mainAnswer('Alvin (Ira)  Goldman'), 'Alvin Goldman');
  assert.equal(mainAnswer('(first-order)  logic'), 'first-order logic');
  assert.equal(mainAnswer('Dao De Jing [accept Tao Te Ching] (The language is Chinese.)'), 'Dao De Jing');
  assert.equal(mainAnswer('[accept either] Sacco and Vanzetti'), 'Sacco and Vanzetti');
  assert.equal(mainAnswer('World War II (or the Second World War)'), 'World War II');
  assert.equal(mainAnswer('Dasein [da-ZEIN] [prompt on "existence"]'), 'Dasein');
  for (const t of tossups) assert.ok(mainAnswer(t.answer_sanitized).length > 0, t.answer_sanitized);
  for (const b of bonuses) for (const a of b.answers_sanitized) assert.ok(mainAnswer(a).length > 0, a);
});

test('safeAnswerHtml keeps emphasis marks and escapes everything else', () => {
  assert.equal(safeAnswerHtml('Soren <b><u>Kierkegaard</u></b> [or <i>x</i>]'), 'Soren <b><u>Kierkegaard</u></b> [or <i>x</i>]');
  assert.equal(safeAnswerHtml('<img src=x onerror=alert(1)><script>x</script> A & B'), '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;x&lt;/script&gt; A &amp; B');
  assert.equal(safeAnswerHtml('<b onclick="x">hi</b>'), '&lt;b onclick="x"&gt;hi</b>');
});

test('wordsOf normalises for echo comparison', () => {
  assert.deepEqual(wordsOf('Søren Kierkegaard’s "Either/Or"!'), ['soren', 'kierkegaards', 'either', 'or']);
});
