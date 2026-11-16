import test from 'node:test';
import assert from 'node:assert/strict';
import { numberVariants, canonNumbers, numberTokens, digitsToWords } from '../docs/js/numbers.js';
import { judgeAnswer, symbolNames } from '../docs/js/judge.js';
import checkAnswer from '../docs/vendor/qb-answer-checker.js';

test('number words become digits, in each plausible reading', () => {
  assert.deepEqual(numberVariants('twenty four'), ['24']);
  assert.deepEqual(numberVariants('twenty-four'), ['24']);
  assert.deepEqual(numberVariants('one hundred and five'), ['105']);
  assert.deepEqual(numberVariants('nineteen hundred'), ['1900']);
  assert.deepEqual(numberVariants('two thousand twenty six'), ['2026']);
  assert.deepEqual(numberVariants('a thousand'), ['1000']);
  assert.deepEqual(numberVariants('three million'), ['3000000']);
  assert.deepEqual(numberVariants('seventeen twenty nine'), ['1729', '17 29'], 'spoken like a year');
  assert.deepEqual(numberVariants('one seven two nine'), ['1729', '1 7 2 9'], 'digit by digit');
  assert.deepEqual(numberVariants('nineteen oh five'), ['1905', '19 0 5']);
  assert.deepEqual(numberVariants('twenty twenty'), ['2020', '20 20']);
  assert.deepEqual(numberVariants('zero'), ['0']);
  assert.equal(canonNumbers('the square root of two'), 'the square root of 2');
  assert.equal(canonNumbers('apollo eleven'), 'apollo 11');
});

test('fractions, decimals and negatives', () => {
  assert.equal(canonNumbers('one half'), '1/2');
  assert.equal(canonNumbers('a half'), '1/2');
  assert.equal(canonNumbers('one over two'), '1/2');
  assert.equal(canonNumbers('two thirds'), '2/3');
  assert.equal(canonNumbers('three quarters'), '3/4');
  assert.equal(canonNumbers('point five'), '0.5');
  assert.equal(canonNumbers('zero point five'), '0.5');
  assert.equal(canonNumbers('three point one four'), '3.14');
  assert.equal(canonNumbers('negative one'), '-1');
  assert.equal(canonNumbers('0.5'), '0.5');
  assert.equal(canonNumbers('1/2'), '1/2');
  assert.deepEqual(numberTokens('root 2 and 1/2 or 0.5 then -1'), ['2', '1/2', '0.5', '-1']);
});

test('ordinary words are left alone', () => {
  for (const s of ['immanuel kant', 'oh no', 'a priori', 'the one and the many', 'being and time', 'on the genealogy of morals']) {
    const v = numberVariants(s);
    if (s === 'the one and the many') assert.deepEqual(v, ['the 1 and the many']); else assert.deepEqual(v, [s]);
  }
  assert.deepEqual(numberVariants('hundred years war'), ['hundred years war'], 'a bare "hundred" is not a number');
  assert.deepEqual(numberVariants(''), ['']);
});

test('digits are written out for comparison by sound', () => {
  assert.equal(digitsToWords('24'), 'twenty four');
  assert.equal(digitsToWords('1729'), 'one thousand seven hundred twenty nine');
  assert.equal(digitsToWords('105'), 'one hundred five');
  assert.equal(digitsToWords('0'), 'zero');
  assert.equal(digitsToWords('square root of 2'), 'square root of two');
  assert.equal(digitsToWords('1/2'), 'one half');
  assert.equal(digitsToWords('0.5'), 'zero point five');
  assert.equal(digitsToWords('5/7'), 'five over seven');
  assert.equal(digitsToWords('007'), 'zero zero seven');
  assert.equal(digitsToWords('kant'), 'kant');
});

test('names written with symbols are said as words', () => {
  assert.equal(symbolNames('C++'), 'C plus plus');
  assert.equal(symbolNames('<b><u>C#</u></b>'), '<b><u>C sharp</u></b>');
  assert.equal(symbolNames('A* search'), 'A star search');
  assert.equal(symbolNames('#P-complete'), 'sharp P-complete');
  assert.equal(symbolNames('Montgomery&#39;s'), 'Montgomery&#39;s', 'character references are not sharps');
  assert.equal(symbolNames('Immanuel Kant'), 'Immanuel Kant');
});

const judge = (answerline, said) => judgeAnswer({ answerline, transcripts: [said], checkAnswer }).directive;

test('judge: spoken numbers match written ones, and different numbers do not', () => {
  assert.equal(judge('<b><u>24</u></b>', 'twenty four'), 'accept');
  assert.equal(judge('<b><u>24</u></b>', 'twenty five'), 'reject');
  assert.equal(judge('<b><u>24</u></b>', 'forty two'), 'reject');
  assert.equal(judge('<b><u>1729</u></b>', 'seventeen twenty nine'), 'accept');
  assert.equal(judge('<b><u>1729</u></b>', 'one thousand seven hundred twenty nine'), 'accept');
  assert.equal(judge('<b><u>1729</u></b>', 'one seven two nine'), 'accept');
  assert.equal(judge('<b><u>1729</u></b>', 'seventeen twenty eight'), 'reject');
  assert.equal(judge('<b><u>two</u></b> [or <b><u>2</u></b>]', 'two'), 'accept');
  assert.equal(judge('<b><u>two</u></b> [or <b><u>2</u></b>]', 'to'), 'accept', 'a homophone the recogniser may write');
  assert.equal(judge('<b><u>two</u></b> [or <b><u>2</u></b>]', 'three'), 'reject');
  assert.equal(judge('<b><u>one-half</u></b> [or <b><u>1/2</u></b> or <b><u>0.5</u></b>]', 'a half'), 'accept');
  assert.equal(judge('<b><u>one-half</u></b> [or <b><u>1/2</u></b> or <b><u>0.5</u></b>]', 'one over two'), 'accept');
  assert.equal(judge('<b><u>one-half</u></b> [or <b><u>1/2</u></b> or <b><u>0.5</u></b>]', 'point five'), 'accept');
  assert.equal(judge('<b><u>one-half</u></b> [or <b><u>1/2</u></b> or <b><u>0.5</u></b>]', 'one third'), 'reject');
  assert.equal(judge('<b><u>square root of 2</u></b> [or <b><u>root 2</u></b>]', 'the square root of two'), 'accept');
  assert.equal(judge('<b><u>square root of 2</u></b> [or <b><u>root 2</u></b>]', 'square root of three'), 'reject');
});

test('judge: programming names with symbols', () => {
  assert.equal(judge('<b><u>C++</u></b>', 'c plus plus'), 'accept');
  assert.equal(judge('<b><u>C++</u></b>', 'C++'), 'accept');
  assert.equal(judge('<b><u>C++</u></b>', 'c sharp'), 'reject');
  assert.equal(judge('<b><u>C++</u></b>', 'c'), 'reject');
  assert.equal(judge('<b><u>C#</u></b> [or <b><u>C sharp</u></b>]', 'c sharp'), 'accept');
  assert.equal(judge('<b><u>C#</u></b> [or <b><u>C sharp</u></b>]', 'c plus plus'), 'reject');
  assert.equal(judge('<b><u>A*</u></b> search [or <b><u>A-star</u></b>]', 'a star search'), 'accept');
  assert.equal(judge('<b><u>Dijkstra</u></b>\'s algorithm', 'dykstra'), 'accept');
  assert.equal(judge('<b><u>NP-complete</u></b>ness', 'np complete'), 'accept');
  assert.equal(judge('<b><u>NP-complete</u></b>ness', 'np hard'), 'reject');
});

test('judge: numbers do not disturb ordinary answers', () => {
  assert.equal(judge('Immanuel <b><u>Kant</u></b>', 'immanuel kant'), 'accept');
  assert.equal(judge('<b><u>Being and Time</u></b>', 'being and time'), 'accept');
  assert.equal(judge('<b><u>One-Dimensional Man</u></b>', 'one dimensional man'), 'accept');
  assert.equal(judge('<b><u>Apollo 11</u></b>', 'apollo eleven'), 'accept');
  assert.equal(judge('<b><u>Apollo 11</u></b>', 'apollo thirteen'), 'reject');
  assert.equal(judge('<b><u>Catch-22</u></b>', 'catch twenty two'), 'accept');
  assert.equal(judge('<b><u>Fahrenheit 451</u></b>', 'fahrenheit four fifty one'), 'accept');
  assert.equal(judge('<b><u>1984</u></b> [or <b><u>Nineteen Eighty-Four</u></b>]', 'nineteen eighty four'), 'accept');
  assert.equal(judge('<b><u>Hundred Years\' War</u></b>', 'the hundred years war'), 'accept');
  assert.equal(judge('<b><u>Thirty Years\' War</u></b>', 'thirty years war'), 'accept');
  assert.equal(judge('<b><u>Thirty Years\' War</u></b>', 'seven years war'), 'reject');
});
