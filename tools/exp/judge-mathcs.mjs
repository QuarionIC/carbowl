// How the judge copes with Math / Computer Science answers as a speech recogniser would write them.
// Usage: node tools/exp/judge-mathcs.mjs
import { judgeAnswer } from '../../docs/js/judge.js';
import checkAnswer from '../../docs/vendor/qb-answer-checker.js';

const cases = [
  ['<b><u>two</u></b> [or <b><u>2</u></b>]', ['two', '2', 'the number two', 'to', 'too'], ['three']],
  ['<b><u>24</u></b>', ['twenty four', 'twenty-four', '24'], ['twenty five', 'forty two']],
  ['<b><u>P</u></b> [or early <b><u>polynomial</u></b> time]', ['p', 'pee', 'polynomial time', 'P.'], ['np']],
  ['<b><u>C++</u></b>', ['c plus plus', 'C++', 'see plus plus'], ['c sharp', 'c']],
  ['<b><u>C#</u></b> [or <b><u>C sharp</u></b>]', ['c sharp', 'see sharp'], ['c plus plus']],
  ['<b><u>A*</u></b> search [or <b><u>A-star</u></b>]', ['a star', 'a star search'], ['b star']],
  ['<b><u>pi</u></b>', ['pi', 'pie'], ['phi', 'e']],
  ['<b><u>e</u></b> [or <b><u>Euler</u></b>\'s number]', ['e', 'eulers number', "euler's number", 'oilers number'], ['pi']],
  ['<b><u>zero</u></b> [or <b><u>0</u></b>]', ['zero', '0', 'oh'], ['one']],
  ['<b><u>O(n log n)</u></b> [accept <b><u>n log n</u></b>]', ['n log n', 'o of n log n', 'big o of n log n', 'and log n'], ['n squared']],
  ['<b><u>one-half</u></b> [or <b><u>1/2</u></b> or <b><u>0.5</u></b>]', ['one half', 'a half', 'one over two', 'point five'], ['one third']],
  ['<b><u>1729</u></b>', ['seventeen twenty nine', 'one thousand seven hundred twenty nine', '1729', 'one seven two nine'], ['1728']],
  ['<b><u>Dijkstra</u></b>\'s algorithm', ['dijkstras algorithm', 'dykstra', 'dike stra', "dijkstra's"], ['prims algorithm']],
  ['<b><u>NP-complete</u></b>ness', ['np complete', 'n p complete', 'np completeness', 'and p complete'], ['np hard']],
  ['<b><u>Euler</u></b>', ['euler', 'oiler', 'leonhard euler'], ['euclid']],
  ['<b><u>hash</u></b>es [or <b><u>hash</u></b> codes]', ['hashes', 'hash', 'hash function'], ['heaps']],
  ['<b><u>square root of 2</u></b> [or <b><u>root 2</u></b>]', ['square root of two', 'root two', 'the square root of 2'], ['square root of three']]
];
let ok = 0; let total = 0; const misses = [];
for (const [line, good, bad] of cases) {
  for (const said of good) { total++; const r = judgeAnswer({ answerline: line, transcripts: [said], checkAnswer }); if (r.directive === 'accept') ok++; else misses.push(`  should ACCEPT "${said}" for ${line.replace(/<[^>]*>/g, '')}  -> ${r.directive} (${r.method} ${r.score.toFixed(2)})`); }
  for (const said of bad) { total++; const r = judgeAnswer({ answerline: line, transcripts: [said], checkAnswer }); if (r.directive !== 'accept') ok++; else misses.push(`  should REJECT "${said}" for ${line.replace(/<[^>]*>/g, '')}  -> ${r.directive} (${r.method} ${r.score.toFixed(2)} ~ ${r.matched})`); }
}
console.log(`${ok}/${total} as expected`);
console.log(misses.join('\n'));
