// Generates synthetic test audio with the Supertonic voices (all at 16 kHz):
//   out/buzz/      the word "buzz" in every voice at several speeds          (positives)
//   out/questions/ quizbowl sentences read aloud                              (negatives / "echo")
//   out/answers/   spoken answers taken from real answerlines                 (for the judge)
//   out/words/     confusable words and command phrases
// Usage: node tools/exp/gen-audio.cjs <buzz|questions|answers|words|all> [--n N]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, writeWav, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak } = require('./models.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const what = process.argv[2] || 'all';

(async () => {
  const st = await import('../../docs/js/speechtext.js');
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const say = (text, o) => { const a = speak(tts, text, o); return resample(a.samples, a.sampleRate, 16000); };
  const save = (dir, name, samples, meta) => {
    writeWav(path.join(OUT, dir, name + '.wav'), samples, 16000);
    fs.writeFileSync(path.join(OUT, dir, name + '.json'), JSON.stringify(meta));
  };
  const fixtures = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', f), 'utf8'));

  if (what === 'buzz' || what === 'all') {
    let n = 0;
    for (let sid = 0; sid < 10; sid++) for (const speed of [0.85, 1.0, 1.2]) for (const [k, text] of [['a', 'Buzz.'], ['b', 'Buzz!']]) {
      save('buzz', `buzz-s${sid}-v${speed}-${k}`, say(text, { sid, speed }), { text: 'buzz', sid, speed }); n++;
    }
    console.log('buzz samples:', n);
  }

  if (what === 'questions' || what === 'all') {
    const tossups = fixtures('tossups-philosophy.json').tossups;
    const want = Number(arg('n', 40)); let n = 0; let sec = 0;
    outer: for (let q = 0; q < tossups.length; q++) {
      for (const c of st.chunkForSpeech(st.cleanForSpeech(tossups[q].question_sanitized).text)) {
        const sid = n % 10;
        const s = say(c.text, { sid, speed: 1.05 });
        save('questions', 'q' + String(n).padStart(3, '0'), s, { text: c.text, sid }); n++; sec += s.length / 16000;
        if (n >= want) break outer;
      }
    }
    console.log(`question sentences: ${n}, ${sec.toFixed(0)} s`);
  }

  if (what === 'answers' || what === 'all') {
    const bonuses = [...fixtures('bonuses-philosophy.json').bonuses];
    const tossups = fixtures('tossups-philosophy.json').tossups;
    const lines = [...tossups.map(t => ({ html: t.answer, plain: t.answer_sanitized })), ...bonuses.flatMap(b => b.answers.map((a, i) => ({ html: a, plain: b.answers_sanitized[i] })))];
    const want = Number(arg('n', 120)); let n = 0;
    const seen = new Set();
    for (const l of lines) {
      const spoken = st.mainAnswer(l.plain);
      if (!spoken || seen.has(spoken.toLowerCase()) || spoken.length > 60) continue;
      seen.add(spoken.toLowerCase());
      const sid = n % 10; const speed = [0.95, 1.05, 1.15][n % 3];
      save('answers', 'a' + String(n).padStart(3, '0'), say(spoken + '.', { sid, speed }), { text: spoken, answerline: l.html, sid, speed }); n++;
      if (n >= want) break;
    }
    console.log('answers:', n);
  }

  if (what === 'words' || what === 'all') {
    const words = ['Bus.', 'Boss.', 'Because.', 'Business.', 'Busy.', 'Bugs.', 'Does.', 'Was.', 'Fuzz.', 'Buzzer.', 'Yes.', 'No.', 'Next question.', 'Skip question.', 'Repeat question.', 'Pause quiz.', 'Resume quiz.', 'I was right.', 'I was wrong.', 'Correct.', 'Wrong.', 'Hello there.', 'What time is it?', 'Turn left here.', 'Okay.', 'Hmm.', 'Uh, I think so.'];
    let n = 0;
    for (const w of words) for (const sid of [1, 4, 7]) { save('words', w.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-$/, '') + '-s' + sid, say(w, { sid, speed: 1.0 }), { text: w, sid }); n++; }
    console.log('words:', n);
  }
})().catch(e => { console.error('FAILED', e); process.exit(1); });
