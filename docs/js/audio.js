// Audio engine: one AudioContext for everything. Plays synthesised speech and short tones, and
// captures the microphone through a worklet that feeds the listening worker.
//
// How sound leaves the page matters on an iPhone, and the choices here follow WebKit's own code
// and its engineers' advice (bugs.webkit.org 218012, 236219, 237878, 282939):
//  - While the microphone is open, iOS plays ordinary Web Audio output at a reduced level; in a
//    car, where the session is shown as a phone call, that can be inaudible. Sound sent through a
//    MediaStream into an <audio> element is played at full level, through the same unit that
//    captures the microphone (which is also what gives the echo canceller its reference). So
//    nothing is connected to the context's own destination: everything goes to a stream, and one
//    <audio> element plays the stream.
//  - A context with nothing connected to its destination is also allowed to keep running when
//    Safari is in the background or the phone is locked, and the element keeps playing there.
//  - resume() on an interrupted context may never settle, so nothing here ever waits on it.
//    Instead a watchdog looks at the audio system once a second and nudges, re-opens or rebuilds
//    whatever has stopped (a route change when the car connects, a phone call, a dropped track).
//
// Times handed out by the engine (time, startAt, endAt) are seconds on one clock that keeps
// counting when the context underneath has to be rebuilt.

import { setTimer, clearTimer } from './clock.js';
import { resample, limit } from './dsp.js';

// The highest a sample may go after the volume setting has been applied. Volumes above 1× are made
// by pressing the loudest peaks down (dsp.js, limit), not by letting them run over full scale,
// where the sound system would clip them into a rasp.
const FULL = 0.97;

const TONES = {
  // name: [ [frequency Hz, start s, duration s, peak gain, type] ... ]
  buzz: [[660, 0, 0.09, 0.5, 'square'], [880, 0.08, 0.1, 0.4, 'square']],
  correct: [[784, 0, 0.11, 0.45, 'sine'], [1047, 0.1, 0.11, 0.45, 'sine'], [1319, 0.2, 0.2, 0.45, 'sine']],
  wrong: [[196, 0, 0.16, 0.5, 'sawtooth'], [147, 0.15, 0.28, 0.5, 'sawtooth']],
  time: [[523, 0, 0.12, 0.4, 'triangle'], [392, 0.14, 0.24, 0.4, 'triangle']],
  prompt: [[698, 0, 0.09, 0.4, 'sine'], [698, 0.14, 0.09, 0.4, 'sine']],
  listen: [[988, 0, 0.07, 0.3, 'sine']],
  tick: [[1200, 0, 0.03, 0.15, 'sine']],
  ready: [[523, 0, 0.1, 0.35, 'sine'], [659, 0.1, 0.1, 0.35, 'sine'], [784, 0.2, 0.16, 0.35, 'sine']],
  paused: [[440, 0, 0.1, 0.35, 'sine'], [330, 0.12, 0.16, 0.35, 'sine']],
  power: [[1047, 0, 0.08, 0.4, 'sine'], [1319, 0.08, 0.08, 0.4, 'sine'], [1568, 0.16, 0.08, 0.4, 'sine'], [2093, 0.24, 0.22, 0.4, 'sine']],
  unsure: [[466, 0, 0.07, 0.32, 'sine'], [370, 0.1, 0.1, 0.32, 'sine']],          // "say that again?"
  think: [[880, 0, 0.05, 0.2, 'sine'], [1175, 0.08, 0.07, 0.2, 'sine']],           // the assistant has the question
  test: [[440, 0, 0.5, 0.5, 'sine'], [660, 0.5, 0.5, 0.5, 'sine'], [880, 1.0, 0.6, 0.5, 'sine']]
};

const describe = e => (e && (e.name ? e.name + ': ' : '') + (e.message || e)) || 'unknown error';

/**
 * Fills a two-second loop with the signal that plays under everything, so that the output is never
 * true silence between sentences: a Bluetooth or car link, or a digital output that mutes itself
 * on silence, would otherwise swallow the start of the next sentence, and an iPhone counts a silent
 * page as one it may put to sleep. It must never be heard, and what cannot be heard depends on
 * where the sound goes:
 *  - 'direct' (computers): a 30 Hz tone, 80 dB below full scale. A computer's own sound effects
 *    may turn quiet sounds up: on a Windows laptop's speakers the faint hiss used until 0.3.4 was
 *    measured coming out 16 dB louder, as a steady hiss around 10 kHz. A 30 Hz tone was turned up
 *    as much, but stays some 30 dB under what an ear can hear that low, and small speakers
 *    cannot produce it at all; it puts nothing whatever in the range where hiss is heard.
 *  - 'element' (iPhone, iPad, Safari): the faint hiss as before. A telephone link, which is what a
 *    car is to an iPhone, carries nothing below about 100 Hz, so the tone would arrive as silence.
 * Either is still several steps of a 16-bit sample, so it survives the trip to a sound card.
 */
export function keepAwake (out, sampleRate, mode) {
  if (mode === 'direct') {
    const w = 2 * Math.PI * 30 / sampleRate;
    for (let i = 0; i < out.length; i++) out[i] = 0.0001 * Math.sin(w * i);
  } else for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * 0.00015;
  return out;
}

export class AudioEngine extends EventTarget {
  /** @param {{ log?: Function, output?: 'element'|'direct' }} [o] */
  constructor ({ log, output } = {}) {
    super();
    this.log = log || (() => {});
    this.output = output || 'element';
    this.mode = '';              // how sound is actually leaving: 'element' | 'direct'
    this.ctx = null; this.master = null; this.bus = null; this.el = null;
    this.stream = null; this.track = null; this.source = null; this.capture = null;
    this.portFactory = null; this.sinkPort = null;
    this.live = new Set();
    this.volume = 1;
    this.micInfo = {};
    this.started = false; this.wantMic = false; this.constraints = {};
    this.epoch = 0; this.frozen = 0;
    this.needTap = false;
    this.health = { ok: true, problems: [] };
    this.events = [];            // what has happened to the audio system lately, for the troubleshooting report
    this.beat = { at: 0, frames: 0, rms: 0, input: false };
    this._w = { timer: null, lastCtx: -1, stalled: 0, muted: 0, silent: 0, lastReopen: 0, lastRebuild: 0, rebuilds: 0, lastPlay: 0 };
    this._busy = null; this._deviceSig = ''; this._deviceTimer = null; this._quietUntil = 0; this._workletFor = null;
    this._converted = new WeakMap(); // clip samples -> { rate, samples } at the context's rate
    this.played = { clips: 0, converted: 0, pressed: 0 };
  }

  /** Seconds on the engine's clock (see the note at the top of the file). */
  get time () { return this.ctx ? this.epoch + this.ctx.currentTime : this.frozen; }
  get sampleRate () { return this.ctx ? this.ctx.sampleRate : 0; }
  get state () { return this.ctx ? this.ctx.state : 'closed'; }
  /** Seconds between scheduling a sound and hearing it (an estimate; the element adds a little of its own). */
  get latency () { return this.ctx ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) + (this.mode === 'element' ? 0.08 : 0) : 0; }

  _note (msg) {
    this.log('audio: ' + msg);
    this.events.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (this.events.length > 80) this.events.splice(0, 20);
  }

  // ---- bringing it up ---------------------------------------------------------------------

  /**
   * Must first be called from a tap or click: browsers only start sound and open the microphone on
   * a user gesture. Throws if the microphone was asked for and could not be opened.
   * @returns {Promise<{ audible: boolean }>} audible false means one more tap is needed (see kick())
   */
  async start ({ mic = true, constraints = {} } = {}) {
    this.wantMic = mic; this.constraints = { ...constraints };
    this._sessionType(mic);
    // In the tap itself, before anything is awaited: this is what lets sound start at all when
    // the microphone is refused or not wanted.
    if (!this.ctx) this._build();
    this._kick();
    if (mic) {
      if (!this.track || this.track.readyState !== 'live') {
        const before = this.sampleRate;
        await this._openStream();
        // Opening the microphone can move the whole audio system to another route and rate (a car,
        // a headset). A context built for the old one is replaced by one built for the new.
        await new Promise(resolve => setTimer(resolve, 150));
        const probe = this._hardwareRate();
        if (probe && before && Math.abs(probe - before) > 1 && this.live.size === 0) { this._note(`audio rate changed from ${before} to ${probe} Hz when the microphone opened; rebuilding for it`); this._teardownContext(); this._build(); }
      }
      this._kick();
      if (!this.capture) await this._attachMic();
    } else if (this.stream) this.closeMic();
    this.started = true;
    this._watch();
    this._listenForDevices();
    const audible = await this._settle(1500);
    this.needTap = !audible;
    this._note(`started: ${this.describe()}`);
    return { audible };
  }

  _sessionType (mic) {
    try { if (navigator.audioSession) { const want = mic ? 'play-and-record' : 'playback'; if (navigator.audioSession.type !== want) navigator.audioSession.type = want; } } catch (e) { this._note('audio session type not set: ' + describe(e)); }
  }

  /** The rate a context made right now would run at; 0 when that cannot be found out cheaply. */
  _hardwareRate () {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const probe = new Ctx(); const rate = probe.sampleRate;
      probe.close().catch(() => {});
      return rate;
    } catch (e) { return 0; }
  }

  _build () {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser has no audio support.');
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = Math.min(1, this.volume);
    let mode = this.output;
    if (mode === 'element' && typeof ctx.createMediaStreamDestination !== 'function') mode = 'direct';
    if (mode === 'element') {
      this.bus = ctx.createMediaStreamDestination();
      this.master.connect(this.bus);
      this._element().srcObject = this.bus.stream;
    } else {
      this.bus = null;
      this.master.connect(ctx.destination);
      if (this.el) { try { this.el.pause(); this.el.srcObject = null; } catch (e) { /* not playing */ } }
    }
    this.mode = mode;
    ctx.addEventListener('statechange', () => {
      if (this.ctx !== ctx) return;
      this._note('context ' + ctx.state);
      this.dispatchEvent(new CustomEvent('state', { detail: ctx.state }));
      this._soon();
    });
    this._bed();
    this._w.lastCtx = -1; this._w.stalled = 0;
    // Whoever makes the speech is told the rate, so that it arrives ready for this context.
    this.dispatchEvent(new CustomEvent('rate', { detail: ctx.sampleRate }));
  }

  /** Where branches that must run but not be heard are tied off. */
  _tail () { return this.bus || this.ctx.destination; }

  _element () {
    if (this.el) return this.el;
    const el = document.createElement('audio');
    el.setAttribute('playsinline', ''); el.playsInline = true; el.autoplay = true; el.controls = false;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    el.addEventListener('pause', () => { if (this.mode === 'element' && this.started) { this._note('output element paused'); this._soon(); } });
    el.addEventListener('playing', () => this._note('output element playing'));
    el.addEventListener('error', () => this._note('output element error: ' + (el.error ? el.error.message || el.error.code : 'unknown')));
    (document.body || document.documentElement).appendChild(el);
    this.el = el;
    return el;
  }

  /** Something that is not silence keeps the output awake between sentences: see keepAwake() below. */
  _bed () {
    const ctx = this.ctx;
    const n = Math.round(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    keepAwake(buf.getChannelData(0), ctx.sampleRate, this.mode);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(this._tail());
    src.start();
  }

  /**
   * Nudges everything that should be running, without waiting for any of it. Safe to call often,
   * and worth calling from a tap: that is the one moment the browser will always allow sound to start.
   */
  kick () { this._kick(); this._soon(); }
  _kick () {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') { try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* tried */ } }
    if (this.mode === 'element' && this.el && this.el.paused) {
      this._w.lastPlay = Date.now();
      try { const p = this.el.play(); if (p && p.catch) p.catch(e => { if (!this._playRefused) { this._playRefused = true; this._note('output element could not start: ' + describe(e)); } }); if (p && p.then) p.then(() => { this._playRefused = false; }, () => {}); } catch (e) { this._note('output element could not start: ' + describe(e)); }
    }
  }

  /** Waits (briefly, never indefinitely) for sound to be running. */
  async _settle (ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (this.isAudible()) return true;
      if (Date.now() >= until) return false;
      await new Promise(resolve => setTimer(resolve, 80));
    }
  }

  isAudible () { return !!this.ctx && this.ctx.state === 'running' && (this.mode !== 'element' || (this.el && !this.el.paused)); }

  // ---- microphone -------------------------------------------------------------------------

  async _openStream () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open the microphone.');
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...this.constraints };
    for (const k of Object.keys(audio)) if (audio[k] === undefined || audio[k] === '') delete audio[k];
    this._quietUntil = Date.now() + 3000; // the device list may flicker as a result of this very call
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this._dropStream();
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.track = track;
    const s = track.getSettings ? track.getSettings() : {};
    this.micInfo = { label: track.label, sampleRate: s.sampleRate, channels: s.channelCount, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, deviceId: s.deviceId };
    this._note('microphone open: ' + JSON.stringify({ ...this.micInfo, deviceId: this.micInfo.deviceId ? 'set' : undefined }));
    track.addEventListener('ended', () => { if (this.track !== track) return; this._note('microphone track ended'); this.dispatchEvent(new CustomEvent('mic', { detail: 'ended' })); this._soon(); });
    track.addEventListener('mute', () => { if (this.track !== track) return; this._note('microphone muted by the system'); this.dispatchEvent(new CustomEvent('mic', { detail: 'muted' })); this._soon(); });
    track.addEventListener('unmute', () => { if (this.track !== track) return; this._note('microphone unmuted'); this.dispatchEvent(new CustomEvent('mic', { detail: 'unmuted' })); this._kick(); this._soon(); });
    this._w.muted = 0; this._w.silent = 0; this.beat.at = Date.now();
    this.dispatchEvent(new CustomEvent('mic', { detail: 'open' }));
  }

  _dropStream () {
    if (this.stream) for (const t of this.stream.getTracks()) { try { t.stop(); } catch (e) { /* already stopped */ } }
    this.stream = null; this.track = null;
  }

  _detachMic () {
    try { if (this.source) this.source.disconnect(); } catch (e) { /* already disconnected */ }
    try { if (this.capture) { this.capture.port.onmessage = null; this.capture.port.postMessage({ stop: true }); this.capture.disconnect(); } } catch (e) { /* already disconnected */ }
    this.source = null; this.capture = null;
  }

  async _attachMic () {
    const ctx = this.ctx;
    if (!ctx || !this.stream) return;
    if (this._workletFor !== ctx) { await ctx.audioWorklet.addModule(new URL('./workers/capture-worklet.js', import.meta.url).href); this._workletFor = ctx; }
    if (this.ctx !== ctx || !this.stream) return; // replaced while the module was loading
    this._detachMic();
    this.source = ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(ctx, 'carbowl-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { offset: this.epoch } });
    this.capture.port.onmessage = e => { const m = e.data; if (m && m.beat) this.beat = { at: Date.now(), frames: m.frames, rms: m.rms, input: m.input }; };
    this.source.connect(this.capture);
    // The worklet only runs while it leads somewhere; a muted gain takes it to the output without a sound.
    const mute = ctx.createGain(); mute.gain.value = 0;
    this.capture.connect(mute); mute.connect(this._tail());
    this.beat.at = Date.now();
    const port = this.portFactory ? this.portFactory() : this.sinkPort;
    this.sinkPort = null;
    if (port) this.capture.port.postMessage({ port }, [port]);
  }

  /** Tells the engine how to get a fresh channel to the listening worker each time the microphone path is (re)built. */
  setSinkFactory (fn) {
    this.portFactory = fn;
    if (this.capture && fn) { const port = fn(); this.capture.port.postMessage({ port }, [port]); }
  }

  /** One-off form of the above: hands the worklet a single MessagePort. */
  setSink (port) {
    if (this.capture) this.capture.port.postMessage({ port }, [port]);
    else this.sinkPort = port;
  }

  closeMic () { this.wantMic = false; this._detachMic(); this._dropStream(); this.micInfo = {}; this._sessionType(false); }

  async reopenMic ({ constraints } = {}) {
    if (constraints) this.constraints = { ...constraints };
    this.wantMic = true;
    this._sessionType(true);
    this._detachMic();
    await this._openStream();
    await this._attachMic();
    this._kick();
  }

  async devices () {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Microphone' })); } catch (e) { return []; }
  }

  // ---- looking after itself ---------------------------------------------------------------

  _watch () { if (!this._w.timer) this._w.timer = setTimer(() => { this._w.timer = null; this._tick(); if (this.started) this._watch(); }, 1000); }
  _soon () { if (this.started && !this._soonT) this._soonT = setTimer(() => { this._soonT = null; this._tick(); }, 250); }

  stopWatching () { this.started = false; if (this._w.timer) { clearTimer(this._w.timer); this._w.timer = null; } }

  /** Looks at the audio system, repairs what it can, and reports whether sound and listening are working. */
  _tick () {
    const ctx = this.ctx; const w = this._w;
    if (!ctx || !this.started || this._busy) return;
    const problems = [];
    if (ctx.state !== 'running') { problems.push('sound is ' + ctx.state); this._kick(); w.stalled++; } else if (ctx.currentTime === w.lastCtx) { problems.push('sound has stalled'); w.stalled++; } else w.stalled = 0;
    w.lastCtx = ctx.currentTime;
    if (this.mode === 'element' && this.el && this.el.paused) { problems.push('output is paused'); this._kick(); }
    if (this.wantMic) {
      const t = this.track;
      if (!t || t.readyState !== 'live') { problems.push('the microphone has dropped out'); this._reopen('the track ended'); } else if (t.muted) {
        problems.push('the microphone is muted by the system'); w.muted++;
        // A phone call or Siri mutes it and gives it back; one that stays muted is asked for again.
        if (w.muted >= 6 && w.muted % 8 === 6) this._reopen('muted for ' + w.muted + ' s');
      } else {
        w.muted = 0;
        if (ctx.state === 'running' && w.stalled === 0 && this.capture && Date.now() - this.beat.at > 3000) { problems.push('no sound is arriving from the microphone'); w.silent++; if (w.silent % 6 === 1) this._reopen('no frames for ' + Math.round((Date.now() - this.beat.at) / 1000) + ' s'); } else w.silent = 0;
      }
    }
    // Nudging has not helped for a while: start the sound system afresh. Not when sound has never
    // started (that needs a tap, not a rebuild), and less and less often while it keeps failing
    // (during a phone call there is nothing to be done but wait).
    if (w.stalled >= 5 && !this.needTap && Date.now() - w.lastRebuild > Math.min(60000, 12000 * 2 ** w.rebuilds)) { w.rebuilds++; this.rebuild('sound did not come back after ' + w.stalled + ' s'); }
    const ok = problems.length === 0;
    if (ok) { w.rebuilds = 0; this.needTap = false; }
    if (ok !== this.health.ok || problems.join('|') !== this.health.problems.join('|')) {
      this.health = { ok, problems };
      this._note(ok ? 'all well' : 'trouble: ' + problems.join('; '));
      this.dispatchEvent(new CustomEvent('health', { detail: this.health }));
    }
  }

  _reopen (why) {
    const w = this._w;
    if (this._busy || Date.now() - w.lastReopen < 5000) return;
    w.lastReopen = Date.now();
    this._note('re-opening the microphone: ' + why);
    this._busy = (async () => {
      try { this._detachMic(); await this._openStream(); await this._attachMic(); this._kick(); } catch (e) { this._note('could not re-open the microphone: ' + describe(e)); this.dispatchEvent(new CustomEvent('mic', { detail: 'lost' })); }
    })().finally(() => { this._busy = null; this._soon(); });
  }

  _teardownContext () {
    const now = this.time;
    for (const h of [...this.live]) h.abandon();
    this._detachMic();
    const old = this.ctx;
    this.ctx = null; this.master = null; this.bus = null;
    this.frozen = now; this.epoch = now;
    if (old) { try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* already closed */ } }
  }

  /**
   * Throws the audio context away and builds a new one (and, when asked, re-opens the microphone so
   * that iOS chooses the route again). Whatever was playing is cut off; readers start the sentence over.
   */
  rebuild (reason, { reopen = false } = {}) {
    if (this._busy) return this._busy;
    this._w.lastRebuild = Date.now();
    this._note('rebuilding the sound system: ' + reason);
    this._busy = (async () => {
      try {
        this._teardownContext();
        if (this.wantMic && (reopen || !this.track || this.track.readyState !== 'live')) {
          // Letting go of the route and asking again is what makes iOS pick the new one (the car, a headset).
          this._dropStream();
          try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch (e) { /* not supported */ }
          try { await this._openStream(); } catch (e) { this._note('could not re-open the microphone: ' + describe(e)); this.dispatchEvent(new CustomEvent('mic', { detail: 'lost' })); }
          this._sessionType(true);
          await new Promise(resolve => setTimer(resolve, 200));
        }
        this._build();
        this._kick();
        if (this.wantMic && this.stream) await this._attachMic();
        this._kick();
        this._note('rebuilt: ' + this.describe());
        this.dispatchEvent(new CustomEvent('rebuilt', { detail: reason }));
      } catch (e) { this._note('rebuilding failed: ' + describe(e)); }
    })().finally(() => { this._busy = null; this._soon(); });
    return this._busy;
  }

  /** When a car, a headset or a speaker comes or goes, the route has to be taken up again. */
  _listenForDevices () {
    if (this._devicesHooked || !navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
    this._devicesHooked = true;
    this._signature().then(sig => { this._deviceSig = sig; });
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (this._deviceTimer) clearTimer(this._deviceTimer);
      this._deviceTimer = setTimer(async () => {
        this._deviceTimer = null;
        const sig = await this._signature();
        if (sig === this._deviceSig) return;
        const was = this._deviceSig; this._deviceSig = sig;
        this._note('audio devices changed: ' + (sig || 'none listed'));
        if (!this.started || Date.now() < this._quietUntil || !was) return;
        this.dispatchEvent(new CustomEvent('devices', { detail: sig }));
        // With no particular microphone chosen, follow the system to its new default (the car's, when one has just connected).
        if (this.wantMic && !this.constraints.deviceId) this.rebuild('audio devices changed', { reopen: true }); else this.kick();
      }, 900);
    });
  }

  async _signature () {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput').map(d => `${d.kind === 'audioinput' ? 'in' : 'out'}:${d.label || d.deviceId.slice(0, 6) || '?'}`).sort().join(', '); } catch (e) { return ''; }
  }

  /** iOS 26 and desktop browsers: lets the listener pick where sound plays. Needs a tap. */
  async chooseOutput () {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.selectAudioOutput !== 'function') throw new Error('This browser has no output chooser.');
    const d = await navigator.mediaDevices.selectAudioOutput();
    this._note('output chosen: ' + (d && d.label ? d.label : 'default'));
    this._kick();
    return d;
  }

  /** One line on how things stand, for the log and the troubleshooting screen. */
  describe () {
    const c = this.ctx; const t = this.track;
    return `${this.mode || 'no'} output, context ${c ? c.state + ' at ' + c.sampleRate + ' Hz' : 'none'}${this.mode === 'element' && this.el ? ', element ' + (this.el.paused ? 'paused' : 'playing') : ''}; microphone ${t ? `"${t.label}" ${t.readyState}${t.muted ? ' muted' : ''}${this.micInfo.sampleRate ? ' ' + this.micInfo.sampleRate + ' Hz' : ''}${this.micInfo.echoCancellation === false ? ', no echo cancellation' : ''}, frames ${this.beat.at ? Math.round((Date.now() - this.beat.at) / 100) / 10 + ' s ago' : 'never'}` : (this.wantMic ? 'wanted but not open' : 'off')}`;
  }

  /** Everything the troubleshooting report wants to know. */
  async report () {
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind !== 'videoinput').map(d => `${d.kind}: ${d.label || '(no name until the microphone is allowed)'}`); } catch (e) { /* none */ }
    let session = 'not supported';
    try { if (navigator.audioSession) session = navigator.audioSession.type + (navigator.audioSession.state ? ' / ' + navigator.audioSession.state : ''); } catch (e) { /* none */ }
    return {
      now: this.describe(), health: this.health.ok ? 'ok' : this.health.problems.join('; '), session, devices,
      outputChooser: !!(navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput),
      latencyMs: Math.round(this.latency * 1000), level: this.beat.rms ? +(20 * Math.log10(Math.max(1e-6, this.beat.rms))).toFixed(0) : null,
      events: this.events.slice(-40)
    };
  }

  // ---- playing ----------------------------------------------------------------------------

  /**
   * Up to 1× the volume is a plain gain. Above 1× the extra is put into each clip as it is played,
   * with its peaks pressed down to fit (see _forOutput), so that louder never means clipped.
   */
  setVolume (v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(Math.min(1, v), this.ctx.currentTime, 0.02); }

  /**
   * The samples as they will be handed to the sound system: at the context's own rate (the browser
   * is never left to convert, see dsp.js), and with any volume above 1× already applied.
   */
  _forOutput (samples, sampleRate, rate) {
    let data = samples;
    if (Math.round(sampleRate) !== rate) {
      const had = this._converted.get(samples);
      if (had && had.rate === rate) data = had.samples; else {
        data = resample(samples, sampleRate, rate);
        this._converted.set(samples, { rate, samples: data });
        this.played.converted++;
      }
    }
    const boost = Math.max(1, this.volume);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = data[i] < 0 ? -data[i] : data[i]; if (a > peak) peak = a; }
    if (peak * boost > FULL) {
      // Never the cached or the caller's samples: they are played again at other volumes.
      const r = limit(new Float32Array(data), rate, { gain: boost, ceiling: FULL });
      data = r.samples; this.played.pressed++;
      return { data, gain: 1 };
    }
    return { data, gain: boost };
  }

  /**
   * Plays mono samples. Returns a handle with the scheduled start time, the duration, a promise
   * that settles when playback ends ('ended') or is cut short ('stopped'), and stop().
   * `when` and the handle's times are on the engine's clock.
   */
  play (samples, sampleRate, { when = 0, offset = 0, gain = 1 } = {}) {
    const ctx = this.ctx;
    const epoch = this.epoch;
    if (!ctx || !this.master) {
      // Asked to play in the moment the sound system is being rebuilt: report it as cut short, a
      // little later, so that a reader simply tries the sentence again.
      const now = this.time; let off; let over = false;
      const ended = new Promise(resolve => { off = () => { if (!over) { over = true; resolve('stopped'); } }; });
      setTimer(off, 250);
      return { startAt: now, offset: 0, duration: 0, endAt: now, ended, position: () => 0, stop: () => off(), abandon: () => off() };
    }
    const out = this._forOutput(samples, sampleRate, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, Math.max(1, out.data.length), ctx.sampleRate);
    buffer.getChannelData(0).set(out.data);
    this.played.clips++;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain(); g.gain.value = gain * out.gain;
    src.connect(g); g.connect(this.master);
    const startCtx = Math.max(ctx.currentTime + 0.01, (when || 0) - epoch);
    const off = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.01));
    const duration = buffer.duration - off;
    let settle; let stopped = false; let done = false; let guard = null;
    const ended = new Promise(resolve => { settle = resolve; });
    const finish = () => { if (done) return; done = true; this.live.delete(handle); if (guard) clearTimer(guard); settle(stopped ? 'stopped' : 'ended'); };
    const handle = {
      startAt: epoch + startCtx, offset: off, duration, endAt: epoch + startCtx + duration, ended,
      /** Seconds of this buffer played so far (including the starting offset). */
      position: () => Math.min(buffer.duration, Math.max(off, off + ctx.currentTime - startCtx)),
      stop: (fade = 0.015) => {
        if (done) return;
        stopped = true;
        try { g.gain.cancelScheduledValues(ctx.currentTime); g.gain.setValueAtTime(g.gain.value, ctx.currentTime); g.gain.linearRampToValueAtTime(0, ctx.currentTime + fade); src.stop(ctx.currentTime + fade + 0.005); } catch (e) { /* not started or already stopped */ }
        // A context that is not running never reports the end: settle regardless.
        setTimer(finish, (fade + 0.06) * 1000);
      },
      /** The context this was playing on is gone. */
      abandon: () => { stopped = true; try { src.stop(); } catch (e) { /* never started */ } finish(); }
    };
    src.onended = finish;
    // Belt and braces for a missing "ended" event. It follows the audio clock, not the wall clock:
    // while sound is stalled a sentence is not counted as said.
    const check = () => {
      guard = null;
      if (done) return;
      if (this.ctx !== ctx) { handle.abandon(); return; }
      if (ctx.currentTime >= startCtx + duration + 0.4) { finish(); return; }
      guard = setTimer(check, 400);
    };
    guard = setTimer(check, Math.max(0, startCtx - ctx.currentTime + duration) * 1000 + 500);
    src.start(startCtx, off);
    this.live.add(handle);
    return handle;
  }

  stopAll () { for (const h of [...this.live]) h.stop(); }

  /** Short synthesised signal tones: instant feedback that needs no speech. */
  tone (name, { gain = 1 } = {}) {
    if (!this.ctx) return 0;
    const spec = TONES[name];
    if (!spec) return 0;
    const ctx = this.ctx; const t0 = ctx.currentTime + 0.01;
    let end = 0;
    for (const [freq, at, dur, peak, type] of spec) {
      const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = freq;
      const g = ctx.createGain();
      const a = t0 + at; const level = Math.min(0.9, peak * gain * 0.6 * Math.max(1, this.volume));
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(level, a + 0.008);
      g.gain.setValueAtTime(level, a + Math.max(0.01, dur - 0.03));
      g.gain.linearRampToValueAtTime(0, a + dur);
      osc.connect(g); g.connect(this.master);
      osc.start(a); osc.stop(a + dur + 0.02);
      end = Math.max(end, at + dur);
    }
    return end;
  }

  /** Kept for callers that want to nudge and look: never waits on the browser. */
  async resume () { this.kick(); return this.state; }
}
