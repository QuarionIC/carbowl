// How should initials be handed to the voice model? "J. L. Austin" as written, without the full
// stops, as letter names ("Jay El Austin"), or run together ("JL Austin")? Each name is said in a
// fixed sentence with the same seeds for every way of writing it; a take passes when a recogniser
// hears the initials, in order, followed by the surname, and the words around the name.
// Usage: node tools/exp/initials-probe.cjs [--seeds 3] [--part 0/2] [--out initials]
'use strict';
const fs = require('fs');
const path = require('path');
const { OUT, loadSherpa, resample } = require('./sherpa-node.cjs');
const { makeSupertonic, speak, makeRecognizer, transcribe } = require('./models.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const LETTER = { A: 'Ay', B: 'Bee', C: 'See', D: 'Dee', E: 'Ee', F: 'Eff', G: 'Gee', H: 'Aitch', I: 'Eye', J: 'Jay', K: 'Kay', L: 'El', M: 'Em', N: 'En', O: 'Oh', P: 'Pee', Q: 'Cue', R: 'Ar', S: 'Ess', T: 'Tee', U: 'You', V: 'Vee', W: 'Double-you', X: 'Ex', Y: 'Why', Z: 'Zee' };
// [first name or '', initials, rest of the name, what the surname must start with once punctuation and spaces are gone]
const NAMES = [
  ['', 'AE', 'Housman', 'h[oa]u?s'], ['', 'IM', 'Pei', 'p[ae][iy]'], ['', 'AJ', 'Ayer', '(ay|ai|iy|ey)'], ['', 'WVO', 'Quine', '(qui|kwi|qua)'], ['', 'TS', 'Eliot', 'ell?i'],
  ['', 'JRR', 'Tolkien', 'tolk'], ['George', 'HW', 'Bush', 'bush'], ['', 'WEB', 'Du Bois', 'dub'], ['John', 'F', 'Kennedy', 'kenn'], ['Harry', 'S', 'Truman', 'trum'],
  ['', 'EM', 'Forster', 'fo(r|s)'], ['', 'JL', 'Austin', 'aust'], ['', 'CS', 'Lewis', 'l(ew|ou)is'], ['', 'PW', 'Anderson', 'anders'], ['', 'F', 'Scott Fitzgerald', 'scott'],
  ['Norman', 'O', 'Brown', 'brown'], ['', 'DH', 'Lawrence', 'la[wu]r'], ['', 'HG', 'Wells', 'well'], ['', 'BF', 'Skinner', 'skinn'], ['', 'GE', 'Moore', 'mo+r']
];
const WAYS = {
  written: (ini) => ini.split('').map(c => c + '.').join(' '),
  bare: (ini) => ini.split('').join(' '),
  names: (ini) => ini.split('').map(c => LETTER[c]).join(' '),
  joined: (ini) => ini
};
const squash = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// What a recogniser may write for a letter it heard: the letter itself, or its name spelled out.
const HEARD = { a: '(a|ay|eh)', b: '(b|be|bee)', c: '(c|see|sea)', d: '(d|dee)', e: '(e|ee)', f: '(f|ef|eff)', g: '(g|gee|ji)', h: '(h|aitch|age|ach)', i: '(i|eye|ai)', j: '(j|jay)', k: '(k|kay)', l: '(l|el|ell)', m: '(m|em)', n: '(n|en)', o: '(o|oh)', p: '(p|pee|pe)', q: '(q|cue|queue)', r: '(r|ar|are)', s: '(s|es|ess)', t: '(t|tee|tea)', u: '(u|you|yu)', v: '(v|vee|ve)', w: '(w|doubleyou|doubleu|dubya)', x: '(x|ex)', y: '(y|why)', z: '(z|zee|zed)' };

(async () => {
  const seeds = Number(arg('seeds', 3)); const [part, parts] = String(arg('part', '0/1')).split('/').map(Number);
  const speed = 1.3; const sid = 5; const steps = 5;
  const Dsp = await import('../../docs/js/dsp.js');
  const Module = await loadSherpa();
  const tts = makeSupertonic(Module);
  const rec = makeRecognizer(Module, 'moonshine-base');
  const hear = (samples, rate) => { const s = resample(samples, rate, 16000); const p = new Float32Array(s.length + 6400); p.set(s, 3200); return transcribe(rec, p, 16000); };
  speak(tts, 'Ready.', { sid, speed: 1, steps: 3 });
  const rows = [];
  for (let n = 0; n < NAMES.length; n++) {
    if (n % parts !== part) continue;
    const [first, ini, rest, surnameRe] = NAMES[n];
    const pattern = new RegExp('writtenby' + squash(first) + ini.toLowerCase().split('').map(c => HEARD[c]).join('') + surnameRe);
    for (const [way, write] of Object.entries(WAYS)) {
      const name = `${first ? first + ' ' : ''}${write(ini)} ${rest}`;
      const text = `This book was written by ${name} in London.`;
      const takes = [];
      for (let k = 0; k < seeds; k++) {
        const raw = speak(tts, text, { sid, speed, steps, seed: 100 + k });
        const clip = Dsp.finishClip(raw.samples.slice(), raw.sampleRate, {});
        const heard = hear(clip.samples, raw.sampleRate);
        const sq = squash(heard);
        takes.push({ heard, sec: +(clip.samples.length / raw.sampleRate).toFixed(2), name: pattern.test(sq), frame: /^thisbookwaswrittenby/.test(sq) && /inlondon$/.test(sq) });
      }
      rows.push({ name: `${first ? first + ' ' : ''}${WAYS.written(ini)} ${rest}`, way, text, takes });
      console.log(`${way.padEnd(8)} ${name.padEnd(34)} ${takes.map(t => (t.name ? 'ok ' : 'NO ') + (t.frame ? '' : '(frame) ')).join(' ')}  ${takes[0].sec.toFixed(2)} s  | ${takes.map(t => t.heard.replace(/^This book was written by /i, '').replace(/ in London\.?$/i, '')).join(' | ')}`);
    }
  }
  const outFile = path.join(OUT, 'lab', `${arg('out', 'initials')}-${part}of${parts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), seeds, rows }, null, 1));
  for (const way of Object.keys(WAYS)) {
    const t = rows.filter(r => r.way === way).flatMap(r => r.takes);
    console.log(`${way}: name heard right in ${t.filter(x => x.name).length} of ${t.length} takes; rest of the sentence intact in ${t.filter(x => x.frame).length}; mean length ${(t.reduce((a, x) => a + x.sec, 0) / t.length).toFixed(2)} s`);
  }
  console.log('written ' + outFile);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
