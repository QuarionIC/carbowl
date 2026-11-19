// What happens to the voice between the page and the loudspeaker, on this computer.
// The recordings come from tools/exp/wasapi.cs (Windows' own copy of what it sends to the output).
//
//   node tools/exp/sound-path.mjs look <recording.wav>        what is in a recording: level over time, tone, left against right
//   node tools/exp/sound-path.mjs refs                        builds the test clips the page plays (downloads/out/lab/refs)
//   node tools/exp/sound-path.mjs compare <recording.wav>     lines every played clip up with what came out and measures the path
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav, rms, mid, side, correlation, bandLevels, envelope, locate, relate, damage, peaks, THIRD_OCTAVES, db, mean, sd, se, fmt } from './sound-lab.mjs';
import { resample, finishClip, speechLevel } from '../../docs/js/dsp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'downloads', 'out');
const LAB = path.join(OUT, 'lab');
const cmd = process.argv[2];
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };

function look (file) {
  const w = readWav(file); const [l, r] = [w.channels[0], w.channels[1] || w.channels[0]];
  const m = mid(l, r); const s = side(l, r);
  console.log(`${path.basename(file)}: ${(l.length / w.rate).toFixed(2)} s at ${w.rate} Hz, ${w.channels.length} channel(s)`);
  console.log(`level: left ${fmt(db(rms(l)))} dB, right ${fmt(db(rms(r)))} dB, middle ${fmt(db(rms(m)))} dB, difference between the two ${fmt(db(rms(s)))} dB; left/right correlation ${fmt(correlation(l, r), 3)}`);
  const env = envelope(m, w.rate, 500);
  console.log('level each half second (dB): ' + env.map(x => fmt(x, 0)).join(' '));
  const fine = envelope(m, w.rate, 20).filter(Number.isFinite).sort((a, b) => a - b);
  if (fine.length) console.log(`20 ms levels: quietest tenth ${fmt(fine[Math.floor(fine.length * 0.1)])} dB, median ${fmt(fine[fine.length >> 1])} dB, loudest tenth ${fmt(fine[Math.floor(fine.length * 0.9)])} dB`);
  const bands = bandLevels(m, w.rate);
  console.log('third-octave bands (Hz: dB): ' + THIRD_OCTAVES.map((f, i) => `${f}: ${fmt(bands[i], 0)}`).join(', '));
}

/** The clips the page plays: the saved model output (44.1 kHz), finished the way the app's worker finishes it. */
function refs () {
  const src = path.join(OUT, 'tts-supertonic-sid0-sp1-st5');
  const dir = path.join(LAB, 'refs'); fs.mkdirSync(dir, { recursive: true });
  const list = [];
  for (const f of fs.readdirSync(src).filter(x => x.endsWith('.wav')).sort()) {
    const w = readWav(path.join(src, f)); const raw = w.channels[0];
    const native = finishClip(new Float32Array(raw), w.rate, { outRate: 0 });      // loudness set, still at the model's rate
    const at48 = finishClip(new Float32Array(raw), w.rate, { outRate: 48000 });    // what the 0.3.4 worker hands a 48 kHz page
    const name = f.replace('.wav', '');
    fs.writeFileSync(path.join(dir, name + '.native.f32'), Buffer.from(native.samples.buffer, native.samples.byteOffset, native.samples.byteLength));
    fs.writeFileSync(path.join(dir, name + '.48k.f32'), Buffer.from(at48.samples.buffer, at48.samples.byteOffset, at48.samples.byteLength));
    const lv = speechLevel(at48.samples, 48000);
    list.push({ name, text: fs.readFileSync(path.join(src, name + '.txt'), 'utf8').trim(), nativeRate: native.sampleRate, nativeLength: native.samples.length, length48: at48.samples.length, seconds: +(at48.samples.length / 48000).toFixed(2), speechDb: +db(lv.rms).toFixed(1), peak: +lv.peak.toFixed(3) });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(list, null, 1));
  console.log(`${list.length} clips, ${list.reduce((a, c) => a + c.seconds, 0).toFixed(1)} s in all, written to ${dir}`);
  for (const c of list) console.log(`  ${c.name}: ${c.seconds} s, spoken parts ${c.speechDb} dB, peak ${c.peak}`);
}

const f32 = file => { const b = fs.readFileSync(file); return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2).slice(); };

/**
 * A programme for wasapi.cs PlayRecord: the same clips under several conditions in one take, so
 * that every comparison is between like and like.
 *   quiet        the clips with true silence between them
 *   bed          the same with the app's faint keep-awake noise under everything (as up to 0.3.4)
 *   bed alone    that noise by itself
 *   soft         one clip 12 and 24 dB down (what a lower Volume setting sends)
 */
function program (name) {
  const dir = path.join(LAB, 'refs'); const rate = 48000;
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const kind = arg('kind', 'main');
  if (kind !== 'main') {
    // 'levels': one clip at several levels, then candidate keep-awake signals by themselves.
    // 'short': two clips and the present keep-awake noise (for takes with the microphone open).
    const items = []; const spans = []; const chunks = []; let n = 0;
    const silence = sec => { n += Math.round(sec * rate); };
    const put = (label, clip, gainDb = 0, gap = 0.8) => {
      const x = f32(path.join(dir, clip + '.48k.f32')); const g = 10 ** (gainDb / 20);
      items.push({ label, clip, kind: '48k', gainDb, at: n / rate, length: x.length });
      chunks.push({ at: n, data: gainDb ? x.map(v => v * g) : x }); n += x.length; silence(gap);
    };
    let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const noise = (sec, amp, label, shape) => {
      const k = Math.round(sec * rate); const d = new Float32Array(k);
      if (shape === 'sine30') for (let i = 0; i < k; i++) d[i] = amp * Math.sin(2 * Math.PI * 30 * i / rate);
      else if (shape === 'low') { let y = 0; const a = Math.exp(-2 * Math.PI * 150 / rate); for (let i = 0; i < k; i++) { y = a * y + (1 - a) * (rnd() * 2 - 1); d[i] = y; } const r = Math.sqrt(d.reduce((s, v) => s + v * v, 0) / k); const want = amp / Math.sqrt(3); for (let i = 0; i < k; i++) d[i] *= want / r; } else if (shape === 'tick') { for (let i = 0; i < k; i += Math.round(rate / 4)) d[i] = amp; } else for (let i = 0; i < k; i++) d[i] = (rnd() * 2 - 1) * amp;
      const inDb = db(Math.sqrt(d.reduce((s, v) => s + v * v, 0) / k));
      spans.push({ label: `${label} (goes in at ${fmt(inDb, 1)} dB)`, from: n / rate + 0.6, to: n / rate + sec - 0.2, inDb });
      chunks.push({ at: n, data: d }); n += k; silence(0.6);
    };
    silence(2);
    if (kind === 'levels' || kind === 'beds') {
      const clip = arg('clip', '000');
      if (kind === 'levels') for (const g of [2.2, 0, -3, -6, -9, -12]) put(`level ${g > 0 ? '+' : ''}${g} dB`, clip, g);
      silence(1.2);
      spans.push({ label: 'silence', from: n / rate - 1.0, to: n / rate - 0.2 });
      noise(3, 0.00015, 'white noise, the present level', 'white');
      noise(3, 0.00005, 'white noise, 10 dB lower', 'white');
      noise(3, 0.000015, 'white noise, 20 dB lower', 'white');
      noise(3, 0.000005, 'white noise, 30 dB lower', 'white');
      noise(3, 0.00015, 'low rumble below 150 Hz, the present level', 'low');
      noise(3, 0.00015, '30 Hz tone, the present peak', 'sine30');
      noise(3, 1 / 32768, 'one smallest step four times a second', 'tick');
      if (kind === 'beds') { noise(3, 0.0001, '30 Hz tone at 0.0001', 'sine30'); noise(3, 0.00004, 'white noise at 0.00004', 'white'); }
    } else {
      for (const c of ['000', '005']) put('quiet', c, 0, 1.2);
      noise(3.5, 0.00015, 'white noise, the present level', 'white');
    }
    silence(0.8);
    const out = new Float32Array(n);
    for (const c of chunks) out.set(c.data, c.at);
    fs.writeFileSync(path.join(LAB, name + '.f32'), Buffer.from(out.buffer));
    fs.writeFileSync(path.join(LAB, name + '.plan.json'), JSON.stringify({ rate, seconds: n / rate, items, spans, texts: Object.fromEntries(index.map(c => [c.name, c.text])) }, null, 1));
    console.log(`${name}: ${(n / rate).toFixed(1)} s, ${items.length} clips, ${spans.length} stretches without speech`);
    return;
  }
  const clips = (arg('clips', '000,003,005,007')).split(',');
  const gap = Number(arg('gap', 1.5)); const bedAmp = Number(arg('bed', 0.00015));
  const items = []; const parts = []; let n = 0;
  const silence = sec => { const k = Math.round(sec * rate); parts.push({ at: n, data: null, len: k }); n += k; };
  const put = (label, clip, gainDb = 0) => {
    const x = f32(path.join(dir, clip + '.48k.f32')); const g = 10 ** (gainDb / 20);
    const d = gainDb ? x.map(v => v * g) : x;
    items.push({ label, clip, kind: '48k', gainDb, at: n / rate, length: d.length });
    parts.push({ at: n, data: d, len: d.length }); n += d.length; silence(gap);
  };
  const spans = [];
  silence(3);
  for (const c of clips) put('quiet', c);
  silence(2);
  const bedFrom = n;
  silence(4); // the noise alone first, so that its level before any speech can be read off
  for (const c of clips) put('bed', c);
  silence(4);
  const bedTo = n;
  spans.push({ label: 'bed alone, before speech', from: bedFrom / rate + 0.5, to: bedFrom / rate + 3.5 }, { label: 'bed alone, after speech', from: bedTo / rate - 3.5, to: bedTo / rate - 0.5 });
  spans.push({ label: 'silence at the start', from: 0.5, to: 2.5 });
  silence(2);
  put('soft -12 dB', clips[0], -12); put('soft -24 dB', clips[0], -24);
  silence(1);
  const out = new Float32Array(n);
  for (const p of parts) if (p.data) out.set(p.data, p.at);
  // The app's bed: uniform noise of +-0.00015, looped every two seconds.
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const loop = new Float32Array(rate * 2); for (let i = 0; i < loop.length; i++) loop[i] = (rnd() * 2 - 1) * bedAmp;
  for (let i = bedFrom; i < bedTo; i++) out[i] += loop[(i - bedFrom) % loop.length];
  fs.writeFileSync(path.join(LAB, name + '.f32'), Buffer.from(out.buffer));
  fs.writeFileSync(path.join(LAB, name + '.plan.json'), JSON.stringify({ rate, seconds: n / rate, bedAmp, items, spans, texts: Object.fromEntries(index.map(c => [c.name, c.text])) }, null, 1));
  console.log(`${name}: ${(n / rate).toFixed(1)} s, ${items.length} clips`);
}

/**
 * A recording against the plan that was played. The plan (written by the page, see the README) is
 * [{ label, clip, kind: 'native'|'48k', gain, at }]: label names the condition, `at` is the second,
 * on the page's clock, at which the clip started; the first entry lines the two clocks up.
 */
function compare (file) {
  const plan = JSON.parse(fs.readFileSync(arg('plan', file.replace(/\.wav$/, '.plan.json')), 'utf8'));
  const w = readWav(file); const [l, r] = [w.channels[0], w.channels[1] || w.channels[0]];
  const m = mid(l, r);
  const dir = path.join(LAB, 'refs');
  const refOf = new Map();
  const ref = p => {
    const key = p.clip + '|' + p.kind + '|' + (p.gainDb || 0);
    if (!refOf.has(key)) {
      let x = f32(path.join(dir, `${p.clip}.${p.kind}.f32`));
      if (p.kind === 'native') x = resample(x, 44100, w.rate);
      else if (w.rate !== 48000) x = resample(x, 48000, w.rate);
      if (p.gainDb) { const g = 10 ** (p.gainDb / 20); x = x.map(v => v * g); } // as it was played
      refOf.set(key, x);
    }
    return refOf.get(key);
  };
  const exportDir = arg('export', ''); const exported = [];
  // The first clip is found anywhere in the recording; the others near where the plan says they follow it.
  // A take without speech has nothing to line up on; the player starts 0.057 s into its own recording (measured on the other takes).
  const first = plan.items.length ? locate(m, ref(plan.items[0])) : { offset: Math.round(0.057 * w.rate), corr: NaN };
  const t0 = first.offset / w.rate - (plan.items.length ? plan.items[0].at : 0);
  const rows = [];
  for (const p of plan.items) {
    const x = ref(p);
    const guess = Math.round((t0 + p.at) * w.rate);
    const from = Math.max(0, guess - Math.round(0.5 * w.rate)); const to = Math.min(m.length, guess + x.length + Math.round(0.5 * w.rate));
    if (to - from < x.length) { rows.push({ ...p, missing: true }); continue; }
    const hit = locate(m, x, { from, to });
    const seg = m.subarray(hit.offset, hit.offset + x.length);
    const rel = relate(x, seg, w.rate);
    const lr = correlation(l, r, hit.offset, hit.offset + x.length);
    const sideDb = db(rms(side(l.subarray(hit.offset, hit.offset + x.length), r.subarray(hit.offset, hit.offset + x.length)))) - db(rms(seg));
    // Does the path change its gain with the level? Short-time level out minus in, for loud and for soft frames.
    const ein = envelope(x, w.rate, 20); const eout = envelope(seg, w.rate, 20);
    const top = Math.max(...ein); const loud = []; const soft = [];
    for (let i = 0; i < ein.length; i++) { const d = eout[i] - ein[i]; if (ein[i] > top - 10) loud.push(d); else if (ein[i] > top - 35 && ein[i] <= top - 20) soft.push(d); }
    const pin = peaks(x); const pout = peaks(seg);
    rows.push({ ...p, offset: hit.offset, startsAt: hit.offset / w.rate, drift: (hit.offset - guess) / w.rate, corr: hit.corr, gainDb: rel.gainDb, added: rel.added, coherence: rel.coherence, response: rel.response, lr, sideDb, loudGain: mean(loud), softGain: mean(soft), outLevel: db(rms(seg)), inLevel: db(rms(x)), damage: damage(x, seg, w.rate), outPeak: pout.peak, outCrest: pout.crestDb, inCrest: pin.crestDb, pinned: pout.pinned });
    if (exportDir) {
      fs.mkdirSync(exportDir, { recursive: true });
      const tag = `${p.label.replace(/[^a-z0-9.+-]+/gi, '_')}-${p.clip}`;
      writeWav(path.join(exportDir, tag + '.in.wav'), [x], w.rate); writeWav(path.join(exportDir, tag + '.out.wav'), [Float32Array.from(seg)], w.rate);
      exported.push({ tag, label: p.label, clip: p.clip, text: (plan.texts || {})[p.clip] || '' });
    }
  }
  if (exportDir) fs.writeFileSync(path.join(exportDir, 'index.json'), JSON.stringify(exported, null, 1));
  // Level between clips (the pauses), per condition.
  const labels = [...new Set(plan.items.map(p => p.label))];
  console.log(`${path.basename(file)}: ${(m.length / w.rate).toFixed(1)} s at ${w.rate} Hz; first clip found at ${fmt(first.offset / w.rate, 3)} s (match ${fmt(first.corr, 3)})`);
  for (const label of labels) {
    const rs = rows.filter(x => x.label === label && !x.missing);
    if (!rs.length) { console.log(`\n${label}: not found in the recording`); continue; }
    const col = k => rs.map(x => x[k]);
    console.log(`\n${label} (${rs.length} clips)`);
    console.log(`  match with what was played ${fmt(mean(col('corr')), 3)} (lowest ${fmt(Math.min(...col('corr')), 3)}); level change ${fmt(mean(col('gainDb')), 2)} dB (sd ${fmt(sd(col('gainDb')), 2)})`);
    console.log(`  added by the path, beyond a fixed change of tone: ${fmt(mean(col('added')), 1)} dB relative to the voice (se ${fmt(se(col('added')), 1)})`);
    console.log(`  damage to the waveform, beyond tone and a riding volume: ${fmt(mean(col('damage')), 1)} dB (se ${fmt(se(col('damage')), 1)}); level out ${fmt(mean(col('outLevel')), 1)} dB, peak ${fmt(Math.max(...col('outPeak')), 3)}, peaks stand ${fmt(mean(col('outCrest')), 1)} dB above the average (${fmt(mean(col('inCrest')), 1)} dB going in), ${fmt(100 * mean(col('pinned')), 3)}% of samples pinned at full scale`);
    console.log(`  gain for loud frames ${fmt(mean(col('loudGain')), 2)} dB, for soft frames ${fmt(mean(col('softGain')), 2)} dB (difference ${fmt(mean(rs.map(x => x.softGain - x.loudGain)), 2)} dB: above 0 means quiet parts are lifted)`);
    console.log(`  left against right: correlation ${fmt(mean(col('lr')), 3)}, difference signal ${fmt(mean(col('sideDb')), 1)} dB below the voice`);
    const resp = THIRD_OCTAVES.map((f, i) => mean(rs.map(x => x.response[i]).filter(Number.isFinite)));
    const ref1k = resp[THIRD_OCTAVES.indexOf(1000)];
    console.log('  tone (dB relative to 1 kHz): ' + THIRD_OCTAVES.map((f, i) => `${f >= 1000 ? f / 1000 + 'k' : f}: ${fmt(resp[i] - ref1k, 1)}`).join(', '));
    // Pauses: the stretch between one clip's end and the next one's start, when both belong to this condition.
    const pauses = [];
    for (let i = 0; i + 1 < rs.length; i++) {
      const a = rs[i].offset + ref(rs[i]).length + Math.round(0.08 * w.rate); const b = rs[i + 1].offset - Math.round(0.05 * w.rate);
      if (b - a > 0.1 * w.rate) pauses.push({ db: db(rms(m, a, b)), env: envelope(m, w.rate, 50, a, b) });
    }
    if (pauses.length) console.log(`  in the pauses between clips: ${fmt(mean(pauses.map(x => x.db)), 1)} dB (${pauses.length} pauses); 50 ms steps through the first: ${pauses[0].env.map(x => fmt(x, 0)).join(' ')}`);
  }
  // Stretches with no speech that the plan names (silence, the bed alone).
  for (const s of plan.spans || []) {
    const a = Math.round((t0 + s.from) * w.rate); const b = Math.round((t0 + s.to) * w.rate);
    if (a < 0 || b > m.length) continue;
    const bands = bandLevels(m, w.rate, a, b);
    console.log(`\n${s.label}: ${fmt(db(rms(m, a, b)), 1)} dB; half-second steps ${envelope(m, w.rate, 500, a, b).map(x => fmt(x, 0)).join(' ')}; bands 250 Hz ${fmt(bands[THIRD_OCTAVES.indexOf(250)], 0)}, 1k ${fmt(bands[THIRD_OCTAVES.indexOf(1000)], 0)}, 4k ${fmt(bands[THIRD_OCTAVES.indexOf(4000)], 0)}, 10k ${fmt(bands[THIRD_OCTAVES.indexOf(10000)], 0)}`);
  }
  fs.writeFileSync(file.replace(/\.wav$/, '.compare.json'), JSON.stringify(rows.map(x => ({ ...x, response: x.response && x.response.map(v => +fmt(v, 2)) })), null, 1));
}

if (cmd === 'look') look(process.argv[3]);
else if (cmd === 'program') program(process.argv[3]);
else if (cmd === 'refs') refs();
else if (cmd === 'compare') compare(process.argv[3]);
else { console.log('usage: node tools/exp/sound-path.mjs look|refs|compare ...'); process.exit(1); }
