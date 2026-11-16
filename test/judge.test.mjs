import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeAnswer, parseAnswerline, normalizeTranscript, isGiveUp, bestWindowMatch } from '../docs/js/judge.js';
import { soundSimilarity, soundKeys, editDistance } from '../docs/js/phonetics.js';
import { classifyBuzz, classifyCommand, isEcho, isFillerOnly, isBuzzLike } from '../docs/js/intent.js';
import { mainAnswer } from '../docs/js/speechtext.js';
import checkAnswer from '../docs/vendor/qb-answer-checker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = f => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const judge = (answerline, said, extra = {}) => judgeAnswer({ answerline, transcripts: [said], checkAnswer, ...extra });
const KANT = 'Immanuel <b><u>Kant</u></b>';
const KIERKEGAARD = 'Søren <b><u>Kierkegaard</u></b> [or Søren Aabye <b><u>Kierkegaard</u></b>; accept Johannes <b><u>Climacus</u></b>; prompt on <u>Søren</u>]';

test('sound keys: recogniser spellings land on the same key as the name', () => {
  const same = [['Kierkegaard', 'kirk a guard'], ['Kant', "can't"], ['Nietzsche', 'neecha'], ['Rawls', 'rolls'], ['Peirce', 'purse'], ['Quine', 'kwine'], ['Arendt', "aren't"], ['Descartes', 'day cart'], ['Foucault', 'foo co'], ['Camus', 'ka moo'], ['Enquiry', 'inquiry'], ['Heidegger', 'hi digger'], ['Zhuangzi', 'chuang tzu']];
  for (const [a, b] of same) assert.ok(soundSimilarity(a, b).score >= 0.8, `${a} ~ ${b}: ${soundSimilarity(a, b).score.toFixed(2)} ${soundKeys(a)} / ${soundKeys(b)}`);
});

test('sound keys: different thinkers stay apart', () => {
  const different = [['Kant', 'Comte'], ['Kant', 'Hegel'], ['Schopenhauer', 'Spinoza'], ['Locke', 'Lacan'], ['Hegel', 'Heidegger'], ['Plato', 'Plotinus'], ['Epicurus', 'Epictetus'], ['Quine', 'Kant'], ['Rousseau', 'Russell'], ['Augustine', 'Aquinas'], ['Critique of Pure Reason', 'Critique of Judgment'], ['Being and Time', 'Being and Nothingness']];
  for (const [a, b] of different) assert.ok(soundSimilarity(a, b).score < 0.8, `${a} vs ${b}: ${soundSimilarity(a, b).score.toFixed(2)}`);
});

test('edit distance counts a swap of neighbours as one edit', () => {
  assert.equal(editDistance('abcd', 'abdc'), 1); assert.equal(editDistance('', 'abc'), 3); assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('answerline parsing: main answer, alternatives, prompts and rejections', () => {
  const p = parseAnswerline(KIERKEGAARD);
  const by = d => p.clauses.filter(c => c.directive === d).flatMap(c => c.phrases);
  assert.ok(by('accept').includes('kierkegaard')); assert.ok(by('accept').includes('climacus'));
  assert.deepEqual(by('prompt'), ['soren']);
  const q = parseAnswerline('<b><u>John Stuart Mill</u></b> [prompt on <u>Mill</u> by asking "which one?"; do not accept or prompt on "James Mill"]');
  assert.equal(q.clauses.find(c => c.directive === 'prompt').directedPrompt, 'which one?');
  assert.deepEqual(q.clauses.find(c => c.directive === 'reject').phrases, ['james mill']);
  const r = parseAnswerline('the morality of <b><u>homosexual</u></b>ity [or: obvious equivalents; prompt on:<b><u>queer</u></b>ness]');
  assert.ok(r.clauses[0].phrases.includes('homosexual'));
  assert.ok(!r.clauses.flatMap(c => c.phrases).some(x => /equivalent/.test(x)), 'instructions to the moderator are not answers');
  const s = parseAnswerline('Critique of Pure Reason [or Kritik der reinen Vernunft; accept First Critique before "Kant" is read]');
  assert.ok(s.clauses.flatMap(c => c.phrases).includes('first critique'));
  assert.deepEqual(parseAnswerline('(first-order) logic').clauses[0].phrases.sort(), ['first-order logic', 'logic']);
});

test('every real answerline parses and accepts its own main answer', () => {
  const lines = [...fx('tossups-philosophy.json').tossups.map(t => [t.answer, t.answer_sanitized]), ...fx('tossups-mixed.json').tossups.map(t => [t.answer, t.answer_sanitized]), ...fx('bonuses-philosophy.json').bonuses.flatMap(b => b.answers.map((a, i) => [a, b.answers_sanitized[i]])), ...fx('bonuses-mixed.json').bonuses.flatMap(b => b.answers.map((a, i) => [a, b.answers_sanitized[i]]))];
  let accepted = 0; const failures = [];
  for (const [html, plain] of lines) {
    const p = parseAnswerline(html);
    assert.ok(p.clauses.length >= 1, 'no clauses for ' + html);
    const said = mainAnswer(plain);
    const r = judge(html, said);
    if (r.directive === 'accept') accepted++; else failures.push(`${said}  <=  ${html}`);
  }
  assert.ok(accepted / lines.length >= 0.97, `only ${accepted}/${lines.length} accepted:\n` + failures.slice(0, 12).join('\n'));
});

test('real answers are not accepted for a different question', () => {
  const lines = fx('tossups-philosophy.json').tossups.map(t => [t.answer, mainAnswer(t.answer_sanitized)]);
  let wrong = 0; const examples = [];
  for (let i = 0; i < lines.length; i++) {
    const j = (i + 11) % lines.length;
    if (lines[i][1].toLowerCase() === lines[j][1].toLowerCase()) continue;
    const r = judge(lines[j][0], lines[i][1]);
    if (r.directive === 'accept') { wrong++; examples.push(`"${lines[i][1]}" accepted for ${lines[j][0]} via ${r.method}`); }
  }
  assert.ok(wrong <= 1, examples.join('\n'));
});

test('judging: exact, by sound, prompts, rejections, give-ups', () => {
  assert.equal(judge(KANT, 'Immanuel Kant').method, 'exact');
  assert.deepEqual([judge(KANT, "Emmanuel can't.").directive, judge(KANT, "Emmanuel can't.").method], ['accept', 'sound']);
  assert.equal(judge(KANT, 'I think it is Kant').directive, 'accept');
  assert.equal(judge(KANT, 'Hegel').directive, 'reject');
  assert.equal(judge(KANT, 'Auguste Comte').directive, 'reject');
  assert.equal(judge(KIERKEGAARD, 'kirk a guard').directive, 'accept');
  assert.equal(judge(KIERKEGAARD, 'Climacus').directive, 'accept');
  assert.equal(judge(KIERKEGAARD, 'Soren').directive, 'prompt');
  assert.equal(judge('An <b><u>Enquiry Concerning Human Understanding</u></b>', 'an inquiry concerning human understanding').directive, 'accept');
  assert.equal(judge('An <b><u>Enquiry Concerning Human Understanding</u></b>', 'a treatise of human nature').directive, 'reject');
  const mill = '<b><u>John Stuart Mill</u></b> [prompt on <u>Mill</u> by asking "which one?"; do not accept or prompt on "James Mill"]';
  assert.equal(judge(mill, 'Mill').directive, 'prompt'); assert.equal(judge(mill, 'Mill').directedPrompt, 'which one?');
  assert.equal(judge(mill, 'James Mill').directive, 'reject');
  assert.equal(judge(mill, 'John Stuart', { previous: ['Mill'] }).directive, 'accept', 'a prompted answer may complete the earlier one');
  const gave = judge(KANT, "I don't know"); assert.equal(gave.directive, 'reject'); assert.equal(gave.gaveUp, true);
  const empty = judgeAnswer({ answerline: KANT, transcripts: ['', '  '], checkAnswer }); assert.equal(empty.empty, true);
  assert.equal(judgeAnswer({ answerline: KANT, transcripts: ['Hegel', 'Kant'], checkAnswer }).directive, 'accept', 'any alternative transcript may match');
  assert.equal(judgeAnswer({ answerline: KANT, transcripts: ['count'] }).directive, 'accept', 'works without the QBReader checker too');
  const critique = 'Critique of Pure Reason [or Kritik der reinen Vernunft; accept First Critique before "Kant" is read]';
  assert.equal(judge(critique, 'First Critique').directive, 'accept');
  assert.equal(judge(critique, 'Kant').directive, 'reject', 'a word quoted in a moderator condition is not an answer');
  assert.equal(judge('<b><u>liberty</u></b> [accept "Two Concepts of Liberty" until "Berlin" is mentioned]', 'Berlin').directive, 'reject');
});

test('judging: stricter and more lenient thresholds', () => {
  const husserl = 'Edmund <b><u>Husserl</u></b>';
  assert.equal(judge(husserl, 'who sell', { threshold: 0.74 }).directive, 'accept');
  assert.equal(judge(husserl, 'who sell', { threshold: 0.9 }).directive, 'reject');
});

test('transcripts are tidied before judging', () => {
  assert.equal(normalizeTranscript('Uh, I think it is Immanuel Kant.'), 'immanuel kant');
  assert.equal(normalizeTranscript('Buzz. What is the categorical imperative?'), 'the categorical imperative');
  assert.equal(normalizeTranscript('Um.'), 'um', 'never strips the whole answer away');
  assert.ok(isGiveUp("I don't know.")); assert.ok(isGiveUp('pass')); assert.ok(!isGiveUp('Pascal'));
  assert.equal(bestWindowMatch(['the', 'answer', 'is', 'kirk', 'a', 'guard'], 'kierkegaard').window, 'kirk a guard');
});

test('buzz words: what counts and what does not', () => {
  for (const w of ['buzz', 'Buzz.', 'BUZZ!', 'bus', 'buzzed', 'buzzes', 'buss', 'boss', 'fuzz', 'bzz']) assert.ok(isBuzzLike(w), w);
  for (const w of ['because', 'business', 'but', 'this', 'pause', 'kant', 'buzzard', '']) assert.ok(!isBuzzLike(w), w);
  assert.deepEqual(classifyBuzz({ text: 'Buzz.', dur: 0.4 }, 'strict'), { buzz: true, rest: '', why: 'buzz word' });
  assert.equal(classifyBuzz({ text: 'Buzz, Immanuel Kant.', dur: 1.4 }, 'strict').rest, 'immanuel kant');
  assert.equal(classifyBuzz({ text: 'Uh buzz', dur: 0.8 }, 'strict').buzz, true);
  assert.equal(classifyBuzz({ text: 'That is.', dur: 0.4 }, 'strict').buzz, false);
  assert.equal(classifyBuzz({ text: 'Pause.', dur: 0.4 }, 'normal').buzz, true, 'a short blurt counts in normal mode');
  assert.equal(classifyBuzz({ text: 'We should stop for gas soon.', dur: 2.2 }, 'normal').buzz, false);
  assert.equal(classifyBuzz({ text: 'So the bus was late', dur: 1.5 }, 'normal').buzz, false, 'a buzz word deep inside a sentence is not a buzz');
  assert.equal(classifyBuzz({ text: 'Buzz.', dur: 0.4 }, 'off').buzz, false);
  assert.equal(classifyBuzz({ text: '', dur: 0.4 }, 'normal').buzz, false);
});

test('commands are recognised only where allowed', () => {
  assert.equal(classifyCommand('Skip question.', ['skip', 'pause']), 'skip');
  assert.equal(classifyCommand('next question', ['skip']), 'skip');
  assert.equal(classifyCommand('Pause quiz.', ['skip', 'pause']), 'pause');
  assert.equal(classifyCommand('Pause.', ['skip', 'pause']), null, 'a lone "pause" could be a misheard buzz');
  assert.equal(classifyCommand('I was right.', ['right', 'wrong']), 'right');
  assert.equal(classifyCommand('I was wrong', ['right', 'wrong']), 'wrong');
  assert.equal(classifyCommand('I was right', ['skip']), null);
  assert.equal(classifyCommand('Okay, resume', ['resume']), 'resume');
  assert.equal(classifyCommand('Repeat the question', ['repeat']), 'repeat');
  assert.equal(classifyCommand('Immanuel Kant', ['skip', 'pause', 'right', 'wrong', 'repeat', 'resume']), null);
});

test('echo and filler detection', () => {
  const spoken = 'This author recounted being woken from his dogmatic slumber by David Hume in the preface';
  assert.ok(isEcho('woken from his dogmatic slumber', spoken));
  assert.ok(isEcho('being woken from his dog matic slumber by', spoken));
  assert.ok(!isEcho('Immanuel Kant', spoken));
  assert.ok(!isEcho('this', spoken), 'one short common word proves nothing');
  assert.ok(isEcho('dogmatic', spoken));
  assert.ok(!isEcho('buzz', spoken));
  assert.ok(isFillerOnly('Um.')); assert.ok(isFillerOnly('uh, hmm')); assert.ok(isFillerOnly('')); assert.ok(!isFillerOnly('um Kant'));
});

test('speed commands need two words', () => {
  const all = ['pause', 'skip', 'faster', 'slower'];
  for (const s of ['Read faster.', 'go faster', 'Speed up', 'speed it up', 'a bit faster', 'Okay, read a little faster please']) assert.equal(classifyCommand(s, all), 'faster', s);
  for (const s of ['Read slower.', 'slow down', 'Slow it down.', 'a little slower', 'talk slower']) assert.equal(classifyCommand(s, all), 'slower', s);
  for (const s of ['faster', 'slower', 'Faster than light', 'the faster horse', 'slowly']) assert.equal(classifyCommand(s, all), null, s);
  assert.equal(classifyCommand('read faster', ['pause', 'skip']), null, 'only where allowed');
});

test('command words written by ear are still understood', () => {
  const all = ['pause', 'skip', 'faster', 'slower', 'right', 'wrong', 'repeat', 'resume'];
  assert.equal(classifyCommand('Raid faster.', all), 'faster');
  assert.equal(classifyCommand('Reed slower', all), 'slower');
  assert.equal(classifyCommand('Paws quiz.', all), 'pause');
  assert.equal(classifyCommand('I was write.', all), 'right');
  assert.equal(classifyCommand('Slough down', all), 'slower');
  assert.equal(classifyCommand('Immanuel Kant', all), null);
  assert.equal(classifyCommand('The Wright brothers', all), null);
  assert.equal(classifyCommand('Bertrand Russell', all), null);
});

test('requests to hear something again, and things the app can simply tell you', async () => {
  const { ALL_COMMANDS } = await import('../docs/js/intent.js');
  const is = (name, list) => { for (const s of list) assert.equal(classifyCommand(s, ALL_COMMANDS), name, s); };
  is('repeat', ['Repeat the question.', 'Read the question again', 'again', 'Start over', 'from the beginning', 'Read it from the top', 'one more time']);
  is('clues', ['What were the earlier clues?', 'what were the clues', 'Repeat the clues', 'read the earlier clues again', 'What did I miss?', 'what have you said so far']);
  is('back', ['Go back.', 'go back a sentence', 'Repeat that', 'Say that again.', 'What was that?', 'Repeat the last sentence', 'back up', 'what did you just say', 'Pardon?']);
  is('answer', ['What was the answer?', "What's the answer?", 'Whats the answer again', 'Repeat the answer', 'what was that answer', 'Who was that?']);
  is('spell', ['Spell that.', 'spell it', 'Can you spell that?', 'How do you spell that?', 'how is that spelled']);
  is('score', ["What's my score?", 'What is the score', 'how am I doing', 'How many points do I have?']);
  is('where', ['What category is this?', 'What set is this from?', 'what difficulty is this', 'Which tournament is this from?']);
  is('louder', ['Speak louder', 'volume up', 'Turn it up', 'a bit louder']);
  is('quieter', ['Turn it down.', 'volume down', 'a little quieter', 'too loud']);
  is('cancel', ['Never mind.', 'nevermind', 'Cancel that', "I didn't mean to buzz", 'false alarm']);
  is('help', ['What can I say?']);
  // Words that turn up in answers are not requests.
  for (const s of ['The Score', 'Back to Methuselah', 'Immanuel Kant', 'The Answer to Job', 'louder', 'Spellbound', 'A Spell for Chameleon', 'the clue', 'What Is to Be Done?', 'What is metaphysics', 'Who is afraid of Virginia Woolf']) assert.equal(classifyCommand(s, ALL_COMMANDS.filter(c => c !== 'enough')), null, s);
});

test('wake words and question-like speech', async () => {
  const { splitWake, looksLikeQuestion, isOnlyBuzz } = await import('../docs/js/intent.js');
  assert.deepEqual(splitWake('Moderator, who was David Hume?'), { wake: true, rest: 'who was david hume' });
  assert.deepEqual(splitWake('Hey moderator what were the earlier clues'), { wake: true, rest: 'what were the earlier clues' });
  assert.deepEqual(splitWake('Computer.'), { wake: true, rest: '' });
  assert.deepEqual(splitWake('Car bowl, skip this one'), { wake: true, rest: 'skip this one' });
  assert.deepEqual(splitWake('Moderate her, what is my score'), { wake: true, rest: 'what is my score' }, 'written by ear');
  for (const s of ['Immanuel Kant', 'Moderation in all things', 'A moderate position', 'The computer science of it', 'Buzz', 'compute', 'What was the answer', '']) assert.equal(splitWake(s).wake, false, s);
  assert.ok(looksLikeQuestion('Why is that the answer?')); assert.ok(looksLikeQuestion('tell me more about Hume')); assert.ok(looksLikeQuestion('who opposed him'));
  assert.ok(!looksLikeQuestion('Immanuel Kant')); assert.ok(!looksLikeQuestion('what')); assert.ok(!looksLikeQuestion('the categorical imperative'));
  assert.ok(isOnlyBuzz('Buzz.')); assert.ok(isOnlyBuzz('buzz buzz')); assert.ok(!isOnlyBuzz('Buzz Aldrin')); assert.ok(!isOnlyBuzz('')); assert.ok(!isOnlyBuzz('Kant'));
});

test('command leads: first halves of two-word commands, never a buzz word', async () => {
  const { isCommandLead } = await import('../docs/js/intent.js');
  for (const s of ['Read.', 'Raid.', 'Pause.', 'Slow', 'Speed.', 'Hold', 'Wait.', 'Stop.']) assert.ok(isCommandLead(s), s);
  for (const s of ['Buzz.', 'Bus.', 'Boss', 'Kant.', 'Skip.', 'Next.', 'Read faster.', 'This.', '']) assert.ok(!isCommandLead(s), s);
});
