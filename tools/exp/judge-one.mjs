// Judges one or more "answerline => said" pairs and prints the full verdicts.
// Usage: node tools/exp/judge-one.mjs "<answerline>" "<said>" ["<answerline>" "<said>" ...]
import { judgeAnswer, parseAnswerline } from '../../docs/js/judge.js';
import { numberVariants } from '../../docs/js/numbers.js';
import checkAnswer from '../../docs/vendor/qb-answer-checker.js';

const a = process.argv.slice(2);
for (let i = 0; i + 1 < a.length; i += 2) {
  const r = judgeAnswer({ answerline: a[i], transcripts: [a[i + 1]], checkAnswer });
  console.log(`${a[i].replace(/<[^>]*>/g, '')}  <=  "${a[i + 1]}"  ->  ${r.directive} via ${r.method} (${(r.score || 0).toFixed(2)})${r.matched ? ' ~ ' + r.matched : ''}`);
  console.log('   phrases:', JSON.stringify(parseAnswerline(a[i]).clauses.map(c => [c.directive, c.phrases])), ' heard as:', JSON.stringify(numberVariants(a[i + 1])));
}
