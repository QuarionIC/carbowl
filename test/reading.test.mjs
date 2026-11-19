// What the voice model is handed (reading.js) against what is shown. Each group of cases is one
// that was heard to come out wrong as written and right as rewritten (README, "What the reader is
// given to say"), or a guard against a rewrite going where it must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakable, cardinalWords, ordinalWords, romanValue, alignment, placeInWritten, placeInSaid } from '../docs/js/reading.js';
import { cleanForSpeech, chunkForSpeech, mainAnswer, isReaderNote, echoOfBefore } from '../docs/js/speechtext.js';
import { isEcho } from '../docs/js/intent.js';
import { Narrator } from '../docs/js/narrator.js';
import { PHRASES } from '../docs/js/game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const say = (written, said) => assert.equal(speakable(written), said, written);
const same = written => assert.equal(speakable(written), written, written);

test('numbers in words', () => {
  assert.equal(cardinalWords(0), 'zero');
  assert.equal(cardinalWords(14), 'fourteen');
  assert.equal(cardinalWords(40), 'forty');
  assert.equal(cardinalWords(1514), 'one thousand five hundred fourteen');
  assert.equal(cardinalWords(784000), 'seven hundred eighty-four thousand');
  assert.equal(cardinalWords(1000000), 'one million');
  assert.equal(cardinalWords(2000003), 'two million three');
  assert.equal(cardinalWords(1028), 'one thousand twenty-eight');
  assert.equal(ordinalWords(1), 'first');
  assert.equal(ordinalWords(12), 'twelfth');
  assert.equal(ordinalWords(20), 'twentieth');
  assert.equal(ordinalWords(23), 'twenty-third');
  assert.equal(ordinalWords(39), 'thirty-ninth');
  assert.deepEqual(['I', 'IV', 'IX', 'XIV', 'XXIII', 'XXXIX'].map(romanValue), [1, 4, 9, 14, 23, 39]);
  assert.deepEqual(['', 'IIII', 'VV', 'IXI', 'XL', 'MIX', 'XXXX', 'iv'].map(romanValue), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a ruler\'s number is said as "the Nth"', () => {
  say('The Commonwealth was ruled by Wladyslaw IV, a member of this royal house.', 'The Commonwealth was ruled by Wladyslaw the fourth, a member of this royal house.');
  say('Its member Sigismund III was overthrown by Charles IX.', 'Its member Sigismund the third was overthrown by Charles the ninth.');
  say('Louis XIV built Versailles, and Louis XVI was executed.', 'Louis the fourteenth built Versailles, and Louis the sixteenth was executed.');
  say('Pope John XXIII opened it.', 'Pope John the twenty-third opened it.');
  say('Valentinian III\'s sister Honoria', 'Valentinian the third\'s sister Honoria');
  say('Queen Elizabeth II and Pope John Paul II met.', 'Queen Elizabeth the second and Pope John Paul the second met.');
  say('Henry V defeated the French, and Leo X excommunicated Luther.', 'Henry the fifth defeated the French, and Leo the tenth excommunicated Luther.');
  // A name this list does not know, but which goes on "of <place>": a person all the same.
  say('He married Zenobia II of Palmyra.', 'He married Zenobia the second of Palmyra.');
  // A lone "I" only where it cannot be the pronoun.
  say('the son of John I, who ruled Portugal', 'the son of John the first, who ruled Portugal');
  say('Charles I\'s execution and Elizabeth I.', 'Charles the first\'s execution and Elizabeth the first.');
  same('John I founded this country\'s Aviz dynasty.');
});

test('a numbered thing is said as a plain number', () => {
  say('World War I ended in 1918.', 'World War one ended in 1918.');
  say('He did intelligence work in World War II.', 'He did intelligence work in World War two.');
  say('Act III of this play follows Act IV of another.', 'Act three of this play follows Act four of another.');
  say('Photosystem II passes electrons to photosystem I.', 'Photosystem two passes electrons to photosystem one.');
  say('Henry IV, Part II', 'Henry the fourth, Part two');
  say('Title IX and Vatican II', 'Title nine and Vatican two');
  say('type II diabetes and stage IV cancer', 'type two diabetes and stage four cancer');
  say('It reacts with iron(III) oxide and copper(II) sulfate.', 'It reacts with iron three oxide and copper two sulfate.');
  say('the XVIII Dynasty and the II Corps', 'the eighteenth Dynasty and the second Corps');
  // A name nothing is known about gets the plain number, which is how the voice read "II" and "III" before.
  say('Geography III and William Seward Burroughs II', 'Geography three and William Seward Burroughs two');
});

test('letters that only look like Roman numerals are left alone', () => {
  for (const t of ['Tonight I Can Write the Saddest Lines', 'Why I Am Not a Christian', 'Do I dare?', 'Malcolm X gave this speech about Generation X.', 'When X is not Hausdorff',
    'the book I read and the part I played', 'An IV drip was given through IV access.', 'The IV was removed.', 'Super Bowl XLII', 'Nas X', 'the XX chromosomes', 'vitamin C and vitamin D',
    'John V. Atanasoff built it.', 'Malcolm X. Farrakhan spoke later.', 'I heard: Louis.', 'The answer is I.']) same(t);
  // After a full stop, a word that opens sentences shows that the numeral ended one.
  say('It was won by Charles V. He then abdicated.', 'It was won by Charles the fifth. He then abdicated.');
  say('after World War I. He left', 'after World War one. He left');
});

test('numbers with separators, decimals and years with a nought', () => {
  say('The army marched 1,514 miles and then 1,400 yards.', 'The army marched one thousand five hundred fourteen miles and then one thousand four hundred yards.');
  say('It sold 784,000 copies and then 2,500 more.', 'It sold seven hundred eighty-four thousand copies and then two thousand five hundred more.');
  say('427,000 people and 1,234.5 metres and 105,000 more', 'four hundred twenty-seven thousand people and one thousand two hundred thirty-four point five metres and one hundred five thousand more');
  // One or two digits and then only noughts are read well as written, and are left so.
  for (const t of ['The army of 12,000 men took 6,000 prisoners.', 'a 2,000-year-old city of 2,000,000 people', 'It cost $10,000.', 'accounts above 100,000 euros and 250,000 men']) same(t);
  // A percent sign after a number in words is written out too.
  say('It acquired 19.9% of Tsingtao.', 'It acquired 19 point nine percent of Tsingtao.');
  say('from 0.5% to 12.5 %', 'from 0 point five percent to 12 point five percent');
  say('The constant is 8.314, and pi is about 3.14.', 'The constant is 8 point three one four, and pi is about 3 point one four.');
  say('above −35.9 degrees Celsius', 'above minus 35 point nine degrees Celsius');
  say('a .300 average', 'a point three zero zero average');
  say('He stayed until 1905.', 'He stayed until nineteen oh five.');
  say('In 1807, the trade was abolished.', 'In eighteen oh seven, the trade was abolished.');
  say('to collect $427,000 in unpaid taxes', 'to collect four hundred twenty-seven thousand dollars in unpaid taxes');
  say('It cost $3.5 million, then $19.99, then £2,500.', 'It cost 3 point five million dollars, then 19 dollars and 99 cents, then two thousand five hundred pounds.');
  // What the voice already reads well stays as it is written.
  for (const t of ['In 1848 he fled to London.', 'A 2022 lawsuit after a sponsorship in 2008.', 'In 1066 he invaded, and in 1009 a church was destroyed.', 'For 10 points, name this author.',
    'the 8th century and the 1990s', 'It raised $8 million and cost $15.', 'a 10% false negative rate', 'version 1.2.3 of the format', 'pages 2,2,2,3 in a pattern', 'the 1900s and 1905th']) same(t);
});

test('titles and abbreviations that were garbled or halting', () => {
  say('Mr. and Mrs. Smith met Ms. Jones on Mt. Fuji, near St. Louis.', 'Mister and Missus Smith met Miz Jones on Mount Fuji, near Saint Louis.');
  say('Experiments conducted by Dr. Benway', 'Experiments conducted by Doctor Benway');
  say('the Piano Sonata No. 14, Op. 27 No. 2, in C-sharp minor', 'the Piano Sonata Number 14, Opus 27 Number 2, in C-sharp minor');
  say('this pathway, vs. the control', 'this pathway, versus the control');
  say('Plessy v. Ferguson and Roe v. Wade', 'Plessy versus Ferguson and Roe versus Wade');
  say('William F. Buckley, Jr. founded this magazine.', 'William F Buckley Junior founded this magazine.');
  say('The answer is William F. Buckley, Jr.', 'The answer is William F Buckley Junior');
  say('He earned a Ph.D. in physics.', 'He earned a PhD in physics.');
  // Forms that did not come out better rewritten are left as they are written.
  for (const t of ['They sold apples, pears, etc. at the market.', 'A study by Sinclair et al. found this.', 'It happened in 44 B.C.E. near Rome.', 'The Notorious B.I.G. recorded it.',
    'The concert began at 8 p.m. on Friday.', 'the magnitudes of u and v. For orthonormal vectors', 'He said no. 5 of them left.', 'the St. of the realm']) same(t);
});

test('initials lose their full stops, and nothing else does', () => {
  say('It was coined by J. L. Austin in a book.', 'It was coined by J L Austin in a book.');
  say('W. E. B. Du Bois and W.V.O. Quine and C.S. Lewis', 'W E B Du Bois and W V O Quine and C S Lewis');
  say('This president succeeded John F. Kennedy.', 'This president succeeded John F Kennedy.');
  say('F. Scott Fitzgerald and J. Alfred Prufrock and O. Henry\'s stories', 'F Scott Fitzgerald and J Alfred Prufrock and O Henry\'s stories');
  say('The answer is E. M. Forster.', 'The answer is E M Forster.');
  say('the U.S. Senate', 'the U S Senate');
  // A single letter that ends a sentence keeps its full stop: the next word opens a sentence, or is not part of a name.
  for (const t of ['which commute with all elements of S. The order of this subgroup', 'a normal subgroup H. Two kinds of these objects', 'the decay of actinium K. Reacting with water',
    'never charted in the U.S. This band', 'A. Philip Randolph led it.', 'in E. coli and C. elegans', 'Plan B. It failed.']) same(t);
});

test('letters and marks the voice has no character for', () => {
  say('In this saga, Guðrun kills Kjartan, and Þorgerðr mourns him.', 'In this saga, Guthrun kills Kjartan, and Thorgerthr mourns him.');
  say('an aglæcwif by the poet Æthelwulf', 'an aglaecwif by the poet Aethelwulf');
  say('José Müller met Beyoncé in São Paulo.', 'Jose Muller met Beyonce in Sao Paulo.');
  say('Dvořák and Łódź', 'Dvorak and Lodz');
  say('the Inter@ctive Pager', 'the Interactive Pager');
  say('write to me@example.com', 'write to me at example.com');
  say('x → y and a [bracket] and <tag> and 9/4 time', 'x y and a bracket and tag and 9 4 time');
  say('It was “quoted” — and so on…', 'It was "quoted", and so on...');
  // Nothing outside the voice model's alphabet ever leaves here.
  const model = /^[A-Za-z0-9 !"$%&'()+,\-.:;?£€]*$/;
  for (const t of ['中文 text', 'emoji 😀 here', 'tabs\tand\nnewlines', '# = @ [ \\ ] ^ _ ` { | } ~ < > * /', 'Δx ≈ 5 ± 2 °C']) assert.match(speakable(t), model, t);
});

test('a phrase in single quotes is not glued to the word before it', () => {
  say('He painted self-portraits \'with a red scarf\' and \'with a horn\'.', 'He painted self-portraits "with a red scarf" and "with a horn".');
  say('The class of \'59 met in the \'70s.', 'The class of 59 met in the 70s.');
  say('an \'opeless fancy and \'twixt thing and word', 'an opeless fancy and twixt thing and word');
  for (const t of ['the dogs\' bowls and the cat\'s toy', 'It\'s what the thinker\'s book said.', 'rock and roll, y\'all']) same(t);
});

test('the fixed phrases and ordinary sentences are said exactly as written', () => {
  for (const p of Object.values(PHRASES)) same(p);
  for (const t of ['This thinker argued that the mind is a blank slate at birth.', 'For 10 points, name this author of the Critique of Pure Reason.', 'I heard: Immanuel Kant.',
    'The answer is Soren Kierkegaard.', 'Kant. Spelled: K, A, N, T.', 'Twenty points on that bonus.', 'He asked, "What is truth?" and left.']) same(t);
  assert.equal(speakable(''), '');
  assert.equal(speakable(null), '');
  assert.equal(speakable('   '), '');
});

test('over every fixture question: said text stays within the model\'s alphabet, and little of it is rewritten', () => {
  const model = /^[A-Za-z0-9 !"$%&'()+,\-.:;?£€]*$/;
  let pieces = 0; let touched = 0;
  const check = text => {
    for (const c of chunkForSpeech(text)) {
      const s = speakable(c.text); pieces++;
      assert.match(s, model, c.text);
      assert.ok(s.length > 0, 'something is said for: ' + c.text);
      assert.ok(s.length < c.text.length * 1.6 + 40, 'not blown up: ' + c.text + ' => ' + s);
      assert.equal(speakable(s), s, 'saying it twice changes nothing more: ' + s);
      if (s !== c.text) touched++;
    }
  };
  for (const f of ['tossups-philosophy.json', 'tossups-mixed.json', 'tossups-mathcs.json']) for (const t of fx(f).tossups) { check(cleanForSpeech(t.question_sanitized).text); check(`The answer is ${mainAnswer(t.answer_sanitized)}.`); }
  for (const f of ['bonuses-philosophy.json', 'bonuses-mixed.json', 'bonuses-mathcs.json']) for (const b of fx(f).bonuses) { check(cleanForSpeech(b.leadin_sanitized || '').text); for (const p of b.parts_sanitized) check(cleanForSpeech(p).text); }
  assert.ok(pieces > 1500, 'the fixtures were read: ' + pieces);
  assert.ok(touched / pieces < 0.1, `${touched} of ${pieces} pieces are rewritten`);
  assert.ok(touched > 20, 'and some are');
});

test('notes to the reader that used to be read aloud are removed', () => {
  const c = s => cleanForSpeech(s).text;
  assert.equal(c('It was first sung by Peter Pears (peers). The rondeau'), 'It was first sung by Peter Pears. The rondeau');
  assert.equal(c('Proteins known as snRNPs (snurps) complex with RNA to form the spliceosome (splice-uh-sohm).'), 'Proteins known as snRNPs complex with RNA to form the spliceosome.');
  assert.equal(c('in the Tay Ninh (TYE nun) Holy See'), 'in the Tay Ninh Holy See');
  assert.equal(c('Ran GTPases (Ran G-P-T-ayss-es) provide the energy'), 'Ran GTPases provide the energy');
  assert.equal(c('Petre Dumitrescu’s ("doo-mih-tresk-ooʼs") Romanian forces'), 'Petre Dumitrescu\'s Romanian forces');
  assert.equal(c('"Land der Berge, Land am Strome" ("LAHNT dair BAIR-guh, LAHNT ahm SHTROH-muh"), Austria\'s song'), '"Land der Berge, Land am Strome", Austria\'s song');
  assert.equal(c('"Nimm sie hin denn, diese Lieder" [nimm zee HIN denn, DEE-zuh LEE-duh].'), '"Nimm sie hin denn, diese Lieder".');
  assert.equal(c('for having written 2666 ("26-66"). Reviewer'), 'for having written 2666. Reviewer');
  assert.equal(c('the antiderivative of 1/x ("1 over x"). All of them'), 'the antiderivative of 1 over x. All of them');
  // Double square brackets, as some sets write their guides.
  assert.equal(c('the Gallic Allobroges [[all-oh-BRO-gis]] people'), 'the Gallic Allobroges people');
  assert.equal(c('and is named Wozzeck [["VOT-seck"]]. Almaviva'), 'and is named Wozzeck. Almaviva');
  // A note with no space after it does not glue its neighbours together.
  assert.equal(c('chartered the Oscar II("two")with the backing'), 'chartered the Oscar II with the backing');
});

test('marks and dots that are not part of the text are removed', () => {
  const c = s => cleanForSpeech(s);
  assert.equal(c('in an ($) Erich Maria Remarque novel').text, 'in an Erich Maria Remarque novel');
  assert.equal(c('of the (+) Four Hinds and the (#) rest').text, 'of the Four Hinds and the rest');
  const twoStars = c('This bicyclic (**) heptapeptide contains a linkage.');
  assert.equal(twoStars.text, 'This bicyclic heptapeptide contains a linkage.');
  assert.equal(twoStars.text.slice(twoStars.powerOffset), 'heptapeptide contains a linkage.');
  assert.equal(c('Lithium di•iso•propyl•amide and methano•genesis near Camelo•pardalis').text, 'Lithium diisopropylamide and methanogenesis near Camelopardalis');
  assert.equal(c('a·b is a product; UᐧK is a country').text, 'a b is a product; U K is a country');
  assert.equal(c('in 3/4 time and 3/4 of the vote and 9/8').text, 'in 3/4 time and three quarters of the vote and 9/8');
  assert.equal(c('He has a .300 average.').text, 'He has a .300 average.');
});

test('real asides are kept, however much they resemble the words before them', () => {
  const c = s => cleanForSpeech(s).text;
  for (const t of ['a Portrait of Nude Sitting on a Divan ("La Belle Romaine"), whose many paintings', 'her Three Movements for Orchestra (Symphony No. 1).', 'the track "You\'re Nobody (Til Somebody Kills You)," which begins',
    'by using copper(I) to complex two macrocycles', 'Kruskal runs in O of E log E or O of E log V time', 'It was moved from Calcutta (Kolkata) to Delhi.', 'the old capital Peking (Beijing) fell',
    'It was written (in 1781) by him.', 'the Dao (way) and the Pequod (the ship)']) assert.equal(c(t), t, t);
  assert.equal(c('He asked "What is [this entity]?" and wrote "The Will to [do this]."'), 'He asked "What is this entity?" and wrote "The Will to do this."');
  assert.equal(c('Kruskal runs in O(E logE) or O(E logV) time'), 'Kruskal runs in O of E log E or O of E log V time');
  assert.equal(isReaderNote('peers', false, 'first sung by Peter Pears'), true);
  assert.equal(isReaderNote('peers', false, 'the House of Lords and its members'), false);
  assert.equal(isReaderNote('"La Belle Romaine"', false, 'Nude Sitting on a Divan'), false);
  assert.equal(isReaderNote('"bair-suzz"', false, 'A calm Berceuse'), true);
  assert.ok(echoOfBefore('snurps', 'known as snRNPs') >= 0.62);
  assert.ok(echoOfBefore('Til Somebody Kills You', 'the track "You\'re Nobody') < 0.62);
});

test('the reader hands the voice the spoken form, and keeps its audio under the written one', async () => {
  const asked = [];
  const tts = { speak: (text, o) => { asked.push(text); return { promise: Promise.resolve({ samples: new Float32Array(8), sampleRate: 44100 }) }; }, cancel () {} };
  const n = new Narrator({ tts, audio: {}, voice: () => ({ sid: 5, speed: 1.3, steps: 5 }) });
  await n.synth('Louis XIV marched 1,514 miles.');
  await n.synth('Louis XIV marched 1,514 miles.');
  await n.synth('That\'s correct.');
  assert.deepEqual(asked, ['Louis the fourteenth marched one thousand five hundred fourteen miles.', 'That\'s correct.']);
  assert.ok([...n.cache.keys()].some(k => k.endsWith('|Louis XIV marched 1,514 miles.')));
});

test('a place in the spoken form is found in the written text, and back', () => {
  const written = 'He marched 1,514 miles to Rome.';
  const said = speakable(written);
  assert.equal(said, 'He marched one thousand five hundred fourteen miles to Rome.');
  const pairs = alignment(written, said);
  assert.equal(alignment(written, written), null);
  assert.equal(placeInWritten(null, 7), 7);
  // Words that are the same in both are fixed points.
  for (const w of ['He', 'marched', 'miles', 'to', 'Rome.']) {
    assert.equal(placeInWritten(pairs, said.indexOf(w)), written.indexOf(w), w);
    assert.equal(placeInSaid(pairs, written.indexOf(w)), said.indexOf(w), w);
  }
  assert.equal(placeInWritten(pairs, 0), 0);
  assert.equal(placeInWritten(pairs, said.length), written.length);
  // Half way through "one thousand five hundred fourteen" is half way through "1,514".
  const mid = placeInWritten(pairs, said.indexOf('one') + 17);
  assert.ok(mid > written.indexOf('1,514') && mid < written.indexOf('1,514') + 5, 'inside the number: ' + mid);
  // Never backwards, in either direction.
  let last = -1; for (let p = 0; p <= said.length; p++) { const w = placeInWritten(pairs, p); assert.ok(w >= last && w <= written.length); last = w; }
  last = -1; for (let p = 0; p <= written.length; p++) { const s = placeInSaid(pairs, p); assert.ok(s >= last && s <= said.length); last = s; }
  // Several rewrites in one sentence, and one at each end.
  const w2 = 'Louis XIV met Dr. Benway in 1905.'; const s2 = speakable(w2); const p2 = alignment(w2, s2);
  assert.equal(s2, 'Louis the fourteenth met Doctor Benway in nineteen oh five.');
  assert.equal(placeInWritten(p2, s2.indexOf('met')), w2.indexOf('met'));
  assert.equal(placeInWritten(p2, s2.indexOf('Benway')), w2.indexOf('Benway'));
  assert.equal(placeInWritten(p2, s2.length), w2.length);
});

/** A sound engine whose clock is moved by hand. */
function handAudio () {
  let now = 0; const handles = [];
  return {
    handles, get time () { return now; }, set time (t) { now = t; },
    play (samples, rate, { when = 0, offset = 0 } = {}) {
      const startAt = Math.max(now + 0.001, when); const dur = samples.length / rate - offset; let done;
      const ended = new Promise(resolve => { done = resolve; });
      const h = { startAt, endAt: startAt + dur, offset, ended, position: () => offset + Math.min(dur, Math.max(0, now - startAt)), stop: () => done('stopped') };
      handles.push(h); return h;
    }
  };
}

test('the buzz position follows the spoken form through a rewritten number', async () => {
  const written = 'He marched 1,514 miles to Rome.';
  const said = speakable(written);
  const audio = handAudio();
  // Ten seconds of audio for the sentence: time runs evenly through the SPOKEN form.
  const tts = { speak: () => ({ promise: Promise.resolve({ samples: new Float32Array(1000), sampleRate: 100 }) }), cancel () {} };
  const n = new Narrator({ tts, audio, voice: () => ({ sid: 5, speed: 1.3, steps: 5 }) });
  const reading = n.read([{ text: written, start: 0, end: written.length }], { lookahead: 0 });
  let again = null;
  try {
    for (let i = 0; i < 20 && !audio.handles.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const h = audio.handles[0];
    const at = share => { audio.time = h.startAt + share * 10; return reading.positionAt(); };
    assert.equal(at(said.indexOf('miles') / said.length), written.indexOf('miles'), 'just as "miles" begins');
    assert.equal(at(said.indexOf('marched') / said.length), written.indexOf('marched'));
    const inNumber = at((said.indexOf('one thousand') + 17) / said.length);
    assert.ok(inNumber > written.indexOf('1,514') && inNumber < written.indexOf(' miles'), 'while the number is being said the place is inside "1,514": ' + inNumber);
    // Counted evenly over the written characters, the moment "miles" begins would be placed seven characters past it.
    assert.equal(Math.round(written.length * said.indexOf('miles') / said.length) - written.indexOf('miles'), 7);
    reading.stop();
    // Carrying on from a place in the text starts the audio at the matching place in the spoken form.
    again = n.read([{ text: written, start: 0, end: written.length }], { lookahead: 0, from: written.indexOf('miles') });
    for (let i = 0; i < 20 && audio.handles.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(Math.abs(audio.handles[1].offset - (10 * said.indexOf('miles') / said.length - 0.3)) < 0.02, 'audio offset ' + audio.handles[1].offset);
  } finally { reading.stop(); if (again) again.stop(); }
});

test('the reader\'s own voice is recognised in its spoken form too', () => {
  const shown = 'This palace was built for Louis XIV, who marched 1,514 miles with Dr. Benway in World War II.';
  assert.ok(isEcho('built for louis the fourteenth who marched', shown));
  assert.ok(isEcho('one thousand five hundred fourteen miles with doctor benway', shown));
  assert.ok(isEcho('in world war two', shown));
  assert.ok(isEcho('this palace was built for louis', shown));
  assert.ok(!isEcho('immanuel kant', shown));
  assert.ok(!isEcho('buzz', shown));
});
