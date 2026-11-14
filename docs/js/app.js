// Screen and wiring: settings, model download, starting the engines, and showing what the game does.

import { CATEGORY_TREE, DIFFICULTIES, ALL_ALTERNATES, defaultFilters, sanitizeFilters, QuestionFeed, MIN_YEAR, MAX_YEAR, activeCategories } from './qb.js';
import { safeAnswerHtml, escapeHtml, wordsOf } from './speechtext.js';
import { judgeAnswer } from './judge.js';
import { soundSimilarity } from './phonetics.js';
import checkAnswer from '../vendor/qb-answer-checker.js';
import { AudioEngine } from './audio.js';
import { Narrator } from './narrator.js';
import { Game, PHRASES, DEFAULT_RULES } from './game.js';
import { TtsClient, ListenClient, loadManifest, requiredFiles, cacheStatus, downloadModels, clearModelCache, VOICES, RECOGNIZERS } from './speech.js';

const VERSION = '0.1.0';
// ?test in the address swaps the microphone for a scripted one, so the whole loop can be exercised without sound hardware.
const TEST = new URLSearchParams(location.search).has('test');
const BASE = new URL('.', document.baseURI).href;
const $ = id => document.getElementById(id);
const app = $('app');

// ---------- persistence (per browser; everything falls back to defaults) ----------
const LS = {
  get (k, d) { try { const v = localStorage.getItem('cb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set (k, v) { try { localStorage.setItem('cb.' + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
  del (k) { try { localStorage.removeItem('cb.' + k); } catch (e) { /* ignore */ } }
};

// Reading speed is a multiple of the voice's natural pace. Earlier versions defaulted to 1.1 and
// then 1.65; the default is now 1.3.
const SPEED = { min: 0.8, max: 2, step: 0.05, nudge: 0.1, earlier: [1.1, 1.65], standard: 1.3, calm: 1.35 };
const clampSpeed = v => Math.min(SPEED.max, Math.max(SPEED.min, Math.round((Number(v) || SPEED.standard) / SPEED.step) * SPEED.step));
const DEFAULTS = {
  settingsVersion: 3,
  filters: defaultFilters(),
  rules: { ...DEFAULT_RULES },
  voice: 'supertonic', sid: 5, speed: SPEED.standard, calmAnswers: true, steps: 5, volume: 1,
  asr: 'moonshine-base', vadThreshold: 0.5, leniency: 0.8,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, micId: '',
  showText: true
};
function loadSettings () {
  const s = LS.get('settings', {}) || {};
  const out = { ...DEFAULTS, ...s, rules: { ...DEFAULTS.rules, ...(s.rules || {}) }, filters: sanitizeFilters(s.filters) };
  // Settings saved by an earlier version carry that version's default speed; move those to the
  // current default once. A speed the listener chose for themselves is left alone.
  if ((s.settingsVersion || 1) < DEFAULTS.settingsVersion && (s.speed === undefined || SPEED.earlier.some(v => Math.abs(s.speed - v) < 0.001))) out.speed = SPEED.standard;
  out.settingsVersion = DEFAULTS.settingsVersion;
  out.speed = +clampSpeed(out.speed).toFixed(2);
  if (!VOICES[out.voice]) out.voice = DEFAULTS.voice;
  if (!RECOGNIZERS[out.asr]) out.asr = DEFAULTS.asr;
  out.sid = Math.min(VOICES[out.voice].speakers - 1, Math.max(0, out.sid | 0));
  return out;
}
const settings = loadSettings();
const saveSettings = () => LS.set('settings', settings);

// ---------- log (kept in memory; copied out from Settings for troubleshooting) ----------
const logLines = [];
window.carbowlLog = logLines;
const t0 = performance.now();
function log (msg) {
  const line = `${((performance.now() - t0) / 1000).toFixed(2).padStart(8)}  ${msg}`;
  logLines.push(line); if (logLines.length > 900) logLines.splice(0, 200);
  const pre = $('logView'); if (pre && pre.isConnected && !pre.hidden) { pre.textContent = logLines.slice(-120).join('\n'); pre.scrollTop = pre.scrollHeight; }
}
window.addEventListener('error', e => log('page error: ' + (e.message || e)));
window.addEventListener('unhandledrejection', e => log('unhandled: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

let toastT;
function toast (msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const mb = bytes => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';

// ---------- engines ----------
const audio = new AudioEngine({ log });
const feed = new QuestionFeed({ store: LS, log: (m, d) => log(m + (d ? ' ' + JSON.stringify(d) : '')) });
feed.setFilters(settings.filters);
let manifest = null; let tts = null; let listener = null; let narrator = null; let game = null;
let phase = 'boot';            // boot | setup | downloading | loading | ready | running | error
let enginesFor = '';           // "voice|asr" the running workers were built for
let wakeLock = null; let autoPaused = false; let lastRec = null;
const view = { rec: null, part: -1, offset: 0, buzzed: false };

function setPhase (p) { phase = p; app.dataset.phase = p === 'downloading' ? 'setup' : p; renderMain(); }
const voiceParams = () => ({ sid: settings.sid, speed: settings.speed, steps: settings.steps });
const judge = (answerline, transcripts, previous) => judgeAnswer({ answerline, transcripts, previous, checkAnswer, threshold: settings.leniency });

async function boot () {
  log(`Carbowl ${VERSION}; ${navigator.userAgent}`);
  restoreHistory();
  buildSettings(); renderScore(); renderMain(); renderSpeed();
  if ('serviceWorker' in navigator && !TEST) navigator.serviceWorker.register('sw.js').catch(e => log('offline support not installed: ' + e.message));
  try { manifest = await loadManifest(BASE); } catch (e) { return fail('Could not load the app files. Check the connection and reload.', e); }
  // Only offer voices and recognisers that this copy of the site actually ships.
  for (const k of Object.keys(VOICES)) if (!VOICES[k].bundles.every(b => manifest.bundles[b])) delete VOICES[k];
  for (const k of Object.keys(RECOGNIZERS)) if (!RECOGNIZERS[k].bundles.every(b => manifest.bundles[b])) delete RECOGNIZERS[k];
  if (!VOICES[settings.voice]) { settings.voice = Object.keys(VOICES)[0]; settings.sid = settings.voice === 'supertonic' ? DEFAULTS.sid : 0; }
  if (!RECOGNIZERS[settings.asr]) settings.asr = Object.keys(RECOGNIZERS)[0];
  buildSettings();
  await checkSetup();
}

function fail (text, e) { log('error: ' + text + (e ? ' :: ' + (e.message || e) : '')); $('status').textContent = text; setPhase('error'); }

async function checkSetup () {
  const files = requiredFiles(manifest, settings);
  const st = await cacheStatus(BASE, files);
  log(`models: ${mb(st.have)} of ${mb(st.total)} on this device` + (st.cacheAvailable ? '' : ' (no cache storage: files will download each visit)'));
  if (st.missing.length && st.cacheAvailable) {
    setPhase('setup');
    $('setup').hidden = false; $('setupBar').hidden = true;
    $('setupTitle').textContent = st.have ? 'Finish downloading the speech models' : 'Download the speech models';
    $('setupText').textContent = `Carbowl reads and listens on this device, so it needs its voice and speech recognition files once: ${mb(st.total - st.have)}. Wi-Fi recommended.`;
    $('setupFine').textContent = `Voice: ${VOICES[settings.voice].label}. Recognition: ${RECOGNIZERS[settings.asr].label}. Change these in Settings for a smaller download.`;
    $('setupBtn').hidden = false; $('setupBtn').textContent = `Download ${mb(st.total - st.have)}`;
    $('status').textContent = 'One-time setup';
    return;
  }
  await startEngines();
}

async function runDownload () {
  const files = requiredFiles(manifest, settings);
  setPhase('downloading');
  $('setupBtn').hidden = true; $('setupBar').hidden = false; $('status').textContent = 'Downloading…';
  try {
    await downloadModels(BASE, files, { onProgress: (done, total) => { $('setupFill').style.width = (100 * done / total).toFixed(1) + '%'; $('setupFine').textContent = `${mb(done)} of ${mb(total)}`; } });
    log('models downloaded');
    $('setup').hidden = true;
    await startEngines();
  } catch (e) {
    log('download failed: ' + e.message);
    $('setupBtn').hidden = false; $('setupBtn').textContent = 'Try again'; $('setupFine').textContent = 'The download stopped: ' + e.message; $('status').textContent = 'Download interrupted';
    setPhase('setup');
  }
}

/** Starts both speech workers. Needs no tap; the microphone and sound are opened later, on Start. */
async function startEngines () {
  $('setup').hidden = true;
  setPhase('loading'); $('status').textContent = 'Getting ready…';
  // If a previous attempt died while loading (the page ran out of memory), fall back to the light recogniser.
  const crashed = LS.get('loading', null);
  if (crashed && Date.now() - crashed.at < 10 * 60000 && crashed.asr === 'moonshine-base' && settings.asr === 'moonshine-base') {
    log('the last start did not finish; switching to the light recognition model');
    settings.asr = 'moonshine-tiny'; saveSettings(); LS.del('loading'); buildSettings();
    toast('Switched to the light recognition model after a failed start.', 5000);
    return checkSetup();
  }
  LS.set('loading', { at: Date.now(), asr: settings.asr });
  if (tts) tts.terminate(); if (listener) listener.terminate();
  tts = new TtsClient({ base: BASE, log }); listener = new ListenClient({ base: BASE, log });
  const started = performance.now();
  try {
    // One after the other, not together: each model is briefly held in memory two or three times
    // over while it loads, and a phone has room for one such peak at a time.
    $('status').textContent = 'Getting ready… 1 of 2';
    const b = await listener.init({ manifest, asr: settings.asr, vadThreshold: settings.vadThreshold });
    $('status').textContent = 'Getting ready… 2 of 2';
    const a = await tts.init({ manifest, voice: settings.voice });
    log(`speech ready in ${a.initMs} ms (${a.voice}, ${a.sampleRate} Hz, heap ${a.heapMiB} MiB); listening ready in ${b.initMs} ms (${b.asr}, heap ${b.heapMiB} MiB); total ${Math.round(performance.now() - started)} ms`);
  } catch (e) {
    LS.del('loading');
    return fail('The speech models could not start on this device. Try the light recognition model in Settings.', e);
  }
  LS.del('loading');
  enginesFor = `${settings.voice}|${settings.asr}`;
  narrator = new Narrator({ tts, audio, voice: voiceParams, phraseCap: () => settings.calmAnswers ? SPEED.calm : null, log });
  listener.addEventListener('level', e => onLevel(e.detail));
  tts.addEventListener('crash', () => fail('The voice stopped unexpectedly. Reload the page.'));
  listener.addEventListener('crash', () => fail('Listening stopped unexpectedly. Reload the page.'));
  setPhase('ready'); $('status').textContent = 'Ready';
  preparePhrases();
}

/** Pre-generates the fixed phrases and checks each one by ear (synthesise, transcribe, compare). */
async function preparePhrases () {
  const my = enginesFor + '|' + JSON.stringify(narrator._voice('phrase'));
  if (preparePhrases.token === my) return; // already prepared (or being prepared) for this voice and pace
  preparePhrases.token = my;
  const phrases = Object.values(PHRASES);
  let fixed = 0;
  for (const text of phrases) {
    if (preparePhrases.token !== my) return; // settings changed; a newer pass is running
    try {
      const v = narrator._voice('phrase');
      let audioClip = await narrator.synth(text, { priority: 8, pin: true, kind: 'phrase' });
      if (phase === 'running') continue; // never compete with a live game for the recogniser
      for (const tweak of [0.95, 1.06]) {
        if (await soundsRight(text, audioClip)) break;
        const alt = await tts.speak(text, { ...v, speed: +(v.speed * tweak).toFixed(3), priority: 8 }).promise;
        if (await soundsRight(text, alt)) { narrator.cache.set(narrator._key(text, v), Promise.resolve(alt)); audioClip = alt; fixed++; break; }
      }
    } catch (e) { log(`phrase "${text}" not prepared: ${e.message}`); }
  }
  log(`fixed phrases prepared (${phrases.length}; ${fixed} re-voiced after the listening check); speech speed factor ${tts.realTimeFactor.toFixed(2)}`);
}
async function soundsRight (text, clip) {
  if (!listener || !clip || !clip.samples.length) return false;
  const r = await listener.transcribe(clip.samples, clip.sampleRate);
  const heard = wordsOf(r.text); const want = wordsOf(text).filter(w => w.length >= 4);
  if (!want.length) return true;
  const hit = want.filter(w => heard.some(h => soundSimilarity(w, h).score >= 0.7)).length;
  return hit / want.length >= 0.7;
}

/** Stand-in microphone for self-tests: streams silence in real time and mixes in queued speech. */
class FakeMic {
  constructor () { this.queue = []; this.sent = 0; this.t0 = 0; this.timer = null; }
  start () { if (this.timer) return; this.t0 = audio.time; this.sent = 0; this.timer = setInterval(() => this.tick(), 20); }
  stop () { clearInterval(this.timer); this.timer = null; }
  say (samples16k) { this.queue.push({ s: samples16k, at: 0 }); }
  tick () {
    const want = Math.floor((audio.time - this.t0) * 16000 / 640);
    while (this.sent < want) {
      const frame = new Float32Array(640);
      for (let i = 0; i < 640; i++) frame[i] = (Math.random() * 2 - 1) * 0.0008;
      let i = 0;
      while (i < 640 && this.queue.length) { const q = this.queue[0]; const n = Math.min(640 - i, q.s.length - q.at); for (let k = 0; k < n; k++) frame[i + k] += q.s[q.at + k]; q.at += n; i += n; if (q.at >= q.s.length) this.queue.shift(); }
      this.sent++;
      listener.feed(frame, this.t0 + this.sent * 640 / 16000);
    }
  }
}
let fakeMic = null;
async function to16k (clip) {
  const n = Math.ceil(clip.samples.length * 16000 / clip.sampleRate);
  const off = new OfflineAudioContext(1, n, 16000);
  const buf = off.createBuffer(1, clip.samples.length, clip.sampleRate); buf.getChannelData(0).set(clip.samples);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
/** Test hook: speaks text into the stand-in microphone with one of the synthetic voices. */
async function speakAsUser (text, { sid = 2, speed = 1, level = 0.5 } = {}) {
  const clip = await tts.speak(text, { sid, speed, steps: 5, priority: 0 }).promise;
  const s = await to16k(clip);
  for (let i = 0; i < s.length; i++) s[i] *= level;
  fakeMic.say(s);
  return s.length / 16000;
}

// ---------- start / stop ----------
async function start () {
  if (phase !== 'ready') return;
  $('status').textContent = 'Starting…';
  let micOk = true;
  const constraints = { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl };
  if (settings.micId) constraints.deviceId = { exact: settings.micId };
  try {
    await audio.start({ mic: !TEST, constraints });
    if (TEST) { fakeMic = fakeMic || new FakeMic(); fakeMic.start(); log('test mode: scripted microphone'); }
  } catch (e) {
    micOk = false;
    log('microphone not available: ' + (e.name || '') + ' ' + e.message);
    if (settings.micId) { settings.micId = ''; saveSettings(); }
    try { await audio.start({ mic: false }); } catch (e2) { return fail('Sound could not start. Reload and tap Start again.', e2); }
    toast('No microphone access: tap the big button to buzz, and mark answers yourself.', 6000);
  }
  audio.setVolume(settings.volume);
  if (micOk && !TEST) audio.setSink(listener.createAudioPort());
  if (micOk) { $('mic').classList.add('on'); $('micLabel').textContent = TEST ? 'Scripted microphone (test)' : (audio.micInfo.label || 'Microphone on'); }
  log(`audio: ${audio.sampleRate} Hz, state ${audio.state}, output latency ${Math.round((audio.latency || 0) * 1000)} ms; mic ${micOk ? JSON.stringify(audio.micInfo) : 'none'}`);
  await requestWakeLock();
  game = new Game({
    feed, narrator, listener, audio, judge,
    rules: () => ({ ...settings.rules, ...(micOk ? {} : { buzzSensitivity: 'off', selfJudge: true }) }),
    ui: { onState, onQuestion, onProgress, onPart, onHeard, onResult, onAnswer, onScore: renderScore, onCommand: cmd => { if (cmd === 'faster' || cmd === 'slower') { audio.tone('tick'); nudgeSpeed(cmd === 'faster' ? 1 : -1); } }, onError: e => toast('Something went wrong: ' + (e.message || e)) },
    log
  });
  game.verify = async clip => { if (!listener || listener.mode === 'answer') return null; const r = await listener.transcribe(clip.samples, clip.sampleRate); return r.text; };
  game.history = sessionHistory;
  window.carbowl = { game, audio, narrator, listener, tts, feed, settings, log: logLines, fakeMic, speakAsUser };
  setPhase('running');
  game.run().then(() => { saveHistory(); if (phase === 'running') { setPhase('ready'); $('status').textContent = 'Stopped'; } releaseWakeLock(); });
}

async function requestWakeLock () {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => log('screen wake lock released')); log('screen wake lock held'); } else log('no wake lock support: keep the screen from locking in Settings > Display'); } catch (e) { log('wake lock refused: ' + e.message); }
}
function releaseWakeLock () { try { if (wakeLock) wakeLock.release(); } catch (e) { /* already released */ } wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  log('page ' + document.visibilityState);
  if (document.visibilityState === 'hidden') {
    if (phase === 'running' && game && !TEST) { autoPaused = true; game.requestPause(); }
  } else {
    if (phase === 'running') { requestWakeLock(); audio.resume(); }
  }
});
audio.addEventListener('state', e => {
  if (phase !== 'running' || !game) return;
  if (e.detail !== 'running' && !game.paused) { autoPaused = true; game.requestPause(); toast('Sound was interrupted. Tap Resume when ready.', 5000); }
});
audio.addEventListener('mic', async e => {
  if (e.detail !== 'ended' || phase !== 'running') return;
  try {
    await audio.reopenMic({ constraints: { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl } });
    audio.setSink(listener.createAudioPort());
    log('microphone reopened after it ended');
  } catch (err) { log('could not reopen the microphone: ' + err.message); toast('The microphone dropped out. Tap to buzz, or End and Start again.', 6000); }
});

// ---------- session history ----------
const sessionHistory = [];
/** After a reload (iOS discards background tabs), carry on with the same score if the session is recent. */
function restoreHistory () {
  const last = LS.get('lastSession', null);
  if (!last || !Array.isArray(last.items) || Date.now() - last.at > 6 * 3600 * 1000) return;
  for (const h of last.items) {
    if (!h || (h.type !== 'tossup' && h.type !== 'bonus')) continue;
    sessionHistory.push({ ...h, parts: h.parts || [], q: { set: { name: h.set || '' }, category: h.cat || '' } });
  }
  if (sessionHistory.length) log(`restored ${sessionHistory.length} questions from the session that was open earlier`);
}
function saveHistory () {
  const slim = sessionHistory.slice(-200).map(h => h.type === 'tossup'
    ? { type: 'tossup', id: h.id, result: h.result, points: h.points, heard: h.heard, answer: h.answer, text: h.text, at: h.at, buzzOffset: h.buzzOffset, powerOffset: h.powerOffset, set: h.q && h.q.set && h.q.set.name, cat: h.q && h.q.category }
    : { type: 'bonus', id: h.id, result: h.result, points: h.points, at: h.at, leadin: h.leadin, parts: (h.parts || []).map(p => ({ text: p.text, answer: p.answer, result: p.result, points: p.points, heard: p.heard })), set: h.q && h.q.set && h.q.set.name, cat: h.q && h.q.category });
  LS.set('lastSession', { at: Date.now(), items: slim });
}

// ---------- rendering: main screen ----------
const STATUS = {
  idle: 'Ready', starting: 'Starting…', offline: 'Waiting for a connection…', empty: 'No questions match', between: '', result: '', paused: 'Paused'
};
function onState (state, extra = {}) {
  app.dataset.state = state;
  if (state === 'reading') { app.dataset.result = ''; $('status').textContent = extra.repeat ? 'Reading again…' : (extra.type === 'bonus' ? (extra.part >= 0 ? `Bonus, part ${extra.part + 1}` : 'Bonus') : 'Tossup'); if (!extra.rest && !extra.repeat) { $('answer').hidden = true; $('heard').textContent = ''; } } else if (state === 'waiting') $('status').textContent = view.rec && view.rec.type === 'bonus' ? 'Your answer?' : 'Buzz?';
  else if (state === 'answering') $('status').textContent = 'Listening…';
  else if (state === 'judging') $('status').textContent = 'Were you right?';
  else if (STATUS[state] !== undefined && STATUS[state] !== '') $('status').textContent = STATUS[state];
  if (state === 'idle') { $('mic').classList.remove('on', 'speaking'); $('micLabel').textContent = 'Microphone off'; }
  renderMain();
}

function difficultyLabel (d) { const x = DIFFICULTIES.find(v => v.value === d); return x ? (x.dots ? '●'.repeat(x.dots) : x.short) : ''; }
function onQuestion (rec) {
  view.rec = rec; view.part = -1; view.offset = 0; view.buzzed = false; lastRec = rec;
  const q = rec.q || {};
  const n = (game ? game.count[rec.type] : 0) + 1;
  $('meta').textContent = [`${rec.type === 'bonus' ? 'Bonus' : 'Tossup'} ${n}`, q.subcategory && q.subcategory !== q.category ? q.subcategory : q.category, q.set && q.set.name, difficultyLabel(q.difficulty)].filter(Boolean).join(' · ');
  // For troubleshooting: which question, and how the voice is doing on this device right now.
  if (narrator && tts) { const v = narrator._voice(); log(`${rec.type} ${n} (${rec.id}): reading at ${v.speed}x, voice quality ${v.steps}${v.steps !== settings.steps ? ' (lowered from ' + settings.steps + ')' : ''}, speech speed factor ${tts.realTimeFactor.toFixed(2)}`); }
  $('answer').hidden = true; $('answer').innerHTML = ''; $('heard').textContent = '';
  app.dataset.result = '';
  $('progress').hidden = false; $('progressFill').style.width = '0%';
  const pm = $('powerMark');
  if (rec.type === 'tossup' && rec.powerOffset >= 0 && rec.text.length) { pm.hidden = false; pm.style.left = (100 * rec.powerOffset / rec.text.length).toFixed(1) + '%'; } else pm.hidden = true;
  renderText();
  $('stage').scrollTop = 0;
  renderMain();
}
function onPart (rec, i) { view.part = i; view.offset = 0; renderText(); }
function onProgress (offset, total, buzzed, part) {
  if (part !== undefined) view.part = part;
  view.offset = offset; if (buzzed) view.buzzed = true;
  $('progressFill').style.width = (total ? 100 * offset / total : 0).toFixed(1) + '%';
  renderText();
}
function renderText () {
  const el = $('qtext'); const rec = view.rec;
  if (!rec || !settings.showText) { el.textContent = ''; return; }
  const split = (text, off) => `${escapeHtml(text.slice(0, off))}<span class="unread">${escapeHtml(text.slice(off))}</span>`;
  if (rec.type === 'tossup') {
    const done = rec.result !== null && rec.result !== undefined;
    let off = done ? rec.text.length : view.offset;
    // Never cut a word in half on screen.
    while (off < rec.text.length && off > 0 && /\S/.test(rec.text[off]) && /\S/.test(rec.text[off - 1])) off++;
    el.innerHTML = split(rec.text, off);
  } else {
    let html = rec.leadin ? `<span class="lead">${view.part === -1 ? split(rec.leadin, view.offset) : escapeHtml(rec.leadin)}</span>` : '';
    rec.parts.forEach((p, i) => {
      if (i > view.part) return;
      const done = p.result !== null || i < view.part;
      let off = done ? p.text.length : view.offset;
      while (off < p.text.length && off > 0 && /\S/.test(p.text[off]) && /\S/.test(p.text[off - 1])) off++;
      html += `<span class="part">${split(p.text, off)}</span>`;
    });
    el.innerHTML = html;
  }
  const stage = $('stage');
  const spans = el.querySelectorAll('.unread'); const lastUnread = spans[spans.length - 1];
  if (lastUnread) { const r = lastUnread.getBoundingClientRect(); const s = stage.getBoundingClientRect(); if (r.top > s.bottom - 40) stage.scrollTop += r.top - s.bottom + 80; }
}
function onHeard (text, flag) {
  $('heard').innerHTML = text === '…' ? 'Hearing you…' : `Heard: <b>${escapeHtml(text)}</b>${flag === 'ignored' ? ' (not a buzz)' : ''}`;
}
function resultWord (rec, part) {
  if (rec.type === 'tossup') return { power: ['Correct, power · +15', 'good'], ten: ['Correct · +10', 'good'], neg: ['Incorrect · −5', 'bad'], wrong: ['Incorrect', 'bad'], dead: ['Time', 'time'], skipped: ['Skipped', 'time'] }[rec.result] || ['', ''];
  const p = rec.parts[part];
  if (!p) return [`Bonus: ${rec.points} points`, rec.points ? 'good' : 'time'];
  return { correct: ['Correct · +10', 'good'], wrong: ['Incorrect', 'bad'], none: ['Time', 'time'] }[p.result] || ['', ''];
}
function onResult (rec, part) {
  if (rec !== view.rec) { renderMain(); return; }
  let word = ''; let kind = '';
  if (rec.type === 'tossup') [word, kind] = resultWord(rec);
  else if (part !== undefined) [word, kind] = resultWord(rec, part);
  else if (rec.result === 'skipped') [word, kind] = ['Skipped', 'time'];
  else if (rec.parts.length && rec.parts.every(p => p.result !== null)) [word, kind] = [`Bonus: ${rec.points} points`, rec.points ? 'good' : 'time'];
  if (word) { $('status').textContent = word; app.dataset.result = kind; }
  renderText(); renderMain();
}
function onAnswer (rec, part) {
  if (rec !== view.rec) return;
  const html = rec.type === 'tossup' ? rec.answer : (rec.parts[part] || {}).answer;
  if (!html) return;
  $('answer').innerHTML = `<small>Answer</small>${safeAnswerHtml(html)}`;
  $('answer').hidden = false;
  const stage = $('stage'); stage.scrollTop = stage.scrollHeight;
}
function renderScore () {
  const s = game ? game.score() : scoreOf(sessionHistory);
  const el = $('score');
  if (!s.tossups && !s.bonuses) { el.textContent = ''; return; }
  const parts = [];
  if (s.tossups) parts.push(`TU <b>${s.powers + s.tens}/${s.tossups}</b>${s.negs ? ` −${s.negs}` : ''}`);
  if (s.bonuses) parts.push(`PPB <b>${s.ppb.toFixed(1)}</b>`);
  parts.push(`<b>${s.points}</b> pts`);
  el.innerHTML = parts.join(' · ');
  saveHistory();
}
function scoreOf (history) { const g = new Game({ feed: {}, narrator: {}, listener: new EventTarget(), audio: {}, judge }); g.history = history; return g.score(); }

function renderMain () {
  const main = $('btnMain'); const st = app.dataset.state;
  const running = phase === 'running';
  let label = 'Start'; let hint = ''; let enabled = phase === 'ready';
  if (phase === 'boot' || phase === 'loading') { label = 'Getting ready'; enabled = false; } else if (phase === 'setup' || phase === 'downloading') { label = 'Start'; enabled = false; } else if (phase === 'error') { label = 'Reload'; enabled = true; } else if (running) {
    enabled = true;
    if (st === 'paused') { label = 'Resume'; hint = 'or say “resume”'; } else if (st === 'judging') { label = 'I was right'; hint = 'or tap “I was wrong”'; } else if (st === 'answering') { label = 'Done'; hint = 'tap when you have answered'; } else if (st === 'reading' || st === 'waiting') { label = 'Buzz'; hint = view.rec && view.rec.type === 'bonus' ? 'or just say your answer' : 'or say “buzz”'; } else if (st === 'between' || st === 'result') { label = 'Next'; hint = 'or wait'; } else { label = '…'; enabled = false; }
  } else if (phase === 'ready') hint = sessionHistory.length ? 'continue' : 'tap once; then it is hands-free';
  main.innerHTML = `${label}${hint ? `<small>${hint}</small>` : ''}`;
  main.disabled = !enabled;
  $('btnPause').textContent = st === 'paused' ? 'Resume' : 'Pause';
  const rec = lastRec; const judged = running && rec && (st === 'between' || st === 'result' || st === 'reading' || st === 'waiting');
  let canRight = false; let canWrong = false;
  if (judged && rec.type === 'tossup' && rec.result && rec.result !== 'skipped') { canRight = rec.result !== 'power' && rec.result !== 'ten' && rec.buzzOffset !== null; canWrong = rec.result === 'power' || rec.result === 'ten'; } else if (judged && rec.type === 'bonus') { const done = rec.parts.filter(p => p.result !== null); const last = done[done.length - 1]; if (last) { canRight = last.result !== 'correct'; canWrong = last.result === 'correct'; } }
  if (running && st === 'judging') { canRight = false; canWrong = true; }
  $('btnRight').hidden = !canRight; $('btnWrong').hidden = !canWrong;
}

// ---------- reading speed (on-screen stepper, Settings slider, and "read faster" / "read slower") ----------
let phraseTimer = null;
function setSpeed (v, { quiet = false } = {}) {
  const next = +clampSpeed(v).toFixed(2);
  const changed = next !== settings.speed;
  settings.speed = next; saveSettings();
  renderSpeed();
  if (changed && !quiet) toast(`Reading speed ${next.toFixed(2)}×`, 1400);
  // Verdict phrases are prepared ahead for the current pace; redo them once the listener stops adjusting.
  clearTimeout(phraseTimer);
  phraseTimer = setTimeout(() => { if (narrator && phase === 'ready') preparePhrases(); }, 1500);
  return next;
}
function nudgeSpeed (direction) { return setSpeed(settings.speed + direction * SPEED.nudge); }
function renderSpeed () {
  $('speedNow').textContent = settings.speed.toFixed(2) + '×';
  $('speedDown').disabled = settings.speed <= SPEED.min + 1e-6; $('speedUp').disabled = settings.speed >= SPEED.max - 1e-6;
  const slider = $('s-speed'); if (slider) { slider.value = settings.speed; const out = $('settingsBody').querySelector('output[data-for="speed"]'); if (out) out.textContent = settings.speed + '×'; }
}
$('speedDown').addEventListener('click', () => nudgeSpeed(-1));
$('speedUp').addEventListener('click', () => nudgeSpeed(1));

function onLevel (l) {
  const db = 20 * Math.log10(Math.max(1e-5, l.rms));
  $('meterFill').style.width = Math.max(0, Math.min(100, (db + 60) * (100 / 54))).toFixed(0) + '%';
  $('mic').classList.toggle('speaking', !!l.speaking);
}

// ---------- controls ----------
$('btnMain').addEventListener('click', () => {
  if (phase === 'error') { location.reload(); return; }
  if (phase === 'ready') { start(); return; }
  if (phase !== 'running' || !game) return;
  const st = app.dataset.state;
  if (st === 'paused') { autoPaused = false; audio.resume(); game.act('resume'); } else if (st === 'judging') game.act('right');
  else if (st === 'between' || st === 'result') game.act('next');
  else game.act('buzz');
});
$('btnPause').addEventListener('click', () => { if (!game) return; if (game.paused) { autoPaused = false; audio.resume(); game.act('resume'); } else game.requestPause(); });
$('btnSkip').addEventListener('click', () => { if (game) game.act(app.dataset.state === 'between' || app.dataset.state === 'result' ? 'next' : 'skip'); });
$('btnStop').addEventListener('click', () => { if (game) game.stop(); });
function overrideLast (right) {
  if (!game || !lastRec) return;
  const st = app.dataset.state;
  if (st === 'between' || st === 'judging') { game.act(right ? 'right' : 'wrong'); return; }
  if (game.override(lastRec, right)) { toast(right ? 'Marked correct' : 'Marked incorrect'); renderMain(); }
}
$('btnRight').addEventListener('click', () => overrideLast(true));
$('btnWrong').addEventListener('click', () => overrideLast(false));
$('setupBtn').addEventListener('click', runDownload);
document.addEventListener('keydown', e => { if (e.target.closest('dialog,input,select,textarea')) return; if (e.code === 'Space') { e.preventDefault(); $('btnMain').click(); } else if (e.key === 'p') $('btnPause').click(); else if (e.key === 's') $('btnSkip').click(); });

// ---------- settings ----------
const get = path => path.split('.').reduce((o, k) => o[k], settings);
function set (path, value) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((o, k) => o[k], settings)[last] = value; saveSettings(); }
const sw = (path, label, note = '') => `<label class="field"><span>${label}${note ? `<small>${note}</small>` : ''}</span><input class="switch" type="checkbox" id="s-${path.replace(/\./g, '-')}" data-k="${path}" ${get(path) ? 'checked' : ''}></label>`;
const sel = (path, label, options, note = '') => `<label class="field"><span>${label}${note ? `<small>${note}</small>` : ''}</span><select id="s-${path.replace(/\./g, '-')}" data-k="${path}">${options.map(([v, t]) => `<option value="${escapeHtml(String(v))}" ${String(get(path)) === String(v) ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></label>`;
const rng = (path, label, min, max, step, unit = '', note = '') => `<label class="field"><span>${label}${note ? `<small>${note}</small>` : ''}</span><input type="range" id="s-${path.replace(/\./g, '-')}" data-k="${path}" data-num="1" min="${min}" max="${max}" step="${step}" value="${get(path)}"><output data-for="${path}" data-unit="${unit}">${get(path)}${unit}</output></label>`;

function buildSettings () {
  const f = settings.filters;
  const cats = CATEGORY_TREE.map(c => {
    const on = c.subs.filter(s => f.subs.includes(s)).length;
    const single = c.subs.length === 1 && !c.alts.length;
    const subs = c.subs.length > 1 ? `<div class="chips">${c.subs.map(s => `<label class="chip"><input type="checkbox" id="sub-${s.replace(/\W+/g, '-')}" data-sub="${escapeHtml(s)}" ${f.subs.includes(s) ? 'checked' : ''}>${escapeHtml(s)}</label>`).join('')}</div>` : '';
    const alts = c.alts.length ? `<p>Also narrow by</p><div class="chips">${c.alts.map(a => `<label class="chip"><input type="checkbox" id="alt-${a.replace(/\W+/g, '-')}" data-alt="${escapeHtml(a)}" ${f.alts.includes(a) ? 'checked' : ''}>${escapeHtml(a)}</label>`).join('')}</div>` : '';
    return `<details class="cat${single ? ' single' : ''}" data-cat="${escapeHtml(c.name)}"><summary><input type="checkbox" id="cat-${c.name.replace(/\W+/g, '-')}" data-catbox="${escapeHtml(c.name)}" ${on ? 'checked' : ''} aria-label="${escapeHtml(c.name)}"><b>${escapeHtml(c.name)}</b>${c.subs.length > 1 ? `<small>${on}/${c.subs.length}</small>` : ''}</summary>${single ? '' : `<div class="in">${subs}${alts}</div>`}</details>`;
  }).join('');
  const diffs = DIFFICULTIES.map(d => `<label class="chip"><input type="checkbox" id="diff-${d.value}" data-diff="${d.value}" ${f.difficulties.includes(d.value) ? 'checked' : ''}>${d.dots ? `<span class="dots">${'●'.repeat(d.dots)}</span>` : ''}${escapeHtml(d.label)}<span class="n">${d.value}</span></label>`).join('');
  const years = []; for (let y = MAX_YEAR; y >= MIN_YEAR; y--) years.push([y, String(y)]);
  const v = VOICES[settings.voice] || Object.values(VOICES)[0];
  $('settingsBody').innerHTML = `
  <section class="sec"><h3>Questions</h3>
    ${sel('rules.mode', 'Read', [['both', 'Tossups and bonuses'], ['tossups', 'Tossups only'], ['bonuses', 'Bonuses only']])}
    <div class="field"><span>Difficulty<small>None ticked means any difficulty.</small></span><span class="rowb" style="margin:0"><button type="button" class="btn" data-act="diff-college">College</button><button type="button" class="btn" data-act="diff-all">All</button></span></div>
    <div class="chips" id="diffChips">${diffs}</div>
    <div class="field" style="margin-top:8px"><span>Categories<small>From QBReader. Open a category for its subcategories.</small></span><span class="rowb" style="margin:0"><button type="button" class="btn" data-act="cat-all">All</button><button type="button" class="btn" data-act="cat-phil">Philosophy</button></span></div>
    <div id="catList">${cats}</div>
    <label class="field"><span>Years</span><span><select id="s-minYear" data-year="minYear">${years.map(([y, t]) => `<option value="${y}" ${f.minYear === y ? 'selected' : ''}>${t}</option>`).join('')}</select> to <select id="s-maxYear" data-year="maxYear">${years.map(([y, t]) => `<option value="${y}" ${f.maxYear === y ? 'selected' : ''}>${t}</option>`).join('')}</select></span></label>
  </section>
  <section class="sec"><h3>Voice</h3>
    ${Object.keys(VOICES).length > 1 ? sel('voice', 'Voice type', Object.entries(VOICES).map(([k, x]) => [k, x.label]), 'Natural sounds better; Plain is a smaller download.') : ''}
    ${v.speakers > 1 ? sel('sid', 'Speaker', v.speakerNames.map((n, i) => [i, n])) : ''}
    ${rng('speed', 'Reading speed', SPEED.min, SPEED.max, SPEED.step, '×', 'Also the − and + beside the microphone meter, or say “read faster” / “read slower”.')}
    ${sw('calmAnswers', 'Calmer pace for answers and verdicts', `Questions are read at full speed; “The answer is …” never faster than ${SPEED.calm}×.`)}
    ${settings.voice === 'supertonic' ? sel('steps', 'Voice quality', [[3, 'Faster'], [5, 'Standard'], [8, 'Best (slower to generate)']], 'Lowered automatically if this phone cannot keep up.') : ''}
    ${rng('volume', 'Volume', 0.2, 1.5, 0.05, '×')}
    <div class="rowb"><button type="button" class="btn" data-act="test-voice">Play a sample</button></div>
  </section>
  <section class="sec"><h3>Listening</h3>
    ${sel('rules.buzzSensitivity', 'Buzz by voice', [['normal', 'Normal: “buzz”, or any single short word'], ['strict', 'Strict: only “buzz”'], ['off', 'Off: tap the screen to buzz']])}
    ${sw('rules.bonusDirectAnswer', 'Bonuses: just say the answer', 'Off means saying “buzz” first, as for tossups.')}
    ${sel('leniency', 'Judging by ear', [[0.86, 'Strict'], [0.8, 'Normal'], [0.74, 'Lenient']], 'How closely what was heard must sound like the answer.')}
    ${sel('asr', 'Recognition model', Object.entries(RECOGNIZERS).map(([k, x]) => [k, `${x.label}${manifest && manifest.bundles['asr-' + k] ? ' (' + mb(manifest.bundles['asr-' + k].bytes) + ')' : ''}`]), 'Accurate hears names better; Light loads faster and uses less memory.')}
    ${sw('echoCancellation', 'Echo cancellation', 'Keeps the reader’s own voice out of the microphone. Leave on.')}
    ${sw('noiseSuppression', 'Noise suppression')}
    ${sw('autoGainControl', 'Automatic microphone level')}
    <label class="field"><span>Microphone</span><select id="s-micId" data-k="micId"><option value="">Default</option></select></label>
  </section>
  <section class="sec"><h3>Timing</h3>
    ${rng('rules.tossupDeadSec', 'Time to buzz after a tossup', 2, 12, 1, ' s')}
    ${rng('rules.bonusAnswerSec', 'Time to answer a bonus part', 2, 12, 1, ' s')}
    ${rng('rules.answerStartSec', 'Time to start answering after a buzz', 3, 15, 1, ' s')}
    ${rng('rules.betweenSec', 'Pause between questions', 1, 8, 0.5, ' s', 'Say “I was right”, “I was wrong” or “repeat” here.')}
    ${rng('rules.sentenceGapSec', 'Pause between sentences', 0, 1.2, 0.05, ' s', 'A longer pause makes buzzing easier if the car’s speakers drown you out.')}
  </section>
  <section class="sec"><h3>Feedback</h3>
    ${sw('showText', 'Show the question text as it is read')}
    ${sw('rules.announceType', 'Announce “tossup” and “bonus”')}
    ${sw('rules.sayHeard', 'Say what was heard after a wrong answer')}
    ${sw('rules.sayAnswerWhenCorrect', 'Say the full answer after a correct one')}
    ${sw('rules.readRestAfterBuzz', 'After a wrong buzz, read the rest of the question')}
    ${sw('rules.bonusPointsSpoken', 'Say the points after each bonus')}
  </section>
  <section class="sec"><h3>Help</h3>
    <p class="note">While a tossup is read, say <b>buzz</b>, wait for the beep, then answer. For a bonus, just say the answer during or after each part. Any time: <b>skip question</b>, <b>repeat question</b>, <b>pause quiz</b>, <b>resume</b>. Right after a verdict: <b>I was right</b> or <b>I was wrong</b>. The big button always works as a buzzer.</p>
    <p class="note">On iPhone, use Safari with the screen on. If the car treats the microphone as a phone call, that is expected.</p>
  </section>
  <section class="sec"><h3>Troubleshooting</h3>
    <div class="rowb"><button type="button" class="btn" data-act="sound-check">Sound check</button><button type="button" class="btn" data-act="copy-log">Copy log</button><button type="button" class="btn" data-act="show-log">Show log</button><button type="button" class="btn danger" data-act="clear-models">Delete downloaded models</button></div>
    <p class="note" id="diagInfo"></p>
    <pre class="log" id="checkView" hidden></pre>
    <pre class="log" id="logView" hidden></pre>
    <p class="note">Carbowl ${VERSION}. Questions and answer checking from <a href="https://www.qbreader.org" target="_blank" rel="noopener">QBReader</a>. Speech runs on this device with sherpa-onnx, Moonshine, Silero VAD and Supertonic or Piper voices.</p>
  </section>`;
  fillMics(); renderDiag();
}
async function fillMics () {
  const s = $('s-micId'); if (!s) return;
  const list = await audio.devices();
  s.innerHTML = '<option value="">Default</option>' + list.filter(d => d.id && d.id !== 'default').map(d => `<option value="${escapeHtml(d.id)}" ${settings.micId === d.id ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('');
}
function renderDiag () {
  const el = $('diagInfo'); if (!el) return;
  const bits = [];
  if (tts && tts.info) bits.push(`voice ${tts.info.voice}, speed factor ${tts.realTimeFactor ? tts.realTimeFactor.toFixed(2) : '—'}`);
  if (listener && listener.info) bits.push(`recognition ${listener.info.asr}`);
  if (audio.ctx) bits.push(`audio ${audio.sampleRate} Hz ${audio.state}; mic ${audio.micInfo.label || 'none'}${audio.micInfo.echoCancellation === false ? ' (no echo cancellation!)' : ''}`);
  el.textContent = bits.join(' · ');
}

let needEngines = false; let needPhrases = false; let needMic = false;
function onSettingInput (e) {
  const t = e.target;
  if (t.dataset.k) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.num || t.type === 'range') v = Number(v);
    if (['sid', 'steps', 'leniency'].includes(t.dataset.k)) v = Number(v);
    set(t.dataset.k, v);
    const out = $('settingsBody').querySelector(`output[data-for="${t.dataset.k}"]`); if (out) out.textContent = v + (out.dataset.unit || '');
    if (t.dataset.k === 'voice') { settings.sid = v === 'supertonic' ? DEFAULTS.sid : 0; saveSettings(); needEngines = true; if (e.type === 'change') buildSettings(); }
    if (t.dataset.k === 'asr') needEngines = true;
    if (['sid', 'speed', 'steps', 'calmAnswers'].includes(t.dataset.k)) needPhrases = true;
    if (t.dataset.k === 'speed') { settings.speed = +clampSpeed(v).toFixed(2); saveSettings(); renderSpeed(); }
    if (t.dataset.k === 'volume') audio.setVolume(v);
    if (['echoCancellation', 'noiseSuppression', 'autoGainControl', 'micId'].includes(t.dataset.k)) needMic = true;
    if (t.dataset.k === 'showText') renderText();
    return;
  }
  const f = settings.filters;
  if (t.dataset.diff !== undefined) { const d = Number(t.dataset.diff); f.difficulties = t.checked ? [...new Set([...f.difficulties, d])].sort((a, b) => a - b) : f.difficulties.filter(x => x !== d); } else if (t.dataset.sub) { f.subs = t.checked ? [...new Set([...f.subs, t.dataset.sub])] : f.subs.filter(x => x !== t.dataset.sub); syncCats(); } else if (t.dataset.alt) { f.alts = t.checked ? [...new Set([...f.alts, t.dataset.alt])] : f.alts.filter(x => x !== t.dataset.alt); } else if (t.dataset.catbox) { const c = CATEGORY_TREE.find(x => x.name === t.dataset.catbox); f.subs = t.checked ? [...new Set([...f.subs, ...c.subs])] : f.subs.filter(x => !c.subs.includes(x)); if (t.checked) f.alts = [...new Set([...f.alts, ...c.alts])]; syncCats(); } else if (t.dataset.year) { f[t.dataset.year] = Number(t.value); if (f.minYear > f.maxYear) { if (t.dataset.year === 'minYear') f.maxYear = f.minYear; else f.minYear = f.maxYear; $('s-minYear').value = f.minYear; $('s-maxYear').value = f.maxYear; } } else return;
  saveSettings(); feed.setFilters(f);
}
function syncCats () {
  const f = settings.filters;
  for (const c of CATEGORY_TREE) {
    const d = $('catList').querySelector(`details[data-cat="${CSS.escape(c.name)}"]`); if (!d) continue;
    const on = c.subs.filter(s => f.subs.includes(s)).length;
    const box = d.querySelector('[data-catbox]'); box.checked = on > 0; box.indeterminate = on > 0 && on < c.subs.length;
    const small = d.querySelector('summary small'); if (small) small.textContent = `${on}/${c.subs.length}`;
    d.querySelectorAll('[data-sub]').forEach(i => { i.checked = f.subs.includes(i.dataset.sub); });
    d.querySelectorAll('[data-alt]').forEach(i => { i.checked = f.alts.includes(i.dataset.alt); });
  }
}
$('settingsBody').addEventListener('change', onSettingInput);
$('settingsBody').addEventListener('input', e => { if (e.target.type === 'range') onSettingInput(e); });
// A tick box inside a <summary> must not also fold the section open or shut.
$('settingsBody').addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) { e.preventDefault(); settingsAction(act.dataset.act); }
});
async function settingsAction (name) {
  const f = settings.filters;
  if (name === 'diff-college') { f.difficulties = [7, 8, 9, 10]; } else if (name === 'diff-all') { f.difficulties = DIFFICULTIES.map(d => d.value); } else if (name === 'cat-all') { f.subs = CATEGORY_TREE.flatMap(c => c.subs); f.alts = ALL_ALTERNATES.slice(); } else if (name === 'cat-phil') { f.subs = ['Philosophy']; f.alts = ALL_ALTERNATES.slice(); }
  if (name.startsWith('diff-') || name.startsWith('cat-')) { saveSettings(); feed.setFilters(f); $('diffChips').querySelectorAll('[data-diff]').forEach(i => { i.checked = f.difficulties.includes(Number(i.dataset.diff)); }); syncCats(); return; }
  if (name === 'test-voice') {
    if (!narrator) { toast('The voice is still loading.'); return; }
    if (phase === 'running') { toast('End the session to try voices.'); return; }
    try { await audio.start({ mic: false }); audio.setVolume(settings.volume); await narrator.say('This thinker argued that the mind at birth is a blank slate. For ten points, name this author of An Essay Concerning Human Understanding.'); } catch (e) { toast('Could not play: ' + e.message); }
  } else if (name === 'copy-log') {
    const text = [`Carbowl ${VERSION}`, navigator.userAgent, 'settings ' + JSON.stringify({ ...settings, filters: { ...settings.filters, alts: `${settings.filters.alts.length} alternates` } }), ...logLines].join('\n');
    try { await navigator.clipboard.writeText(text); toast('Log copied'); } catch (e) { const pre = $('logView'); pre.hidden = false; pre.textContent = text; toast('Select and copy the log below.'); }
  } else if (name === 'show-log') { const pre = $('logView'); pre.hidden = !pre.hidden; if (!pre.hidden) { pre.textContent = logLines.slice(-120).join('\n'); pre.scrollTop = pre.scrollHeight; } } else if (name === 'clear-models') {
    if (phase === 'running') { toast('End the session first.'); return; }
    await clearModelCache(); toast('Downloaded models deleted'); if (tts) tts.terminate(); if (listener) listener.terminate(); tts = null; listener = null; narrator = null; $('settings').close(); await checkSetup();
  } else if (name === 'sound-check') soundCheck();
}

/** Plays the reader while watching the microphone, to show whether the app hears itself, then listens for a buzz. */
async function soundCheck () {
  const out = $('checkView'); out.hidden = false;
  const say = line => { out.textContent += line + '\n'; out.scrollTop = out.scrollHeight; log('sound check: ' + line); };
  out.textContent = '';
  if (phase === 'running') { say('End the session first.'); return; }
  if (!narrator || !listener) { say('The speech models are still loading.'); return; }
  try {
    const constraints = { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl }; if (settings.micId) constraints.deviceId = { exact: settings.micId };
    await audio.start({ mic: true, constraints }); audio.setVolume(settings.volume);
    if (!soundCheck.port) { audio.setSink(listener.createAudioPort()); soundCheck.port = true; }
  } catch (e) { say('Could not open the microphone: ' + e.message); return; }
  const levels = []; const utts = [];
  const onL = e => levels.push(e.detail.rms); const onU = e => utts.push(e.detail);
  listener.addEventListener('level', onL); listener.addEventListener('utterance', onU);
  const db = v => (20 * Math.log10(Math.max(1e-6, v))).toFixed(0);
  const mean = a => a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : 0;
  try {
    say(`Microphone: ${audio.micInfo.label || 'default'}; echo cancellation ${audio.micInfo.echoCancellation === false ? 'OFF' : 'on'}; audio ${audio.sampleRate} Hz.`);
    say('1. Stay quiet for two seconds…');
    listener.setMode('spot'); levels.length = 0;
    await new Promise(resolve => setTimeout(resolve, 2000));
    const quiet = mean(levels);
    say(`   background level ${db(quiet)} dB`);
    say('2. Reading a sentence. Stay quiet…');
    levels.length = 0; utts.length = 0;
    await narrator.say('This philosopher wrote that the unexamined life is not worth living, and was sentenced to drink hemlock by an Athenian jury.');
    await new Promise(resolve => setTimeout(resolve, 900));
    const during = mean(levels);
    say(`   level while reading ${db(during)} dB (${(20 * Math.log10(Math.max(1e-6, during) / Math.max(1e-6, quiet))).toFixed(0)} dB above background)`);
    if (utts.length) say(`   The microphone heard the reader: "${utts.map(u => u.text).join(' / ')}". Expect false buzzes: lower the volume, try another microphone, or lengthen the pause between sentences.`); else say('   Good: the reader was not picked up as speech.');
    say('3. Now say “buzz”…');
    utts.length = 0; audio.tone('listen');
    const tEnd = performance.now() + 6000;
    while (performance.now() < tEnd && !utts.length) await new Promise(resolve => setTimeout(resolve, 100));
    if (!utts.length) say('   Nothing heard. Check the microphone choice and permission.'); else { const { classifyBuzz } = await import('./intent.js'); const u = utts[0]; const b = classifyBuzz(u, settings.rules.buzzSensitivity === 'off' ? 'normal' : settings.rules.buzzSensitivity); say(`   Heard "${u.text}" at ${db(u.level)} dB -> ${b.buzz ? 'counts as a buzz' : 'would NOT count as a buzz'}; recognised in ${u.asrMs} ms.`); }
    say(`Speech speed factor ${tts.realTimeFactor.toFixed(2)} (below 0.7 is comfortable).`);
  } catch (e) { say('Check failed: ' + e.message); } finally { listener.setMode('off'); listener.removeEventListener('level', onL); listener.removeEventListener('utterance', onU); renderDiag(); }
}

$('openSettings').addEventListener('click', () => { buildSettings(); needEngines = false; needPhrases = false; needMic = false; $('settings').showModal(); });
$('settings').addEventListener('close', async () => {
  if (!activeCategories(settings.filters).length) { settings.filters.subs = ['Philosophy']; saveSettings(); feed.setFilters(settings.filters); toast('No category was ticked, so Philosophy is back on.'); }
  if (phase === 'running') {
    if (needMic) { try { await audio.reopenMic({ constraints: { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, ...(settings.micId ? { deviceId: { exact: settings.micId } } : {}) } }); audio.setSink(listener.createAudioPort()); log('microphone reopened with new settings: ' + JSON.stringify(audio.micInfo)); } catch (e) { log('microphone change failed: ' + e.message); toast('That microphone could not be opened.'); } }
    if (needEngines) toast('Voice type and recognition model change after you end this session.', 4500);
    return;
  }
  if (needEngines && manifest && `${settings.voice}|${settings.asr}` !== enginesFor) { await checkSetup(); } else if (needPhrases && narrator && phase === 'ready') preparePhrases();
});

// ---------- review ----------
function renderReview () {
  const items = sessionHistory.slice().reverse();
  const pts = p => `<span class="pts ${p > 0 ? 'good' : p < 0 ? 'bad' : ''}">${p > 0 ? '+' : ''}${p}</span>`;
  const body = items.length ? `<ul class="hist">${items.map((h, k) => {
    const idx = sessionHistory.length - 1 - k;
    if (h.type === 'tossup') {
      return `<li><div class="h-top"><span>Tossup · ${escapeHtml((h.q && h.q.set && h.q.set.name) || '')}</span><span>${escapeHtml(h.result || '')} ${pts(h.points)}</span></div><div class="h-ans">${safeAnswerHtml(h.answer)}</div>${h.heard ? `<div class="h-heard">heard: ${escapeHtml(h.heard)}</div>` : ''}<details class="h-q"><summary>Question</summary>${escapeHtml(h.text || '')}</details>${h.result && h.result !== 'skipped' && h.buzzOffset !== null ? `<div class="rowb"><button type="button" class="btn" data-ov="${idx}" data-right="${h.result === 'power' || h.result === 'ten' ? 0 : 1}">${h.result === 'power' || h.result === 'ten' ? 'Mark incorrect' : 'Mark correct'}</button></div>` : ''}</li>`;
    }
    return `<li><div class="h-top"><span>Bonus · ${escapeHtml((h.q && h.q.set && h.q.set.name) || '')}</span><span>${pts(h.points)}</span></div>${(h.parts || []).map((p, i) => `<div class="h-ans">${safeAnswerHtml(p.answer)}</div><div class="h-heard">${escapeHtml(p.result || 'not reached')}${p.heard ? ` · heard: ${escapeHtml(p.heard)}` : ''}${p.result ? ` · <button type="button" class="btn quiet" style="padding:2px 6px;min-height:0" data-ov="${idx}" data-part="${i}" data-right="${p.result === 'correct' ? 0 : 1}">${p.result === 'correct' ? 'mark incorrect' : 'mark correct'}</button>` : ''}</div>`).join('')}<details class="h-q"><summary>Question</summary>${escapeHtml(h.leadin || '')} ${(h.parts || []).map(p => escapeHtml(p.text)).join(' ')}</details></li>`;
  }).join('')}</ul><div class="rowb"><button type="button" class="btn" data-copy="missed">Copy missed questions</button><button type="button" class="btn danger" data-copy="clear">Clear this session</button></div>` : '<p class="note">Nothing yet. Questions you hear appear here with their answers, so you can fix a verdict or copy the ones you missed.</p>';
  $('reviewBody').innerHTML = body;
}
$('openReview').addEventListener('click', () => { renderReview(); $('review').showModal(); });
$('reviewBody').addEventListener('click', async e => {
  const ov = e.target.closest('[data-ov]');
  if (ov) {
    e.preventDefault();
    const rec = sessionHistory[Number(ov.dataset.ov)]; const g = game || Object.assign(new Game({ feed: {}, narrator: {}, listener: new EventTarget(), audio: {}, judge }), { history: sessionHistory });
    g.override(rec, ov.dataset.right === '1', ov.dataset.part === undefined ? undefined : Number(ov.dataset.part));
    renderReview(); renderScore(); return;
  }
  const c = e.target.closest('[data-copy]');
  if (!c) return;
  e.preventDefault();
  if (c.dataset.copy === 'clear') { if (phase === 'running') { toast('End the session first.'); return; } sessionHistory.length = 0; LS.del('lastSession'); renderReview(); renderScore(); return; }
  const strip = s => String(s || '').replace(/<[^>]*>/g, '');
  const lines = [];
  for (const h of sessionHistory) {
    if (h.type === 'tossup' && !['power', 'ten'].includes(h.result)) lines.push(`TOSSUP: ${h.text}\nANSWER: ${strip(h.answer)}\n`);
    if (h.type === 'bonus') (h.parts || []).forEach(p => { if (p.result && p.result !== 'correct') lines.push(`BONUS PART: ${p.text}\nANSWER: ${strip(p.answer)}\n`); });
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast(`Copied ${lines.length} missed`); } catch (err) { toast('Copying is not allowed here.'); }
});

// ---------- self-test (address ends in ?test) ----------
// Plays one canned tossup and one canned bonus against the scripted microphone, speaking the buzz and
// the answers with synthetic voices, and records what happened in window.carbowlSelfTestResult.
if (TEST) {
  const CANNED = {
    tossup: { _id: 'selftest-tossup', type: 'tossup', category: 'Philosophy', subcategory: 'Philosophy', difficulty: 7, set: { name: 'Self-test' }, question_sanitized: 'This thinker argued that the solution to the problem of causality is obtained by restoring to the pure concepts of the (*) understanding their a priori origin. This author recounted being woken from his dogmatic slumber by David Hume. For 10 points, identify this thinker who wrote the Critique of Pure Reason.', answer: 'Immanuel <b><u>Kant</u></b>', answer_sanitized: 'Immanuel Kant' },
    bonus: { _id: 'selftest-bonus', type: 'bonus', category: 'Philosophy', subcategory: 'Philosophy', difficulty: 7, set: { name: 'Self-test' }, leadin_sanitized: 'For 10 points each, answer the following about philosophers who wrote about color:', parts_sanitized: ['In this work, David Hume presents a thought experiment detailing how the mind can fill in a missing shade of blue. This work also uses the example of billiard balls to illustrate causation.', 'This philosopher used bleen and grue as illustrations of his new riddle of induction.', 'This author of A Letter Concerning Toleration wrote that the mind at birth is a blank slate.'], answers: ['An <b><u>Enquiry Concerning Human Understanding</u></b>', 'Nelson <b><u>Goodman</u></b>', 'John <b><u>Locke</u></b>'], answers_sanitized: ['An Enquiry Concerning Human Understanding', 'Nelson Goodman', 'John Locke'] }
  };
  window.carbowlSelfTest = async function ({ volume = 0.02 } = {}) {
    const R = { steps: [], ok: false, done: false }; window.carbowlSelfTestResult = R;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (what, pred, ms) => { const t = performance.now(); while (performance.now() - t < ms) { if (pred()) { R.steps.push(what + ' ok after ' + Math.round(performance.now() - t) + ' ms'); return true; } await sleep(30); } R.steps.push(what + ' TIMED OUT in state ' + app.dataset.state); return false; };
    try {
      await until('engines ready', () => phase === 'ready' || phase === 'running', 60000);
      feed.next = async type => ({ ...CANNED[type] });
      sessionHistory.length = 0; // the script expects a tossup first, as in a fresh session
      const saved = { ...settings.rules }; Object.assign(settings.rules, { mode: 'both', betweenSec: 1, tossupDeadSec: 5, bonusAnswerSec: 4 });
      // The "user" clips are made before the game starts, so that speaking them later is instant
      // even on a slow device where the voice is busy reading the question.
      const clip = async (text, sid) => { const c = await tts.speak(text, { sid, speed: 1, steps: 5, priority: 0 }).promise; const s = await to16k(c); for (let i = 0; i < s.length; i++) s[i] *= 0.5; return s; };
      const clips = { buzz: await clip('Buzz.', 2), kant: await clip('Immanuel Kant.', 7), enquiry: await clip('An Enquiry Concerning Human Understanding.', 5), wrong: await clip('I think that was Immanuel Kant.', 0) };
      R.steps.push('user clips prepared');
      const speakAsUser = async key => { fakeMic.say(clips[key].slice()); };
      if (phase === 'ready') await start();
      audio.setVolume(volume);
      const g = game;
      await until('tossup is being read', () => g.current && g.current.id === 'selftest-tossup' && app.dataset.state === 'reading' && g.reading && g.reading.timeline.length > 0, 60000);
      await sleep(3500);
      await speakAsUser('buzz');
      await until('buzz recognised', () => app.dataset.state === 'answering', 15000);
      await sleep(300);
      await speakAsUser('kant');
      await until('tossup judged', () => g.current.result !== null, 30000);
      R.tossup = { result: g.current.result, points: g.current.points, heard: g.current.heard, buzzOffset: g.current.buzzOffset, powerOffset: g.current.powerOffset };
      await until('bonus part 1 is being read', () => g.current && g.current.id === 'selftest-bonus' && app.dataset.state === 'reading' && $('status').textContent.includes('part 1'), 60000);
      const b = g.current;
      await sleep(2500);
      await speakAsUser('enquiry');
      await until('part 1 judged', () => b.parts[0].result !== null, 40000);
      await until('part 2 read, waiting', () => app.dataset.state === 'waiting' && $('status').textContent !== '' && b.parts[0].result !== null && b.parts[1].result === null, 90000);
      await sleep(800);
      await speakAsUser('wrong');
      await until('part 2 judged', () => b.parts[1].result !== null, 40000);
      await until('part 3 timed out', () => b.parts[2].result !== null, 120000);
      R.bonus = { points: b.points, parts: b.parts.map(p => ({ result: p.result, heard: p.heard })) };
      await sleep(1500);
      g.stop();
      Object.assign(settings.rules, saved);
      R.score = g.score();
      R.speechSpeedFactor = +tts.realTimeFactor.toFixed(3);
      R.ok = R.tossup.result === 'power' && R.bonus.parts[0].result === 'correct' && R.bonus.parts[1].result === 'wrong' && R.bonus.parts[2].result === 'none' && !R.steps.some(s => /TIMED OUT/.test(s));
    } catch (e) { R.error = String(e && e.stack || e); }
    R.log = logLines.filter(l => /heard|judge|buzz at|ignored|reveal|failed|error|skipp|unhandled/i.test(l)).slice(-30);
    R.done = true;
    return R;
  };

  // Exercises the real microphone path without a microphone: a synthetic voice clip is played into
  // the capture worklet (in place of the mic stream), which resamples it and feeds the listening
  // worker exactly as live audio would be. Also checks the worklet's frame rate and timestamps.
  window.carbowlLoopbackTest = async function (text = 'Buzz.', sid = 2) {
    const R = { done: false }; window.carbowlLoopbackResult = R;
    try {
      await audio.start({ mic: false });
      const ctx = audio.ctx;
      await ctx.audioWorklet.addModule(new URL('./workers/capture-worklet.js', import.meta.url).href).catch(() => {});
      const node = new AudioWorkletNode(ctx, 'carbowl-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(ctx.destination);
      // Stage 1: frames to the main thread, to measure rate, timing and a 1 kHz tone's level.
      const frames = []; node.port.onmessage = e => frames.push({ n: e.data.samples.length, t: e.data.t, rms: Math.sqrt(e.data.samples.reduce((s, v) => s + v * v, 0) / e.data.samples.length), at: ctx.currentTime });
      const osc = ctx.createOscillator(); osc.frequency.value = 1000; const og = ctx.createGain(); og.gain.value = 0.5; osc.connect(og); og.connect(node);
      const tStart = ctx.currentTime; osc.start();
      await new Promise(resolve => setTimeout(resolve, 2000));
      osc.stop(); osc.disconnect();
      const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
      R.contextRate = ctx.sampleRate; R.frames = frames.length; R.frameSize = frames[0] && frames[0].n;
      R.samplesPerSecond = span ? Math.round((frames.length - 1) * 640 / span) : 0;
      R.toneRms = +(frames.slice(5, -2).reduce((s, f) => s + f.rms, 0) / Math.max(1, frames.length - 7)).toFixed(4); // 0.5 amplitude sine -> 0.3536
      R.stampLagMs = Math.round(1000 * frames.slice(5).reduce((s, f) => s + (f.at - f.t), 0) / Math.max(1, frames.length - 5));
      R.monotonic = frames.every((f, i) => i === 0 || f.t > frames[i - 1].t);
      R.firstFrameAfterMs = frames[0] ? Math.round(1000 * (frames[0].t - tStart)) : null;
      // Stage 2: speech through the worklet into the listening worker.
      node.port.onmessage = null;
      const sinkPort = listener.createAudioPort(); node.port.postMessage({ port: sinkPort }, [sinkPort]);
      const clip = await tts.speak(text, { sid, speed: 1, steps: 5, priority: 0 }).promise;
      const heard = []; const onU = e => heard.push(e.detail); listener.addEventListener('utterance', onU);
      listener.setMode('spot');
      await new Promise(resolve => setTimeout(resolve, 600));
      const buf = ctx.createBuffer(1, clip.samples.length, clip.sampleRate); buf.getChannelData(0).set(clip.samples);
      const src = ctx.createBufferSource(); src.buffer = buf; const sg = ctx.createGain(); sg.gain.value = 0.5; src.connect(sg); sg.connect(node);
      const playedAt = ctx.currentTime + 0.05; src.start(playedAt);
      const tEnd = performance.now() + 8000;
      while (performance.now() < tEnd && !heard.length) await new Promise(resolve => setTimeout(resolve, 50));
      listener.setMode('off'); listener.removeEventListener('utterance', onU);
      if (heard.length) { const u = heard[0]; R.heard = u.text; R.utteranceStartsAfterClipStartMs = Math.round(1000 * (u.start - playedAt)); R.utteranceDur = +u.dur.toFixed(2); R.clipDur = +(clip.samples.length / clip.sampleRate).toFixed(2); R.level = +u.level.toFixed(3); R.asrMs = u.asrMs; } else R.heard = null;
      node.disconnect();
      R.ok = R.samplesPerSecond > 15900 && R.samplesPerSecond < 16100 && Math.abs(R.toneRms - 0.3536) < 0.02 && R.monotonic && !!R.heard && /buzz/i.test(R.heard);
    } catch (e) { R.error = String(e && e.stack || e); }
    R.done = true;
    return R;
  };
}

boot();
