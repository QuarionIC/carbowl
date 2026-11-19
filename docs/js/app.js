// Screen and wiring: settings, model download, starting the engines, and showing what the game does.

import { CATEGORY_TREE, DIFFICULTIES, ALL_ALTERNATES, defaultFilters, sanitizeFilters, QuestionFeed, MIN_YEAR, MAX_YEAR, activeCategories, QUICK_TOPICS, topicOn, setTopic } from './qb.js';
import { safeAnswerHtml, splitAnswerHtml, escapeHtml, wordsOf, chunkForSpeech } from './speechtext.js';
import { judgeAnswer } from './judge.js';
import { soundSimilarity } from './phonetics.js';
import checkAnswer from '../vendor/qb-answer-checker.js';
import { AudioEngine } from './audio.js';
import { Narrator } from './narrator.js';
import { Game, PHRASES, DEFAULT_RULES } from './game.js';
import { TtsClient, ListenClient, loadManifest, requiredFiles, cacheStatus, downloadModels, clearModelCache, VOICES, RECOGNIZERS } from './speech.js';
import { HistoryStore, expandRecord, groupSessions, resumableSession, scoreOf, missedLines, byCategory } from './history.js';
import { classifyBuzz, isEcho } from './intent.js';
import { sleep, setTimer, usingWorkerClock } from './clock.js';
import { Assistant, ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL } from './assistant.js';
import { Updater } from './update.js';
import { resample } from './dsp.js';

// Also read by tools/stamp-version.mjs, which writes it into version.json: run that tool after changing it.
const VERSION = '0.3.4';
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
// The same, kept for this tab only (gone when the tab is closed).
const SS = {
  get (k, d) { try { const v = sessionStorage.getItem('cb.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set (k, v) { try { sessionStorage.setItem('cb.' + k, JSON.stringify(v)); } catch (e) { /* blocked */ } },
  del (k) { try { sessionStorage.removeItem('cb.' + k); } catch (e) { /* ignore */ } }
};

// Reading speed is a multiple of the voice's natural pace. Earlier versions defaulted to 1.1 and
// then 1.65; the default is now 1.3. Up to 1.5 the voice model speaks at that pace itself; above
// it the model speaks at 1.5 and the speech worker compresses the result (see dsp.js, splitPace).
const SPEED = { min: 0.8, max: 2, step: 0.05, nudge: 0.1, earlier: [1.1, 1.65], standard: 1.3, calm: 1.35 };
const clampSpeed = v => Math.min(SPEED.max, Math.max(SPEED.min, Math.round((Number(v) || SPEED.standard) / SPEED.step) * SPEED.step));
// Where WebKit is the browser (every browser on an iPhone or iPad, and Safari on a Mac) sound must
// leave through the call audio to be heard beside an open microphone; elsewhere the plain way is
// the shorter path and the one every other web page uses.
const UA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const APPLE_WEBKIT = /iPad|iPhone|iPod/.test(UA) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || (/Safari\//.test(UA) && !/Chrome|Chromium|CriOS|Edg|OPR|Android|FxiOS/.test(UA));
const DEFAULTS = {
  settingsVersion: 5,
  filters: defaultFilters(),
  rules: { ...DEFAULT_RULES },
  voice: 'supertonic', sid: 5, speed: SPEED.standard, calmAnswers: true, steps: 5, volume: 1,
  asr: 'moonshine-base', vadThreshold: 0.5, leniency: 0.8,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true, micId: '',
  // How sound leaves the page: 'element' is the one that is heard beside an open microphone on an
  // iPhone (in a car especially) and keeps going with the phone locked; 'direct' is the plain way;
  // 'auto' is 'element' where it is needed (see APPLE_WEBKIT) and 'direct' everywhere else.
  output: 'auto',
  // Which model answers "Moderator, ..." questions. (The key it needs is kept apart from these
  // settings: see assistantKey below.)
  assistantModel: DEFAULT_ASSISTANT_MODEL,
  showText: true
};
function loadSettings () {
  const s = LS.get('settings', {}) || {};
  const out = { ...DEFAULTS, ...s, rules: { ...DEFAULTS.rules, ...(s.rules || {}) }, filters: sanitizeFilters(s.filters) };
  // Settings saved by an earlier version carry that version's defaults; move those to the current
  // ones once. Anything the listener chose for themselves is left alone.
  const from = s.settingsVersion || 1;
  if (from < 3 && (s.speed === undefined || SPEED.earlier.some(v => Math.abs(s.speed - v) < 0.001))) out.speed = SPEED.standard;
  if (from < 4 && s.rules && Math.abs((s.rules.sentenceGapSec || 0) - 0.12) < 0.001) out.rules.sentenceGapSec = DEFAULT_RULES.sentenceGapSec;
  // 'element' was the default from 0.2.0 to 0.3.3 on every device; it is now chosen by device.
  if (from < 5 && s.output === 'element') out.output = 'auto';
  if (!['auto', 'element', 'direct'].includes(out.output)) out.output = 'auto';
  if (!ASSISTANT_MODELS.some(m => m.id === out.assistantModel)) out.assistantModel = DEFAULT_ASSISTANT_MODEL;
  out.settingsVersion = DEFAULTS.settingsVersion;
  out.speed = +clampSpeed(out.speed).toFixed(2);
  if (!VOICES[out.voice]) out.voice = DEFAULTS.voice;
  if (!RECOGNIZERS[out.asr]) out.asr = DEFAULTS.asr;
  out.sid = Math.min(VOICES[out.voice].speakers - 1, Math.max(0, out.sid | 0));
  return out;
}
const settings = loadSettings();
const saveSettings = () => LS.set('settings', settings);
// The assistant's API key is the listener's own secret. It is stored under a name of its own, never
// inside the settings (which "Copy log" copies out), and nothing here writes it to the log.
const assistantKey = {
  get: () => String(LS.get('assistantKey', '') || ''),
  set: v => LS.set('assistantKey', String(v).trim()),
  clear: () => LS.del('assistantKey')
};

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
const outputMode = () => settings.output === 'auto' ? (APPLE_WEBKIT ? 'element' : 'direct') : settings.output;
const audio = new AudioEngine({ log, output: outputMode() });
const feed = new QuestionFeed({ store: LS, log: (m, d) => log(m + (d ? ' ' + JSON.stringify(d) : '')) });
feed.setFilters(settings.filters);
const historyStore = new HistoryStore({ log });
let manifest = null; let tts = null; let listener = null; let narrator = null; let game = null;
let phase = 'boot';            // boot | setup | downloading | loading | ready | running | error
let enginesFor = '';           // "voice|asr" the running workers were built for
let wakeLock = null; let autoPaused = false; let lastRec = null;
let sessionId = 0;             // when this session began (it is also the key its questions are filed under)
const view = { rec: null, part: -1, offset: 0, buzzed: false };
// Opened from the Home Screen as an app of its own, iOS stops the microphone as soon as the phone
// is locked or another app is in front; in a Safari tab it keeps going.
const STANDALONE = (typeof navigator !== 'undefined' && navigator.standalone === true) || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);

function setPhase (p) { phase = p; app.dataset.phase = p === 'downloading' ? 'setup' : p; renderMain(); }
const voiceParams = () => ({ sid: settings.sid, speed: settings.speed, steps: settings.steps });
const judge = (answerline, transcripts, previous) => judgeAnswer({ answerline, transcripts, previous, checkAnswer, threshold: settings.leniency });

async function boot () {
  // The version is on screen all the time, so that a look (or a screenshot) says which copy is running.
  if ($('ver')) $('ver').textContent = VERSION;
  log(`Carbowl ${VERSION}; ${navigator.userAgent}${STANDALONE ? '; opened as a Home Screen app' : ''}`);
  await restoreHistory();
  buildSettings(); renderScore(); renderMain(); renderSpeed(); renderTopics();
  if ('serviceWorker' in navigator && !TEST) {
    navigator.serviceWorker.register('sw.js').catch(e => log('offline support not installed: ' + e.message));
    // Once offline support has taken charge of this page (on a first visit that is a moment after
    // loading), the copy of the app it keeps is completed, so the next start needs no connection.
    navigator.serviceWorker.addEventListener('controllerchange', () => updater.check('offline support ready'));
  }
  // A newer version, when one is published, replaces this one before the speech models are loaded
  // (so that they are loaded once, not twice). Only a moment is spent waiting to hear of one; fetching
  // it, once it is known to exist, is given longer.
  const first = updater.check('start');
  let early = await Promise.race([first, sleep(2000).then(() => 'slow')]);
  if (early === 'slow' && updater.state === 'checking') { $('status').textContent = `Updating to ${updater.latest}…`; early = await Promise.race([first, sleep(25000).then(() => 'slow')]); }
  if (early === 'reloading') return;
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
  tts.outRate = audio.sampleRate || 0; // speech is delivered at the sound system's rate once that is known (see the 'rate' listener)
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
  narrator = new Narrator({ tts, audio, voice: voiceParams, phraseCap: () => settings.calmAnswers ? SPEED.calm : null, onSlow: onSlowVoice, log });
  listener.addEventListener('level', e => onLevel(e.detail));
  tts.addEventListener('crash', () => fail('The voice stopped unexpectedly. Reload the page.'));
  listener.addEventListener('crash', () => fail('Listening stopped unexpectedly. Reload the page.'));
  setPhase('ready'); $('status').textContent = 'Ready';
  preparePhrases();
  updater.idle(); // an update that waited for the model download goes ahead
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
  start () { if (this.timer) return; listener.detachPorts(); this.t0 = audio.time; this.sent = 0; this.timer = setInterval(() => this.tick(), 20); }
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
// (Not through an OfflineAudioContext: the browser's own conversion does no filtering, and what
// folds back from above 8 kHz is not something a real microphone would deliver.)
async function to16k (clip) { return resample(clip.samples, clip.sampleRate, 16000).slice(); }
/** Test hook: speaks text into the stand-in microphone with one of the synthetic voices. */
async function speakAsUser (text, { sid = 2, speed = 1, level = 0.5 } = {}) {
  const clip = await tts.speak(text, { sid, speed, steps: 5, priority: 0 }).promise;
  const s = await to16k(clip);
  for (let i = 0; i < s.length; i++) s[i] *= level;
  fakeMic.say(s);
  return s.length / 16000;
}

// ---------- start / stop ----------
const micConstraints = () => { const c = { echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl }; if (settings.micId) c.deviceId = { exact: settings.micId }; return c; };

/** Opens sound (and the microphone when asked). Returns whether the microphone is in use. */
async function openAudio ({ mic }) {
  const want = outputMode();
  if (audio.ctx && audio.mode && audio.mode !== want && audio.live.size === 0) { audio.output = want; await audio.rebuild('the sound output setting changed'); }
  audio.output = want;
  if (!TEST && listener) audio.setSinkFactory(() => listener.createAudioPort());
  let micOk = mic; let r;
  try { r = await audio.start({ mic, constraints: micConstraints() }); } catch (e) {
    if (!mic) throw e;
    micOk = false;
    log('microphone not available: ' + (e.name || '') + ' ' + e.message);
    if (settings.micId) { settings.micId = ''; saveSettings(); }
    r = await audio.start({ mic: false });
  }
  audio.setVolume(settings.volume);
  if (r && !r.audible) toast('Tap the big button once more to start the sound.', 6000);
  showMic();
  return micOk;
}

function showMic () {
  const on = TEST ? !!fakeMic : !!audio.track;
  $('mic').classList.toggle('on', on);
  $('micLabel').textContent = TEST ? (fakeMic ? 'Scripted microphone (test)' : 'Microphone off') : (on ? (audio.micInfo.label || 'Microphone on') : 'Microphone off');
}

async function start () {
  if (phase !== 'ready') return;
  $('status').textContent = 'Starting…';
  let micOk;
  try {
    micOk = await openAudio({ mic: !TEST });
    if (TEST) { micOk = true; fakeMic = fakeMic || new FakeMic(); fakeMic.start(); showMic(); log('test mode: scripted microphone'); }
  } catch (e) { return fail('Sound could not start. Reload and tap Start again.', e); }
  if (!micOk) toast('No microphone access: tap the big button to buzz, and mark answers yourself.', 6000);
  log(`audio: ${audio.describe()}; output latency about ${Math.round((audio.latency || 0) * 1000)} ms; timers ${usingWorkerClock() ? 'in a worker' : 'on the page'}`);
  await requestWakeLock();
  assistant.warm(); // fetch the assistant's code now, not when the first question is asked
  if (!sessionId) sessionId = Date.now();
  game = new Game({
    feed, narrator, listener, audio, judge, assistant,
    rules: () => ({ ...settings.rules, ...(micOk ? {} : { buzzSensitivity: 'off', selfJudge: true }) }),
    ui: {
      onState, onQuestion, onProgress, onPart, onHeard, onResult, onAnswer, onScore: renderScore, onAssistant,
      onSaved: rec => { rec.session = rec.session || sessionId; historyStore.save(rec, rec.session); },
      onCommand,
      onNotice: what => { if (what === 'hold-off') toast('The reader will no longer stop at every sound (too many false alarms).', 5000); },
      onError: e => toast('Something went wrong: ' + (e.message || e))
    },
    log
  });
  game.verify = async clip => { if (!listener || listener.mode === 'answer') return null; const r = await listener.transcribe(clip.samples, clip.sampleRate); return r.text; };
  game.history = sessionHistory;
  window.carbowl = { game, audio, narrator, listener, tts, feed, settings, log: logLines, fakeMic, speakAsUser, historyStore };
  autoPaused = false;
  setPhase('running');
  game.run().then(() => {
    if (phase === 'running') { setPhase('ready'); $('status').textContent = 'Stopped'; }
    releaseWakeLock(); showMic(); renderTopics();
    // The topic switches come back under the last question: bring them into view whole (a card cut
    // off at the answer's edge looks like something hiding behind it), the question a scroll away.
    requestAnimationFrame(() => { stageBody.scrollTop = stageBody.scrollHeight; noteStage(); });
    // The session is over: an update that was held back goes ahead, and a long session ends with a look for one.
    updater.idle();
    if (Date.now() - updater.lastCheck > 5 * 60000) updater.check('session ended');
  });
}

/** Requests the quiz passes on because they concern the app's own settings. */
function onCommand (cmd) {
  audio.tone('tick');
  if (cmd === 'faster' || cmd === 'slower') nudgeSpeed(cmd === 'faster' ? 1 : -1);
  else if (cmd === 'louder' || cmd === 'quieter') {
    settings.volume = +Math.min(1.5, Math.max(0.2, settings.volume + (cmd === 'louder' ? 0.2 : -0.2))).toFixed(2);
    saveSettings(); audio.setVolume(settings.volume);
    toast(`Volume ${settings.volume.toFixed(1)}×`, 1400);
  }
}

// Requests to the assistant that need more than the app itself knows are answered by a model (see
// assistant.js); the built-in ones (repeat, earlier clues, the last answer, the score) need nothing.
//
// For development only: when the page itself is served from this computer, ?api=http://localhost:PORT
// points the assistant at a stand-in for the API (tools/mock-anthropic.mjs), which must be on this
// computer too. On the published site this is ignored, so no link can send a saved key elsewhere.
function devApi () {
  const local = h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  if (!local(location.hostname)) return '';
  const v = new URLSearchParams(location.search).get('api');
  if (!v) return '';
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && local(u.hostname) ? u.origin : ''; } catch (e) { return ''; }
}
const topicNames = () => ({ on: QUICK_TOPICS.filter(t => topicOn(settings.filters, t)).map(t => t.label), off: QUICK_TOPICS.filter(t => !topicOn(settings.filters, t)).map(t => t.label) });
/** "Switch to math": the topics as the assistant was asked to set them. Refused when it would leave no questions at all. */
function setTopicsByVoice (want) {
  let next = settings.filters;
  for (const t of QUICK_TOPICS) if (typeof want[t.key] === 'boolean') next = setTopic(next, t, want[t.key]);
  if (!activeCategories(next).length) return { ok: false, on: topicNames().on };
  settings.filters = next; saveSettings(); feed.setFilters(next);
  log('topics set by voice: ' + (topicNames().on.join(', ') || 'none of the three'));
  renderTopics(); if ($('catList')) syncCats();
  return { ok: true, on: topicNames().on };
}
const assistant = new Assistant({
  key: assistantKey.get,
  model: () => settings.assistantModel,
  sdk: () => import('../vendor/anthropic-sdk.js'),
  topics: { get: topicNames, set: setTopicsByVoice },
  baseURL: devApi(),
  log
});
if (assistant.baseURL) log('assistant: using the stand-in API at ' + assistant.baseURL + ' (development only)');

// ---------- keeping up to date ----------
// A page left open goes on running the code it was loaded with. This one asks which version is
// published (at the start, whenever it comes back into view, and every quarter of an hour), fetches
// a newer one as a checked, complete set, and reloads into it when nothing is going on: never in
// the middle of a quiz, a download, a check, or while a panel is open. See update.js.
let updateStuck = '';
const updateBusy = () => phase === 'running' ? 'a quiz is running' : phase === 'downloading' ? 'the speech models are downloading' : ($('settings').open || $('review').open) ? 'a panel is open' : (carCheck.running || assistantTest.running) ? 'a check is running' : '';
const updater = new Updater({
  version: VERSION, base: BASE, page: location.origin + location.pathname, store: SS, log,
  busy: updateBusy,
  lazy: () => assistant._sdk ? [] : ['vendor/anthropic-sdk.js'],
  reload: () => location.reload(),
  onState: (state, d) => {
    if (state === 'reloading') toast(`Updating to version ${d.latest}…`, 5000);
    else if (state === 'updated') toast(`Updated to version ${VERSION}`, 4000);
    const stuck = state === 'stuck' ? d.latest : (state === 'current' || state === 'updated' || state === 'reloading' ? '' : updateStuck);
    if (stuck !== updateStuck) { updateStuck = stuck; renderTopics(); }
  }
});
setInterval(() => { if (document.visibilityState === 'visible') updater.check('timer'); }, 15 * 60000);
window.addEventListener('pageshow', e => { if (e.persisted) updater.check('page restored'); });
window.addEventListener('online', () => updater.check('back online'));
function onAssistant (who, text) {
  $('heard').innerHTML = who === 'user' ? `You asked: <b>${escapeHtml(text)}</b>` : `<b>${escapeHtml(text)}</b>`;
}

async function requestWakeLock () {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => log('screen wake lock released')); log('screen wake lock held'); } else log('no wake lock support: keep the screen from locking in Settings > Display'); } catch (e) { log('wake lock refused: ' + e.message); }
}
function releaseWakeLock () { try { if (wakeLock) wakeLock.release(); } catch (e) { /* already released */ } wakeLock = null; }

// The quiz keeps going with the screen locked or another app in front (in a Safari tab; see
// STANDALONE above): nothing is paused when the page is hidden. Coming back to it, the screen lock
// is held off again and sound is nudged in case it was parked.
document.addEventListener('visibilitychange', () => {
  log('page ' + document.visibilityState);
  if (document.visibilityState === 'visible' && phase === 'running') { requestWakeLock(); audio.kick(); }
  if (document.visibilityState === 'visible' && Date.now() - updater.lastCheck > 60000) updater.check('page shown');
});

// When sound or the microphone really is gone (a phone call, a route that vanished) the quiz waits,
// silently, and picks up by itself when the audio engine reports that all is well again.
let troubleTimer = null;
audio.addEventListener('health', e => {
  const h = e.detail;
  renderDiag();
  if (phase !== 'running' || !game || TEST) return;
  if (h.ok) {
    if (autoPaused && game.paused) { autoPaused = false; log('sound and microphone are back; carrying on'); game.resume({ quiet: true }); }
    return;
  }
  if (troubleTimer) return;
  troubleTimer = setTimer(() => {
    troubleTimer = null;
    if (audio.health.ok || phase !== 'running' || !game || game.paused) return;
    autoPaused = true;
    game.requestPause({ quiet: true });
    $('heard').textContent = 'Waiting: ' + audio.health.problems.join('; ') + '.';
  }, 2200);
});
audio.addEventListener('mic', e => {
  showMic();
  if (e.detail === 'lost' && phase === 'running') toast('The microphone could not be re-opened. Tap the button to buzz, or End and Start again.', 7000);
});
audio.addEventListener('rebuilt', () => { showMic(); renderDiag(); });
// The sound system's rate is known once it has been opened, and changes when the route does (a car
// or a headset connecting). The speech worker is told, so that the voice arrives at that rate.
audio.addEventListener('rate', e => { if (tts) tts.setOutputRate(e.detail); log(`audio: the sound system runs at ${e.detail} Hz${e.detail < 32000 ? ' (a phone-call link: nothing above ' + (e.detail / 2000).toFixed(0) + ' kHz gets through it)' : ''}`); });

// ---------- how the voice is doing ----------
/** One line on how the voice is being made and played: for the log, Settings and the car check. */
function voiceReport () {
  if (!tts || !tts.info) return 'voice not loaded';
  const r = tts.recentFactor(settings.steps, 8);
  const made = r.jobs ? `generated in ${r.factor.toFixed(2)} of real time over the last ${r.jobs} long sentence(s)` : 'no long sentence generated yet';
  const rate = audio.sampleRate;
  const sound = rate ? `sound system at ${rate} Hz${rate < 32000 ? ' (a phone-call link)' : ''}, ${audio.mode} output` : 'sound not opened yet';
  const p = audio.played;
  return `voice ${tts.info.voice} speaker ${settings.sid}, quality ${settings.steps} (never changed automatically), ${settings.speed}x, ${made}; ${sound}; volume ${settings.volume}x; ${p.clips} clip(s) played, ${p.converted} converted on the page, ${p.pressed} with peaks pressed${narrator ? `; ${narrator.lateCount()} late sentence(s) in the last two minutes` : ''}`;
}
/** The reader keeps falling behind (see Narrator._noteLate). The voice is left as it is; the listener is told what would help. */
let slowVoice = null;
function onSlowVoice (info) {
  slowVoice = { ...info, at: Date.now() };
  log(`the reader keeps falling behind: ${info.late} late sentences in two minutes, speech generated in ${info.factor.toFixed(2)} of real time at quality ${info.steps}, ${info.speed}x`);
  toast(info.steps > 3
    ? 'Sentences are starting late: this device is taking longer to make the voice than to say it. “Faster” under Settings › Voice quality keeps up.'
    : 'Sentences are starting late: this device is taking longer to make the voice than to say it. A lower reading speed helps.', 9000);
  renderDiag();
}

// ---------- history ----------
// The questions of the session in hand; everything ever asked is in historyStore.
const sessionHistory = [];
/** Loads what is kept, and carries on with the latest session if it was in use recently (iOS discards background tabs). */
async function restoreHistory () {
  await historyStore.open();
  // Earlier versions kept one session in the browser's small key-value store: move it over once.
  const old = LS.get('lastSession', null);
  if (old && Array.isArray(old.items) && old.items.length) {
    old.items.forEach((h, i) => { if (h && (h.type === 'tossup' || h.type === 'bonus')) historyStore.save({ ...h, at: h.at || (old.at || 1) + i, q: { set: { name: h.set || '' }, category: h.cat || '' } }, old.at || 1); });
    log(`moved ${old.items.length} questions from the earlier storage into the history`);
  }
  LS.del('lastSession');
  const all = await historyStore.all();
  const carry = resumableSession(all);
  if (carry) { sessionId = carry.session; for (const r of carry.items) sessionHistory.push(expandRecord(r)); }
  log(`history: ${all.length} questions kept${historyStore.persistent ? '' : ' in memory only (this browser offers no lasting storage)'}${carry ? `; carrying on the session of ${sessionHistory.length}` : ''}`);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* best effort */ }
}

// ---------- rendering: main screen ----------
const STATUS = {
  idle: 'Ready', starting: 'Starting…', offline: 'Waiting for a connection…', empty: 'No questions match', between: '', result: '', paused: 'Paused', assistant: 'One moment…', asking: 'Yes?'
};
let readingKey = '';
function onState (state, extra = {}) {
  app.dataset.state = state;
  if (state === 'reading') {
    app.dataset.result = '';
    $('status').textContent = extra.repeat ? 'Reading again…' : (extra.type === 'bonus' ? (extra.part >= 0 ? `Bonus, part ${extra.part + 1}` : 'Bonus') : 'Tossup');
    // A new stretch of the same question (after "go back", or the assistant) keeps what is on screen.
    const key = `${view.rec && view.rec.id}:${extra.type}:${extra.part}`;
    if (!extra.rest && !extra.repeat && key !== readingKey) { $('answer').hidden = true; $('heard').textContent = ''; }
    readingKey = key;
  } else if (state === 'waiting') $('status').textContent = view.rec && view.rec.type === 'bonus' ? 'Your answer?' : 'Buzz?';
  else if (state === 'answering') $('status').textContent = 'Listening…';
  else if (state === 'judging') $('status').textContent = 'Were you right?';
  else if (state === 'paused' && extra.quiet) $('status').textContent = 'Waiting for sound…';
  else if (STATUS[state] !== undefined && STATUS[state] !== '') $('status').textContent = STATUS[state];
  if (state === 'idle') { $('mic').classList.remove('speaking'); readingKey = ''; }
  renderMain();
  syncStage();
}

// ---------- the question beside the answer ----------
// The answer has a band of its own under the question, so it can never lie on top of the text. When
// it appears, the question's band gets shorter; the text is then moved up by as much, so that what
// was being read stays just above the answer instead of slipping out of sight. Where the text runs
// on beyond its band the edge fades out: a line cut in half looks like text hiding behind the answer.
const stageBody = $('stageBody');
let stageBottom = 0; // scroll position plus height: the line of text at the band's lower edge
function fadeEdges () {
  const hidden = stageBody.scrollHeight - stageBody.clientHeight - stageBody.scrollTop;
  // Only where a good part of a line is out of sight: a few stray pixels are not worth dimming a line for.
  stageBody.classList.toggle('more-above', stageBody.scrollTop > 10);
  stageBody.classList.toggle('more-below', hidden > 10);
}
function noteStage () { stageBottom = stageBody.scrollTop + stageBody.clientHeight; fadeEdges(); }
function syncStage () {
  const shown = $('answer').hidden ? '' : '1';
  if (app.dataset.answer !== shown) app.dataset.answer = shown; // the big button makes room while an answer is on show (see app.css)
  fadeEdges();
}
stageBody.addEventListener('scroll', noteStage, { passive: true });
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (phase === 'running' && stageBottom) stageBody.scrollTop = Math.max(0, stageBottom - stageBody.clientHeight);
    noteStage();
  }).observe(stageBody);
  // The text itself growing or re-flowing (more of it shown, a narrower window) changes what is out of sight.
  new ResizeObserver(fadeEdges).observe($('qtext'));
}

function difficultyLabel (d) { const x = DIFFICULTIES.find(v => v.value === d); return x ? (x.dots ? '●'.repeat(x.dots) : x.short) : ''; }
function onQuestion (rec) {
  view.rec = rec; view.part = -1; view.offset = 0; view.buzzed = false; lastRec = rec;
  const q = rec.q || {};
  const n = (game ? game.count[rec.type] : 0) + 1;
  $('meta').textContent = [`${rec.type === 'bonus' ? 'Bonus' : 'Tossup'} ${n}`, q.subcategory && q.subcategory !== q.category ? q.subcategory : q.category, q.set && q.set.name, difficultyLabel(q.difficulty)].filter(Boolean).join(' · ');
  // For troubleshooting: which question, and how the voice is doing on this device right now.
  if (narrator && tts) log(`${rec.type} ${n} (${rec.id}): ${voiceReport()}`);
  $('answer').hidden = true; $('answer').innerHTML = ''; $('heard').textContent = '';
  app.dataset.result = '';
  $('progress').hidden = false; $('progressFill').style.width = '0%';
  const pm = $('powerMark');
  if (rec.type === 'tossup' && rec.powerOffset >= 0 && rec.text.length) { pm.hidden = false; pm.style.left = (100 * rec.powerOffset / rec.text.length).toFixed(1) + '%'; } else pm.hidden = true;
  renderText();
  $('stageBody').scrollTop = 0;
  syncStage(); noteStage();
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
  const stage = $('stageBody');
  const spans = el.querySelectorAll('.unread'); const lastUnread = spans[spans.length - 1];
  if (lastUnread) { const r = lastUnread.getBoundingClientRect(); const s = stage.getBoundingClientRect(); if (r.top > s.bottom - 40) stage.scrollTop += r.top - s.bottom + 80; }
  noteStage();
}
function onHeard (text, flag) {
  $('heard').innerHTML = !text ? '' : text === '…' ? 'Hearing you…' : text === '?' ? 'Say that again?' : `Heard: <b>${escapeHtml(text)}</b>${flag === 'ignored' ? ' (not a buzz)' : ''}`;
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
  // The answer has its own band under the question, so showing it never moves or covers the question.
  const { main, notes } = splitAnswerHtml(html);
  $('answer').innerHTML = `<small>Answer</small><div class="main">${main}</div>${notes ? `<div class="alts">${notes}</div>` : ''}`;
  $('answer').hidden = false;
  $('stageFoot').scrollTop = 0;
  syncStage(); // the question's band shrinks now; the observer above keeps its last line in view
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
}

function renderMain () {
  const main = $('btnMain'); const st = app.dataset.state;
  const running = phase === 'running';
  let label = 'Start'; let hint = ''; let enabled = phase === 'ready';
  if (phase === 'boot' || phase === 'loading') { label = 'Getting ready'; enabled = false; } else if (phase === 'setup' || phase === 'downloading') { label = 'Start'; enabled = false; } else if (phase === 'error') { label = 'Reload'; enabled = true; } else if (running) {
    enabled = true;
    if (st === 'paused') { label = 'Resume'; hint = 'or say “resume”'; } else if (st === 'judging') { label = 'I was right'; hint = 'or tap “I was wrong”'; } else if (st === 'answering' || st === 'asking') { label = 'Done'; hint = st === 'asking' ? 'tap when you have asked' : 'tap when you have answered'; } else if (st === 'assistant') { label = 'Carry on'; hint = 'or say “thanks”'; } else if (st === 'reading' || st === 'waiting') { label = 'Buzz'; hint = view.rec && view.rec.type === 'bonus' ? 'or just say your answer' : 'or say “buzz”'; } else if (st === 'between' || st === 'result') { label = 'Next'; hint = 'or wait'; } else { label = '…'; enabled = false; }
  } else if (phase === 'ready') hint = sessionHistory.length ? 'continue' : 'tap once; then it is hands-free';
  if ($('topics')) $('topics').hidden = phase !== 'ready';
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
  // Every tap is also a chance to start sound that the browser was holding back.
  audio.kick();
  const st = app.dataset.state;
  if (st === 'paused') { autoPaused = false; game.act('resume'); } else if (st === 'judging') game.act('right');
  else if (st === 'between' || st === 'result') game.act('next');
  else game.act('buzz');
});
$('btnPause').addEventListener('click', () => { if (!game) return; audio.kick(); if (game.paused) { autoPaused = false; game.act('resume'); } else game.requestPause(); });
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
    <div class="field" style="margin-top:8px"><span>Topics<small>One-tap switches. Math and Computer Science are part of Science &gt; Other Science in QBReader.</small></span></div>
    <div class="chips" id="quickTopics">${topicChips()}</div>
    <div class="field" style="margin-top:8px"><span>Categories<small>From QBReader. Open a category for its subcategories.</small></span><span class="rowb" style="margin:0"><button type="button" class="btn" data-act="cat-all">All</button><button type="button" class="btn" data-act="cat-phil">Philosophy</button></span></div>
    <div id="catList">${cats}</div>
    <label class="field"><span>Years</span><span><select id="s-minYear" data-year="minYear">${years.map(([y, t]) => `<option value="${y}" ${f.minYear === y ? 'selected' : ''}>${t}</option>`).join('')}</select> to <select id="s-maxYear" data-year="maxYear">${years.map(([y, t]) => `<option value="${y}" ${f.maxYear === y ? 'selected' : ''}>${t}</option>`).join('')}</select></span></label>
  </section>
  <section class="sec"><h3>Voice</h3>
    ${Object.keys(VOICES).length > 1 ? sel('voice', 'Voice type', Object.entries(VOICES).map(([k, x]) => [k, x.label]), 'Natural sounds better; Plain is a smaller download.') : ''}
    ${v.speakers > 1 ? sel('sid', 'Speaker', v.speakerNames.map((n, i) => [i, n])) : ''}
    ${rng('speed', 'Reading speed', SPEED.min, SPEED.max, SPEED.step, '×', 'Also the − and + beside the microphone meter, or say “read faster” / “read slower”. Above 1.5× the voice still speaks at 1.5× and what it says is compressed in time: asked to go faster than that itself, it starts to drop sounds.')}
    ${sw('calmAnswers', 'Calmer pace for answers and verdicts', `Questions are read at full speed; “The answer is …” never faster than ${SPEED.calm}×.`)}
    ${settings.voice === 'supertonic' ? sel('steps', 'Voice quality', [[3, 'Faster'], [5, 'Standard'], [8, 'Best (slower to generate)']], 'Stays exactly as chosen: it is never lowered for you. If sentences start late, this device cannot make the voice fast enough; choose Faster then. <span id="voiceSpeed"></span>') : ''}
    ${rng('volume', 'Volume', 0.2, 1.5, 0.05, '×', 'Above 1× the loudest peaks are pressed down to fit, so louder never turns into distortion.')}
    <div class="rowb"><button type="button" class="btn" data-act="test-voice">Play a sample</button></div>
  </section>
  <section class="sec"><h3>Listening</h3>
    ${sel('rules.buzzSensitivity', 'Buzz by voice', [['normal', 'Normal: “buzz”, or any single short word'], ['strict', 'Strict: only “buzz”'], ['off', 'Off: tap the screen to buzz']], 'Normal also asks “say that again?” (two falling notes) when it hears something short it cannot make out.')}
    ${sel('rules.holdOnVoice', 'Stop reading when I speak', [['auto', 'Automatic'], ['on', 'Always'], ['off', 'Never']], 'The reader stops at the first sound of a voice and carries on if it was nothing. Automatic gives this up when noise keeps setting it off.')}
    ${sw('rules.bonusDirectAnswer', 'Bonuses: just say the answer', 'Off means saying “buzz” first, as for tossups.')}
    ${sw('rules.assistant', 'Spoken requests', '“Repeat the question”, “what were the earlier clues”, “go back”, “what was the answer”, “spell that”, “what’s my score”; and “Moderator, …” for anything else (see Assistant below).')}
    ${sel('leniency', 'Judging by ear', [[0.86, 'Strict'], [0.8, 'Normal'], [0.74, 'Lenient']], 'How closely what was heard must sound like the answer.')}
    ${sel('asr', 'Recognition model', Object.entries(RECOGNIZERS).map(([k, x]) => [k, `${x.label}${manifest && manifest.bundles['asr-' + k] ? ' (' + mb(manifest.bundles['asr-' + k].bytes) + ')' : ''}`]), 'Accurate hears names better; Light loads faster and uses less memory.')}
    ${sw('echoCancellation', 'Echo cancellation', 'Keeps the reader’s own voice out of the microphone. Leave on.')}
    ${sw('noiseSuppression', 'Noise suppression')}
    ${sw('autoGainControl', 'Automatic microphone level')}
    <label class="field"><span>Microphone<small>In the car leave this on Default, which is the car’s own microphone. Choosing the iPhone’s moves the sound to the phone as well.</small></span><select id="s-micId" data-k="micId"><option value="">Default</option></select></label>
  </section>
  <section class="sec"><h3>Assistant</h3>
    <p class="note">Say <b>Moderator</b>, then ask anything: “who was David Hume?”, “why was that the answer?”, “switch to math”. Between questions a question needs no “Moderator”. It will not give away the answer to a question still in play.</p>
    <p class="note">The answers come from Anthropic’s Claude, through an Anthropic account of your own: make an API key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> and paste it here. Anthropic bills that account for what is used. What you ask is sent to Anthropic together with the question being read and the last few questions and answers. <b>The key stays in this browser on this device and is sent only to Anthropic. Use a key made just for this, with a spending limit.</b></p>
    <label class="field"><span>API key<small id="keyState"></small></span><input type="password" id="assistantKey" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-…"></label>
    <div class="rowb"><button type="button" class="btn primary" data-act="key-save">Save key</button><button type="button" class="btn" data-act="assistant-test">Ask a test question</button><button type="button" class="btn danger" data-act="key-remove">Remove key</button></div>
    ${sel('assistantModel', 'Model', ASSISTANT_MODELS.map(m => [m.id, `${m.label}: ${m.note}`]), 'Opus gives the best answers and is the slowest to start speaking; Haiku starts soonest and costs least. “Ask a test question” times the one chosen.')}
    <p class="note" id="assistantTestOut" style="white-space:pre-line" hidden></p>
  </section>
  <section class="sec"><h3>Car, lock screen, other apps</h3>
    <p class="note">With CarPlay or Bluetooth the car shows Carbowl as a phone call: that is how it gets the car’s microphone. <b>The car’s call volume is separate from its music volume</b>: play the test tone and turn the volume knob up while it sounds. Carbowl keeps going with the phone locked or another app in front as long as it runs in a Safari tab${STANDALONE ? ' — <b>it is running as a Home Screen app now, which iOS cuts off from the microphone in the background: open it in Safari instead</b>' : ''}.</p>
    ${sel('output', 'Sound output', [['auto', 'Automatic (recommended)'], ['element', 'Through the call audio (car, lock screen)'], ['direct', 'Direct']], `Automatic uses the call audio on an iPhone, an iPad and in Safari, where that is what lets the reader be heard beside an open microphone, and the direct way everywhere else. On this device: ${outputMode() === 'element' ? 'the call audio' : 'direct'}. Change only if sound is missing or distorted. Takes effect at the next Start.`)}
    <div class="rowb"><button type="button" class="btn" data-act="test-tone">Play test tone</button><button type="button" class="btn" data-act="car-check">Run the car check</button><button type="button" class="btn" data-act="reconnect">Re-connect sound</button>${navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput ? '<button type="button" class="btn" data-act="choose-output">Choose where sound plays</button>' : ''}</div>
    <p class="note">“Re-connect sound” lets go of the microphone and the speaker and takes them up again; use it if the car connected after you started and the sound stayed on the phone.</p>
    <pre class="log" id="checkView" hidden></pre>
    <div class="rowb" id="checkActions" hidden><button type="button" class="btn primary" data-act="copy-check">Copy the car check report</button></div>
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
    <p class="note">While a tossup is read, say <b>buzz</b>, wait for the beep, then answer. The reader stops as soon as it hears you. Two falling notes mean “say that again?”. Said buzz by mistake? <b>Never mind</b>. For a bonus, just say the answer during or after each part.</p>
    <p class="note">Any time: <b>repeat the question</b>, <b>what were the earlier clues</b>, <b>go back</b> (the last sentence), <b>skip question</b>, <b>pause quiz</b>, <b>resume</b>, <b>read faster</b> / <b>slower</b>, <b>volume up</b> / <b>down</b>. Also: <b>what was the answer</b>, <b>spell that</b>, <b>what’s my score</b>, <b>what set is this from</b>, <b>what can I say</b>. Right after a verdict: <b>I was right</b> or <b>I was wrong</b>. The big button always works as a buzzer.</p>
    <p class="note">With an assistant key saved: <b>Moderator</b>, then any question or request in your own words. While it is answering, <b>thanks</b> or <b>stop</b> cuts it short, and it waits a few seconds afterwards for a follow-up.</p>
  </section>
  <section class="sec"><h3>Troubleshooting</h3>
    <div class="rowb"><button type="button" class="btn" data-act="copy-log">Copy log</button><button type="button" class="btn" data-act="show-log">Show log</button><button type="button" class="btn" data-act="check-update">Check for updates</button><button type="button" class="btn danger" data-act="clear-models">Delete downloaded models</button></div>
    <p class="note" id="diagInfo"></p>
    <pre class="log" id="logView" hidden></pre>
    <p class="note">Carbowl ${VERSION} (the number beside the title). It looks for a newer version by itself and loads it when no quiz is running. Questions and answer checking from <a href="https://www.qbreader.org" target="_blank" rel="noopener">QBReader</a>. Speech runs on this device with sherpa-onnx, Moonshine, Silero VAD and Supertonic or Piper voices.</p>
  </section>`;
  fillMics(); renderDiag(); renderKey();
}
/** Says whether a key is saved, showing only its last four characters. */
function renderKey () {
  const el = $('keyState'); if (!el) return;
  const k = assistantKey.get();
  el.textContent = k ? `A key is saved on this device (ends in ${k.slice(-4)}).` : 'No key saved: only the built-in requests work.';
}
/** Puts one fixed question to the chosen model and shows how long the answer took to start and to finish. */
async function assistantTest () {
  const out = $('assistantTestOut'); if (!out) return;
  out.hidden = false;
  if (!assistant.available()) { out.textContent = 'Save a key first.'; return; }
  if (assistantTest.running) return;
  assistantTest.running = true;
  const model = ASSISTANT_MODELS.find(m => m.id === settings.assistantModel) || ASSISTANT_MODELS[0];
  out.textContent = `Asking ${model.label}…`;
  let voice = null;
  try {
    // Spoken as well when no quiz is running, so that the voice saying it can be judged too.
    if (phase === 'ready' && narrator) { try { await openAudio({ mic: false }); voice = narrator.speakStream({ group: narrator.newGroup('at') }); } catch (e) { voice = null; } }
    const said = []; const t0 = performance.now(); let first = 0;
    await assistant.ask({
      text: 'In one sentence, who was David Hume?', talk: [],
      context: { state: 'idle', score: {}, asked: 0, earlier: [] },
      say: s => { if (!first) first = performance.now() - t0; said.push(s); if (voice) voice.push(s); }
    });
    const total = performance.now() - t0; const l = assistant.last || {};
    const sec = ms => (ms / 1000).toFixed(1) + ' s';
    out.textContent = `${model.label}: first text after ${l.firstMs == null ? '?' : sec(l.firstMs)}, first whole sentence after ${sec(first)}, finished after ${sec(total)} (${l.inputTokens} tokens in, ${l.outputTokens} out).\n“${said.join(' ')}”`;
    log(`assistant test: ${model.id}, first sentence after ${Math.round(first)} ms, finished after ${Math.round(total)} ms`);
  } catch (e) {
    out.textContent = `It did not work. ${e.spoken || ''}\n(${e.message || e})`;
    log('assistant test failed: ' + (e.message || e));
  } finally { if (voice) voice.end(); assistantTest.running = false; updater.idle(); }
}
async function fillMics () {
  const s = $('s-micId'); if (!s) return;
  const list = await audio.devices();
  s.innerHTML = '<option value="">Default</option>' + list.filter(d => d.id && d.id !== 'default').map(d => `<option value="${escapeHtml(d.id)}" ${settings.micId === d.id ? 'selected' : ''}>${escapeHtml(d.label)}</option>`).join('');
}
function renderDiag () {
  // Under "Voice quality": how fast this device is making the voice at the chosen setting, measured.
  const vs = $('voiceSpeed');
  if (vs) {
    const r = tts ? tts.recentFactor(settings.steps, 8) : { jobs: 0, factor: 0 };
    vs.textContent = !r.jobs ? '' : `Measured just now: a sentence takes ${Math.round(100 * r.factor)}% of its own length to make${r.factor > 1 ? ', which is too slow to keep up' : r.factor > 0.85 ? ', which only just keeps up' : ''}.${slowVoice && Date.now() - slowVoice.at < 30 * 60000 ? ' Sentences have been starting late.' : ''}`;
  }
  const el = $('diagInfo'); if (!el) return;
  const bits = [];
  if (tts && tts.info) bits.push(voiceReport());
  if (listener && listener.info) bits.push(`recognition ${listener.info.asr}`);
  if (audio.ctx) bits.push(audio.describe() + (audio.health.ok ? '' : ' — ' + audio.health.problems.join('; ')));
  el.textContent = bits.join(' · ');
}

// ---------- topics (one-tap switches on the start screen and in Settings) ----------
function topicChips () {
  const f = settings.filters;
  return QUICK_TOPICS.map(t => `<label class="chip"><input type="checkbox" id="topic-${t.key}-${topicChips.n = (topicChips.n || 0) + 1}" data-topic="${t.key}" ${topicOn(f, t) ? 'checked' : ''}>${escapeHtml(t.label)}</label>`).join('');
}
function renderTopics () {
  const el = $('topics'); if (!el) return;
  const f = settings.filters;
  const extra = f.subs.filter(s => !QUICK_TOPICS.some(t => t.sub === s)).length;
  el.innerHTML = `<h2>Topics</h2><div class="chips">${topicChips()}</div><p class="fine">${extra ? `Also on: ${extra} more ${extra === 1 ? 'subcategory' : 'subcategories'} chosen in Settings. ` : ''}Other categories, difficulty and years are in Settings.</p>${STANDALONE ? '<p class="warn">Opened from the Home Screen, Carbowl loses the microphone when the phone locks or another app is in front. For the car, open it in Safari.</p>' : ''}${updateStuck ? `<p class="warn">Version ${escapeHtml(updateStuck)} of Carbowl is published, but this device still shows ${VERSION}. <button type="button" class="btn" data-update="force">Update now</button></p>` : ''}`;
  el.hidden = phase !== 'ready';
}
$('topics').addEventListener('click', e => { if (e.target.closest('[data-update]')) { toast('Fetching the new version…', 6000); updater.force(); } });
function toggleTopic (key, on) {
  const topic = QUICK_TOPICS.find(t => t.key === key); if (!topic) return false;
  const next = setTopic(settings.filters, topic, on);
  if (!activeCategories(next).length) { toast('Keep at least one topic on.'); return false; }
  settings.filters = next; saveSettings(); feed.setFilters(next);
  log(`topic ${topic.label} ${on ? 'on' : 'off'}`);
  return true;
}
$('topics').addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.topic) { toggleTopic(t.dataset.topic, t.checked); renderTopics(); } });

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
    if (t.dataset.k === 'output' && phase === 'running') toast('The sound output changes at the next Start.', 4000);
    if (t.dataset.k === 'showText') renderText();
    return;
  }
  if (t.dataset.topic) { if (!toggleTopic(t.dataset.topic, t.checked)) t.checked = !t.checked; syncCats(); renderTopics(); return; }
  const f = settings.filters;
  if (t.dataset.diff !== undefined) { const d = Number(t.dataset.diff); f.difficulties = t.checked ? [...new Set([...f.difficulties, d])].sort((a, b) => a - b) : f.difficulties.filter(x => x !== d); } else if (t.dataset.sub) { f.subs = t.checked ? [...new Set([...f.subs, t.dataset.sub])] : f.subs.filter(x => x !== t.dataset.sub); syncCats(); } else if (t.dataset.alt) { f.alts = t.checked ? [...new Set([...f.alts, t.dataset.alt])] : f.alts.filter(x => x !== t.dataset.alt); } else if (t.dataset.catbox) { const c = CATEGORY_TREE.find(x => x.name === t.dataset.catbox); f.subs = t.checked ? [...new Set([...f.subs, ...c.subs])] : f.subs.filter(x => !c.subs.includes(x)); if (t.checked) f.alts = [...new Set([...f.alts, ...c.alts])]; syncCats(); } else if (t.dataset.year) { f[t.dataset.year] = Number(t.value); if (f.minYear > f.maxYear) { if (t.dataset.year === 'minYear') f.maxYear = f.minYear; else f.minYear = f.maxYear; $('s-minYear').value = f.minYear; $('s-maxYear').value = f.maxYear; } } else return;
  saveSettings(); feed.setFilters(f);
  syncTopics(); renderTopics();
}
function syncTopics () {
  const box = $('quickTopics'); if (!box) return;
  box.querySelectorAll('[data-topic]').forEach(i => { const t = QUICK_TOPICS.find(x => x.key === i.dataset.topic); i.checked = !!t && topicOn(settings.filters, t); });
}
function syncCats () {
  syncTopics();
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
  if (name.startsWith('diff-') || name.startsWith('cat-')) { saveSettings(); feed.setFilters(f); $('diffChips').querySelectorAll('[data-diff]').forEach(i => { i.checked = f.difficulties.includes(Number(i.dataset.diff)); }); syncCats(); renderTopics(); return; }
  if (name === 'test-voice') {
    if (!narrator) { toast('The voice is still loading.'); return; }
    if (phase === 'running') { toast('End the session to try voices.'); return; }
    try { await openAudio({ mic: false }); await narrator.say('This thinker argued that the mind at birth is a blank slate. For ten points, name this author of An Essay Concerning Human Understanding.'); } catch (e) { toast('Could not play: ' + e.message); }
  } else if (name === 'test-tone') {
    // Played the way the quiz plays (microphone open), so that in a car it comes out at the call volume, which is the one to set.
    try {
      const idle = phase !== 'running';
      if (idle) await openAudio({ mic: true });
      for (let i = 0; i < 3; i++) { audio.tone('test'); await sleep(1750); }
      if (idle && phase !== 'running') { audio.closeMic(); showMic(); }
    } catch (e) { toast('Could not play: ' + e.message); }
  } else if (name === 'reconnect') {
    if (!audio.ctx) { toast('Sound starts when you tap Start.'); return; }
    toast('Re-connecting sound…', 2500);
    await audio.rebuild('asked for in Settings', { reopen: true });
    audio.kick(); showMic(); renderDiag();
    toast(audio.describe(), 6000);
  } else if (name === 'choose-output') {
    try { const d = await audio.chooseOutput(); toast('Sound goes to ' + ((d && d.label) || 'the default output')); } catch (e) { toast('No output chosen: ' + (e.message || e)); }
  } else if (name === 'copy-log') {
    const text = [`Carbowl ${VERSION}`, navigator.userAgent, 'settings ' + JSON.stringify({ ...settings, filters: { ...settings.filters, alts: `${settings.filters.alts.length} alternates` } }), 'audio ' + audio.describe(), voiceReport(), '--- audio events ---', ...audio.events, '--- log ---', ...logLines].join('\n');
    await copyText(text, 'Log copied', 'logView');
  } else if (name === 'show-log') { const pre = $('logView'); pre.hidden = !pre.hidden; if (!pre.hidden) { pre.textContent = logLines.slice(-120).join('\n'); pre.scrollTop = pre.scrollHeight; } } else if (name === 'clear-models') {
    if (phase === 'running') { toast('End the session first.'); return; }
    await clearModelCache(); toast('Downloaded models deleted'); if (tts) tts.terminate(); if (listener) listener.terminate(); tts = null; listener = null; narrator = null; $('settings').close(); await checkSetup();
  } else if (name === 'check-update') {
    toast('Looking for a newer version…', 2500);
    const r = await updater.check('asked for in Settings');
    const said = { current: `This is the latest version (${VERSION}).`, updated: `This is the latest version (${VERSION}).`, offline: 'The site could not be reached. Try again when there is a connection.', failed: 'A newer version could not be fetched just now. It will be tried again.', waiting: `Version ${updater.latest} is ready. It loads when you close Settings${phase === 'running' ? ' and the quiz has ended' : ''}.`, reloading: `Updating to version ${updater.latest}…`, stuck: `Version ${updater.latest} is published but would not load here. Close Settings and tap “Update now” on the start screen.` }[r];
    toast(said || String(r), 6000);
  } else if (name === 'key-save') {
    const el = $('assistantKey'); const v = el.value.trim();
    if (!v) { toast('Paste the key into the box first.'); return; }
    assistantKey.set(v); el.value = '';
    renderKey(); assistant.warm();
    toast('Key saved on this device');
  } else if (name === 'key-remove') {
    assistantKey.clear(); $('assistantKey').value = '';
    renderKey(); $('assistantTestOut').hidden = true;
    toast('Key removed from this device');
  } else if (name === 'assistant-test') await assistantTest();
  else if (name === 'car-check') carCheck();
  else if (name === 'copy-check') await copyText(carCheck.report || '', 'Report copied: paste it to Claude', 'checkView');
}

/** Copies text; where the browser will not allow that, shows it for copying by hand. */
async function copyText (text, done, fallbackId) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { const pre = $(fallbackId); if (pre) { pre.hidden = false; pre.textContent = text; } toast('Select and copy the text shown.'); }
}

// ---------- car check ----------
// A guided two-minute test for the car (parked): it opens sound and the microphone the way the quiz
// does, asks what was heard, measures what the microphone picks up, tries a buzz in quiet and over
// the reader, and checks that everything keeps running with the phone locked. The report is made to
// be copied out and sent on, because none of this can be tried anywhere but in the car.
async function carCheck () {
  const out = $('checkView'); out.hidden = false; out.textContent = '';
  const lines = [];
  const say = line => { lines.push(line); out.textContent = lines.join('\n'); out.scrollTop = out.scrollHeight; log('car check: ' + line); };
  if (phase === 'running') { say('End the session first.'); return; }
  if (!narrator || !listener) { say('The speech models are still loading.'); return; }
  if (carCheck.running) return;
  carCheck.running = true; $('checkActions').hidden = true;
  const utts = []; const starts = []; const levels = [];
  const onU = e => utts.push(e.detail); const onS = e => starts.push(e.detail); const onL = e => levels.push(e.detail.rms);
  listener.addEventListener('utterance', onU); listener.addEventListener('speechstart', onS); listener.addEventListener('level', onL);
  const db = v => (20 * Math.log10(Math.max(1e-6, v))).toFixed(0);
  const mean = a => a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : 0;
  // Speaking must never hang the check, even when sound itself is what is broken.
  const speak = text => Promise.race([narrator.say(text), sleep(Math.max(8000, text.length * 150)).then(() => 'stalled')]).then(how => { if (how === 'stalled') say('   (the reader did not finish that sentence: sound is stalled)'); return how; });
  const firstUtterance = async (ms, needText = false) => { const n0 = utts.length; const t0 = performance.now(); while (performance.now() - t0 < ms) { const got = utts.slice(n0).find(u => !needText || String(u.text || '').trim()); if (got) return got; await sleep(100); } return utts.slice(n0)[0] || null; };
  const yesNo = async question => {
    await speak(question);
    listener.setMode('answer'); audio.tone('listen');
    const u = await firstUtterance(7000, true);
    listener.setMode('off');
    const t = u ? ' ' + String(u.text).toLowerCase().replace(/[^a-z' ]/g, ' ') + ' ' : '';
    const no = /\b(no|nope|not|nothing|didn't|did not|negative|couldn't)\b/.test(t); const yes = /\b(yes|yeah|yep|yup|i did|it did|heard|sure|affirmative|correct)\b/.test(t);
    return { answer: no ? 'no' : yes ? 'yes' : (u ? 'unclear' : 'no reply heard'), heard: u ? u.text : '' };
  };
  const told = r => `${r.answer}${r.heard ? ` (heard: "${r.heard}")` : ''}`;
  try {
    say(`Carbowl ${VERSION} car check, ${new Date().toISOString()}`);
    say(navigator.userAgent);
    say(`Opened ${STANDALONE ? 'as a Home Screen app (iOS stops its microphone in the background: use Safari)' : 'in the browser'}; page ${document.visibilityState}; timers ${usingWorkerClock() ? 'in a worker' : 'on the page'}; sound output setting "${settings.output}"${settings.output === 'auto' ? ` (${outputMode()} on this device)` : ''}; microphone setting ${settings.micId ? 'a chosen one' : 'Default'}.`);

    say('1. Opening sound and the microphone, as the quiz does…');
    const micOk = await openAudio({ mic: true });
    await sleep(700);
    let rep = await audio.report();
    say(`   ${rep.now}`);
    say(`   audio session: ${rep.session}; state: ${rep.health}; output chooser ${rep.outputChooser ? 'available' : 'not available'}`);
    say(`   devices: ${rep.devices.join(' | ') || 'none listed'}`);
    if (!micOk) say('   NO MICROPHONE. Allow it for this site (Safari: the page menu > Website Settings > Microphone), then run the check again.');

    say('2. Test tone, three times. Turn the car volume up while it plays (the car has a separate volume for calls).');
    for (let i = 0; i < 3; i++) { audio.tone('test'); await sleep(1750); }
    const tone = await yesNo('Did you hear the tone? Say yes or no.');
    say(`   Heard the tone? ${told(tone)}`);
    const voice = await yesNo('And can you hear this voice clearly? Say yes or no.');
    say(`   Hears the voice clearly? ${told(voice)}`);

    if (micOk) {
      say('3. Stay quiet for two seconds…');
      listener.setMode('spot'); levels.length = 0;
      await sleep(2000);
      const quiet = mean(levels);
      say(`   background level ${db(quiet)} dB`);
      say('   Reading a sentence. Stay quiet…');
      levels.length = 0; utts.length = 0; starts.length = 0;
      await speak('This philosopher wrote that the unexamined life is not worth living, and was sentenced to drink hemlock by an Athenian jury.');
      await sleep(900);
      const during = mean(levels);
      say(`   level while the reader talks ${db(during)} dB (${(20 * Math.log10(Math.max(1e-6, during) / Math.max(1e-6, quiet))).toFixed(0)} dB above background); voice onsets ${starts.length}`);
      if (utts.some(u => String(u.text).trim())) say(`   The microphone heard the reader: "${utts.map(u => u.text).filter(Boolean).join(' / ')}". The quiz recognises its own words and ignores them, but expect the reader to stop and start: try a lower volume.`); else say('   Good: the reader was not picked up as speech.');

      say('4. After each beep, say "buzz".');
      await speak('After each beep, say buzz.');
      let hits = 0;
      for (let i = 0; i < 3; i++) {
        listener.setMode('spot'); audio.tone('listen');
        const u = await firstUtterance(4500);
        listener.setMode('off');
        if (!u) { say(`   try ${i + 1}: nothing heard`); continue; }
        const b = classifyBuzz(u, 'normal'); if (b.buzz) hits++;
        say(`   try ${i + 1}: heard "${u.text}" (${(u.dur || 0).toFixed(2)} s, ${db(u.level)} dB, recognised in ${u.asrMs} ms) -> ${b.buzz ? 'a buzz' : String(u.text).trim() ? 'not a buzz' : 'a sound that could not be made out (the quiz would ask for it again)'}`);
        await sleep(600);
      }
      say(`   ${hits} of 3 heard as a buzz.`);

      say('5. Now say "buzz" once WHILE the reader is talking.');
      await speak('Now I will read for a while. Say buzz once, while I am talking.');
      const passage = 'In one work, this thinker imagined prisoners chained in a cave who take the shadows on its wall for reality. That work also describes a just city ruled by philosopher kings, and divides the soul into three parts. His teacher appears in most of his dialogues, among them the Symposium and the Phaedo. He founded a school in Athens called the Academy, where Aristotle studied for twenty years.';
      utts.length = 0; starts.length = 0; listener.setMode('spot');
      const reading = narrator.read(chunkForSpeech(passage), { group: narrator.newGroup('cc'), gap: settings.rules.sentenceGapSec });
      await Promise.race([reading.done, sleep(45000)]);
      reading.stop();
      await sleep(900); listener.setMode('off');
      const heard = utts.filter(u => String(u.text).trim());
      const own = heard.filter(u => isEcho(u.text, passage)); const yours = heard.filter(u => !isEcho(u.text, passage)); const blanks = utts.length - heard.length;
      say(`   voice onsets ${starts.length}; heard ${utts.length} time(s): ${yours.length} yours, ${own.length} the reader's own voice, ${blanks} not made out`);
      for (const u of utts) say(`     "${u.text}" ${(u.dur || 0).toFixed(2)} s, ${db(u.level)} dB${String(u.text).trim() && isEcho(u.text, passage) ? ' (the reader)' : ''}`);
      if (yours.some(u => classifyBuzz(u, 'normal').buzz)) say('   Your buzz over the reader was heard.');
      else if (blanks || yours.length) say('   Something was heard over the reader but not as a buzz: the quiz would stop and ask you to say it again.');
      else say('   Your buzz over the reader was NOT heard. In the quiz, buzz in the short pause between sentences, or lengthen that pause (Settings > Timing).');
    }

    say('6. Lock the phone now. I will count to twelve; unlock it after about ten.');
    await speak('Last step. Lock the phone now. I will count to twelve. Unlock it after about ten.');
    const seen = [];
    const mark = () => seen.push({ state: document.visibilityState, wall: performance.now(), clock: audio.time, frames: audio.beat.frames });
    document.addEventListener('visibilitychange', mark);
    const gaps = []; let last = performance.now();
    for (let i = 1; i <= 12; i++) { await speak(String(i)); await sleep(700); const t = performance.now(); gaps.push(Math.round(t - last)); last = t; }
    document.removeEventListener('visibilitychange', mark);
    mark();
    if (!seen.some(s => s.state === 'hidden')) say('   The page never went to the background (the phone was not locked), so this step shows nothing.');
    for (let i = 0; i < seen.length - 1; i++) {
      if (seen[i].state !== 'hidden') continue;
      const a = seen[i]; const b = seen[i + 1];
      say(`   hidden for ${((b.wall - a.wall) / 1000).toFixed(1)} s: the sound clock moved ${(b.clock - a.clock).toFixed(1)} s and the microphone delivered ${((b.frames - a.frames) * 640 / 16000).toFixed(1)} s of audio${micOk ? '' : ' (no microphone open)'}`);
    }
    say(`   time per count (ms): ${gaps.join(', ')}`);
    const kept = await yesNo('Did the counting carry on while the phone was locked? Say yes or no.');
    say(`   Counting carried on while locked? ${told(kept)}`);

    rep = await audio.report();
    say(`At the end: ${rep.now}; state: ${rep.health}`);
    say(`Voice: ${voiceReport()}.`);
    if (audio.sampleRate && audio.sampleRate < 32000) say(`   The sound system is running at ${audio.sampleRate} Hz, the rate of a phone call: nothing above ${(audio.sampleRate / 2000).toFixed(0)} kHz can get through this link, so the reader sounds like a voice on the phone here. That limit is the link's (it is how the car's microphone is reached), not the voice's.`);
    say('Done. Tap "Copy the car check report" and paste it to Claude.');
    await speak('Done. Thank you.');
  } catch (e) { say('The check stopped: ' + (e && e.message ? e.message : e)); } finally {
    listener.setMode('off');
    listener.removeEventListener('utterance', onU); listener.removeEventListener('speechstart', onS); listener.removeEventListener('level', onL);
    carCheck.report = [...lines, '', '--- what happened to the audio system ---', ...audio.events, '', '--- log (latest) ---', ...logLines.slice(-160)].join('\n');
    if (phase !== 'running') { audio.closeMic(); showMic(); }
    carCheck.running = false; $('checkActions').hidden = false; renderDiag();
    updater.idle();
  }
}

$('openSettings').addEventListener('click', () => { buildSettings(); needEngines = false; needPhrases = false; needMic = false; $('settings').showModal(); });
$('review').addEventListener('close', () => updater.idle());
$('settings').addEventListener('close', async () => {
  if (!activeCategories(settings.filters).length) { settings.filters.subs = ['Philosophy']; saveSettings(); feed.setFilters(settings.filters); toast('No category was ticked, so Philosophy is back on.'); }
  renderTopics();
  updater.idle(); // an update that waited for this panel to close goes ahead (unless a quiz is running)
  if (phase === 'running') {
    if (needMic) { try { await audio.reopenMic({ constraints: micConstraints() }); showMic(); log('microphone reopened with new settings: ' + audio.describe()); } catch (e) { log('microphone change failed: ' + e.message); toast('That microphone could not be opened.'); } }
    if (needEngines) toast('Voice type and recognition model change after you end this session.', 4500);
    return;
  }
  if (needEngines && manifest && `${settings.voice}|${settings.asr}` !== enginesFor) { await checkSetup(); } else if (needPhrases && narrator && phase === 'ready') preparePhrases();
});

// ---------- review: this session, and everything kept from earlier ones ----------
const review = { tab: 'session', groups: [] };
const pts = p => `<span class="pts ${p > 0 ? 'good' : p < 0 ? 'bad' : ''}">${p > 0 ? '+' : ''}${p}</span>`;
const scoreLine = s => [s.tossups ? `${s.powers + s.tens}/${s.tossups} tossups${s.negs ? `, ${s.negs} neg` : ''}` : '', s.bonuses ? `${s.ppb.toFixed(1)} per bonus` : '', `${s.points} points`].filter(Boolean).join(' · ');
const when = ms => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One question as a list item. where/idx say which list it sits in, so that a verdict can be corrected from here. */
function reviewItem (h, where, idx) {
  const q = h.q || {};
  const tag = [h.alt || q.alternate_subcategory || q.subcategory || q.category || h.cat, (q.set && q.set.name) || h.set].filter(Boolean).map(escapeHtml).join(' · ');
  if (h.type === 'tossup') {
    const right = h.result === 'power' || h.result === 'ten';
    const fixable = h.result && h.result !== 'skipped' && h.buzzOffset !== null && h.buzzOffset !== undefined;
    return `<li><div class="h-top"><span>Tossup${tag ? ' · ' + tag : ''}</span><span>${escapeHtml(h.result || '')} ${pts(h.points || 0)}</span></div><div class="h-ans">${safeAnswerHtml(h.answer)}</div>${h.heard ? `<div class="h-heard">heard: ${escapeHtml(h.heard)}</div>` : ''}<details class="h-q"><summary>Question</summary>${escapeHtml(h.text || '')}</details>${fixable ? `<div class="rowb"><button type="button" class="btn" data-ov="${idx}" data-in="${where}" data-right="${right ? 0 : 1}">${right ? 'Mark incorrect' : 'Mark correct'}</button></div>` : ''}</li>`;
  }
  return `<li><div class="h-top"><span>Bonus${tag ? ' · ' + tag : ''}</span><span>${pts(h.points || 0)}</span></div>${(h.parts || []).map((p, i) => `<div class="h-ans">${safeAnswerHtml(p.answer)}</div><div class="h-heard">${escapeHtml(p.result || 'not reached')}${p.heard ? ` · heard: ${escapeHtml(p.heard)}` : ''}${p.result ? ` · <button type="button" class="btn quiet" style="padding:2px 6px;min-height:0" data-ov="${idx}" data-in="${where}" data-part="${i}" data-right="${p.result === 'correct' ? 0 : 1}">${p.result === 'correct' ? 'mark incorrect' : 'mark correct'}</button>` : ''}</div>`).join('')}<details class="h-q"><summary>Question</summary>${escapeHtml(h.leadin || '')} ${(h.parts || []).map(p => escapeHtml(p.text)).join(' ')}</details></li>`;
}

async function renderReview () {
  const tabs = `<div class="tabs" role="tablist"><button type="button" role="tab" data-tab="session" aria-selected="${review.tab === 'session'}">This session</button><button type="button" role="tab" data-tab="all" aria-selected="${review.tab === 'all'}">All sessions</button></div>`;
  if (review.tab === 'session') {
    const items = sessionHistory.slice().reverse();
    $('reviewBody').innerHTML = tabs + (items.length
      ? `<p class="note">${scoreLine(scoreOf(sessionHistory))}</p><ul class="hist">${items.map((h, k) => reviewItem(h, 'session', sessionHistory.length - 1 - k)).join('')}</ul><div class="rowb"><button type="button" class="btn" data-copy="missed">Copy missed questions</button><button type="button" class="btn danger" data-copy="clear">Clear this session</button></div>`
      : '<p class="note">Nothing yet. Questions you hear appear here with their answers, so you can fix a verdict or copy the ones you missed. Earlier sessions are under “All sessions”.</p>');
    return;
  }
  const records = (await historyStore.all()).map(expandRecord);
  // Questions of the session in hand are shown from their live records, so that corrections made here reach the scoreboard.
  const live = new Map(sessionHistory.map(h => [`${h.at || 0}-${h.id}`, h]));
  review.groups = groupSessions(records).map(g => { const items = g.items.map(r => live.get(r.key) || r); return { ...g, items, score: scoreOf(items) }; });
  if (!records.length) { $('reviewBody').innerHTML = tabs + `<p class="note">No history yet. Every question you hear is kept on this ${historyStore.persistent ? 'device' : 'page (this browser offers no lasting storage, so it is lost on reload)'}, with what you said and whether it was right.</p>`; return; }
  const total = scoreOf(records);
  const cats = byCategory(records).slice(0, 8).map(c => `${escapeHtml(c.cat)} ${c.right}/${c.asked}`).join(' · ');
  $('reviewBody').innerHTML = tabs + `<p class="note"><b>${review.groups.length} ${review.groups.length === 1 ? 'session' : 'sessions'}, ${records.length} questions.</b> ${scoreLine(total)}</p><p class="note">Right by topic: ${cats}</p>` +
    review.groups.map((g, i) => `<details class="sess" data-sess="${i}"><summary><b>${escapeHtml(when(g.start))}</b><small>${g.items.length} ${g.items.length === 1 ? 'question' : 'questions'} · ${scoreLine(g.score)}</small></summary><ul class="hist"></ul></details>`).join('') +
    `<div class="rowb"><button type="button" class="btn" data-copy="missed-all">Copy all missed questions</button><button type="button" class="btn" data-copy="export">Save everything as a file</button><button type="button" class="btn danger" data-copy="clear-all">Delete all history</button></div>${historyStore.persistent ? '' : '<p class="note">This browser offers no lasting storage (private browsing?), so history is lost when the page reloads.</p>'}`;
}
$('openReview').addEventListener('click', async () => { await renderReview(); $('review').showModal(); });
// A session's questions are only laid out when it is opened: a long history would otherwise be slow to show.
$('reviewBody').addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches || !d.matches('details.sess') || !d.open) return;
  const g = review.groups[Number(d.dataset.sess)]; const ul = d.querySelector('ul');
  if (g && !ul.childElementCount) ul.innerHTML = g.items.slice().reverse().map((h, k) => reviewItem(h, 's' + d.dataset.sess, g.items.length - 1 - k)).join('');
}, true);
$('reviewBody').addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { e.preventDefault(); review.tab = tab.dataset.tab; await renderReview(); return; }
  const ov = e.target.closest('[data-ov]');
  if (ov) {
    e.preventDefault();
    const list = ov.dataset.in === 'session' ? sessionHistory : (review.groups[Number(ov.dataset.in.slice(1))] || {}).items;
    const rec = list && list[Number(ov.dataset.ov)];
    if (!rec) return;
    const live = sessionHistory.includes(rec);
    // The quiz in progress records the correction itself; anything else is corrected and filed here.
    const g = live && game ? game : Object.assign(new Game({ feed: {}, narrator: {}, listener: new EventTarget(), audio: {}, judge }), { history: live ? sessionHistory : [rec] });
    const changed = g.override(rec, ov.dataset.right === '1', ov.dataset.part === undefined ? undefined : Number(ov.dataset.part));
    if (changed && !(live && game)) historyStore.save(rec, rec.session || sessionId);
    const open = [...$('reviewBody').querySelectorAll('details.sess[open]')].map(d => d.dataset.sess);
    await renderReview(); renderScore();
    for (const s of open) { const d = $('reviewBody').querySelector(`details.sess[data-sess="${s}"]`); if (d) d.open = true; }
    return;
  }
  const c = e.target.closest('[data-copy]');
  if (!c) return;
  e.preventDefault();
  const what = c.dataset.copy;
  if (what === 'clear' || what === 'clear-all') {
    if (phase === 'running') { toast('End the session first.'); return; }
    // Deleting is for good, so it takes a second tap.
    if (c.dataset.sure !== '1') { c.dataset.sure = '1'; c.textContent = what === 'clear' ? 'Tap again to clear this session' : 'Tap again to delete everything'; return; }
    if (what === 'clear') await historyStore.removeSession(sessionId); else await historyStore.clear();
    sessionHistory.length = 0; sessionId = 0;
    await renderReview(); renderScore(); return;
  }
  if (what === 'export') {
    const records = await historyStore.all();
    const blob = new Blob([JSON.stringify({ app: 'Carbowl ' + VERSION, saved: new Date().toISOString(), questions: records }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `carbowl-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return;
  }
  const lines = missedLines(what === 'missed-all' ? await historyStore.all() : sessionHistory);
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
      // The synthetic voice now and then garbles a short phrase; a clip that the recogniser cannot
      // make out when played clean is no test of anything, so each one is checked and redone if need be.
      const clip = async (text, sid) => {
        let c = null;
        for (let attempt = 0; attempt < 4; attempt++) { c = await tts.speak(text, { sid, speed: 1, steps: 5 + 2 * attempt, priority: 0 }).promise; if (await soundsRight(text, c)) break; R.steps.push(`re-made the clip "${text}" (attempt ${attempt + 1} was unclear)`); }
        const s = await to16k(c); for (let i = 0; i < s.length; i++) s[i] *= 0.5; return s;
      };
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

  // The assistant, end to end: during a tossup a synthetic voice says "Moderator, who was David Hume?"
  // into the scripted microphone. The words are recognised, put to the model through Anthropic's SDK
  // (to the stand-in API of tools/mock-anthropic.mjs when the address carries ?api=...), the reply is
  // spoken as it streams in, and the reading carries on. Then a request in free words ("I give up,
  // skip this one please") is turned into an action by the model and carried out.
  window.carbowlAssistantTest = async function ({ volume = 0.02 } = {}) {
    const R = { steps: [], ok: false, done: false }; window.carbowlAssistantTestResult = R;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (what, pred, ms) => { const t = performance.now(); while (performance.now() - t < ms) { if (pred()) { R.steps.push(what + ' ok after ' + Math.round(performance.now() - t) + ' ms'); return true; } await sleep(30); } R.steps.push(what + ' TIMED OUT in state ' + app.dataset.state); return false; };
    try {
      await until('engines ready', () => phase === 'ready' || phase === 'running', 60000);
      if (!assistant.available()) throw new Error('no assistant key is saved');
      R.api = assistant.baseURL || 'api.anthropic.com'; R.model = settings.assistantModel;
      feed.next = async () => ({ ...CANNED.tossup });
      sessionHistory.length = 0;
      const saved = { ...settings.rules }; Object.assign(settings.rules, { mode: 'tossups', betweenSec: 1, tossupDeadSec: 4, followUpSec: 1.5 });
      const clip = async (text, sid) => {
        let c = null;
        for (let attempt = 0; attempt < 4; attempt++) { c = await tts.speak(text, { sid, speed: 1, steps: 5 + 2 * attempt, priority: 0 }).promise; if (await soundsRight(text, c)) break; R.steps.push(`re-made the clip "${text}" (attempt ${attempt + 1} was unclear)`); }
        const s = await to16k(c); for (let i = 0; i < s.length; i++) s[i] *= 0.5; return s;
      };
      const clips = { ask: await clip('Moderator, who was David Hume?', 7), skip: await clip('Moderator, I give up, skip this one please.', 5) };
      R.steps.push('user clips prepared');
      const spoken = []; const shown = onAssistant;
      if (phase === 'ready') await start();
      audio.setVolume(volume);
      const g = game;
      g.ui.onAssistant = (who, text) => { spoken.push(`${who}: ${text}`); shown(who, text); };
      const answered = () => logLines.filter(l => /assistant answered in/.test(l));
      await until('tossup is being read', () => g.current && g.current.id === 'selftest-tossup' && app.dataset.state === 'reading' && g.reading && g.reading.timeline.length > 0, 60000);
      await sleep(3000);
      fakeMic.say(clips.ask.slice());
      await until('the question reached the assistant', () => app.dataset.state === 'assistant', 20000);
      await until('the reply was spoken', () => answered().length >= 1, 40000);
      await until('the reading carried on', () => app.dataset.state === 'reading' && g.reading && g.reading.state === 'reading', 20000);
      const at = g.reading ? g.reading.position() : 0;
      await sleep(1500);
      R.readOn = !!g.reading && g.reading.position() > at;
      fakeMic.say(clips.skip.slice());
      await until('the model was asked a second time', () => answered().length >= 2, 40000);
      await until('the question was skipped', () => g.history.some(h => h.result === 'skipped'), 20000);
      await sleep(500);
      g.stop();
      Object.assign(settings.rules, saved);
      R.spoken = spoken;
      R.timings = answered().map(l => l.replace(/^\s*[\d.]+\s+/, '').slice(0, 160));
      R.requests = logLines.filter(l => /^\s*[\d.]+\s+assistant: /.test(l)).map(l => l.replace(/^\s*[\d.]+\s+/, ''));
      R.ok = spoken.some(s => /^assistant: .*Hume/.test(s)) && R.readOn && g.history.some(h => h.result === 'skipped') && !R.steps.some(s => /TIMED OUT/.test(s));
    } catch (e) { R.error = String(e && e.stack || e); }
    R.log = logLines.filter(l => /heard|assistant|failed|error|skipp|unhandled/i.test(l)).slice(-30);
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
      R.output = audio.describe();
      await ctx.audioWorklet.addModule(new URL('./workers/capture-worklet.js', import.meta.url).href).catch(() => {});
      const node = new AudioWorkletNode(ctx, 'carbowl-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { offset: audio.epoch } });
      // Tied off exactly as the engine ties off the real microphone path (into the output stream, not the context's destination).
      const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(audio._tail());
      // Stage 1: frames to the main thread, to measure rate, timing and a 1 kHz tone's level.
      const frames = []; let beats = 0; node.port.onmessage = e => { if (e.data.beat) { beats++; return; } frames.push({ n: e.data.samples.length, t: e.data.t, rms: Math.sqrt(e.data.samples.reduce((s, v) => s + v * v, 0) / e.data.samples.length), at: audio.time }); };
      const osc = ctx.createOscillator(); osc.frequency.value = 1000; const og = ctx.createGain(); og.gain.value = 0.5; osc.connect(og); og.connect(node);
      const tStart = audio.time; osc.start();
      await new Promise(resolve => setTimeout(resolve, 2000));
      osc.stop(); osc.disconnect();
      const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
      R.contextRate = ctx.sampleRate; R.frames = frames.length; R.frameSize = frames[0] && frames[0].n; R.beats = beats;
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
      const playedAt = audio.time + 0.05; src.start(playedAt - audio.epoch);
      const tEnd = performance.now() + 8000;
      while (performance.now() < tEnd && !heard.length) await new Promise(resolve => setTimeout(resolve, 50));
      listener.setMode('off'); listener.removeEventListener('utterance', onU);
      if (heard.length) { const u = heard[0]; R.heard = u.text; R.utteranceStartsAfterClipStartMs = Math.round(1000 * (u.start - playedAt)); R.utteranceDur = +u.dur.toFixed(2); R.clipDur = +(clip.samples.length / clip.sampleRate).toFixed(2); R.level = +u.level.toFixed(3); R.asrMs = u.asrMs; } else R.heard = null;
      node.port.postMessage({ stop: true }); node.disconnect();
      R.ok = R.samplesPerSecond > 15900 && R.samplesPerSecond < 16100 && Math.abs(R.toneRms - 0.3536) < 0.02 && R.monotonic && !!R.heard && /buzz/i.test(R.heard);
    } catch (e) { R.error = String(e && e.stack || e); }
    R.done = true;
    return R;
  };
}

boot();
