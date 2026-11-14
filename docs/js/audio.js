// Audio engine: one AudioContext for everything. Plays synthesised speech and short tones, and
// captures the microphone through a worklet that feeds the listening worker.
// Playing our own speech through Web Audio (not the system voice) is what lets the browser's echo
// canceller remove it from the microphone, so a spoken "buzz" can be heard while a question is read.

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
  power: [[1047, 0, 0.08, 0.4, 'sine'], [1319, 0.08, 0.08, 0.4, 'sine'], [1568, 0.16, 0.08, 0.4, 'sine'], [2093, 0.24, 0.22, 0.4, 'sine']]
};

export class AudioEngine extends EventTarget {
  constructor ({ log } = {}) {
    super();
    this.log = log || (() => {});
    this.ctx = null;
    this.master = null;
    this.stream = null;
    this.source = null;
    this.capture = null;
    this.sinkPort = null;
    this.live = new Set();
    this.volume = 1;
    this.micInfo = {};
    this.started = false;
  }

  get time () { return this.ctx ? this.ctx.currentTime : 0; }
  get sampleRate () { return this.ctx ? this.ctx.sampleRate : 0; }
  get state () { return this.ctx ? this.ctx.state : 'closed'; }
  /** Seconds between scheduling a sound and hearing it (0 when the browser does not say). */
  get latency () { return this.ctx ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0; }

  /** Must be called from a tap or click: browsers only start audio and open the mic on a user gesture. */
  async start ({ mic = true, constraints = {}, workletUrl } = {}) {
    // iOS: say up front that we both play and record, so the route does not flip when the mic opens.
    try { if (navigator.audioSession && (mic || !this.ctx)) navigator.audioSession.type = mic ? 'play-and-record' : 'playback'; } catch (e) { this.log('audioSession type not set: ' + e.message); }
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.ctx.addEventListener('statechange', () => {
        this.log('audio context state: ' + this.ctx.state);
        this.dispatchEvent(new CustomEvent('state', { detail: this.ctx.state }));
      });
      this._keepAlive();
    }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { this.log('resume failed: ' + e.message); } }
    if (mic && !this.stream) {
      await this.openMic({ constraints, workletUrl });
      // The permission prompt (and the switch to a recording route on iOS) can leave the context suspended.
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { this.log('resume after opening the microphone failed: ' + e.message); } }
    }
    this.started = true;
  }

  /** A barely audible noise bed keeps the output (and a Bluetooth link) from going to sleep between sentences. */
  _keepAlive () {
    const n = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.00015;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(this.ctx.destination);
    src.start();
    this._bed = src;
  }

  async openMic ({ constraints = {}, workletUrl } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open the microphone.');
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...constraints };
    for (const k of Object.keys(audio)) if (audio[k] === undefined || audio[k] === '') delete audio[k];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.micInfo = { label: track.label, sampleRate: settings.sampleRate, echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, deviceId: settings.deviceId };
    this.log('microphone open: ' + JSON.stringify(this.micInfo));
    track.addEventListener('ended', () => { this.log('microphone track ended'); this.dispatchEvent(new CustomEvent('mic', { detail: 'ended' })); });
    track.addEventListener('mute', () => { this.log('microphone muted by the system'); this.dispatchEvent(new CustomEvent('mic', { detail: 'muted' })); });
    track.addEventListener('unmute', () => { this.log('microphone unmuted'); this.dispatchEvent(new CustomEvent('mic', { detail: 'unmuted' })); });
    if (!this._workletLoaded) { await this.ctx.audioWorklet.addModule(workletUrl || new URL('./workers/capture-worklet.js', import.meta.url).href); this._workletLoaded = true; }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.ctx, 'carbowl-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    this.source.connect(this.capture);
    // The worklet only runs while it is part of a path to the destination; route it through a muted gain.
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.capture.connect(mute); mute.connect(this.ctx.destination);
    if (this.sinkPort) this.capture.port.postMessage({ port: this.sinkPort }, [this.sinkPort]);
  }

  /** Hands the worklet a MessagePort on which to deliver microphone frames (the listening worker's end). */
  setSink (port) {
    if (this.capture) this.capture.port.postMessage({ port }, [port]);
    else this.sinkPort = port;
  }

  closeMic () {
    try { if (this.source) this.source.disconnect(); if (this.capture) this.capture.disconnect(); } catch (e) { /* already disconnected */ }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null; this.source = null; this.capture = null;
  }

  async reopenMic (opts) { this.closeMic(); await this.openMic(opts); }

  async devices () {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || 'Microphone' })); } catch (e) { return []; }
  }

  setVolume (v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /**
   * Plays mono samples. Returns a handle with the scheduled start time, the duration, a promise
   * that settles when playback ends ('ended') or is cut short ('stopped'), and stop().
   */
  play (samples, sampleRate, { when = 0, offset = 0, gain = 1 } = {}) {
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    const startAt = Math.max(ctx.currentTime + 0.01, when || 0);
    const off = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.01));
    let settle; let stopped = false; let done = false;
    const ended = new Promise(resolve => { settle = resolve; });
    const handle = {
      startAt, offset: off, duration: buffer.duration - off, endAt: startAt + buffer.duration - off, ended,
      /** Seconds of this buffer played so far (including the starting offset). */
      position: () => Math.min(buffer.duration, Math.max(off, off + ctx.currentTime - startAt)),
      stop: (fade = 0.015) => {
        if (done) return;
        stopped = true;
        try { g.gain.cancelScheduledValues(ctx.currentTime); g.gain.setValueAtTime(g.gain.value, ctx.currentTime); g.gain.linearRampToValueAtTime(0, ctx.currentTime + fade); src.stop(ctx.currentTime + fade + 0.005); } catch (e) { /* not started or already stopped */ }
      }
    };
    const finish = () => { if (done) return; done = true; this.live.delete(handle); clearTimeout(guard); settle(stopped ? 'stopped' : 'ended'); };
    src.onended = finish;
    // Belt and braces: if the browser never fires "ended" (suspended context), settle anyway.
    const guard = setTimeout(finish, Math.max(0, (startAt - ctx.currentTime) + handle.duration) * 1000 + 1500);
    src.start(startAt, off);
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
      const a = t0 + at; const level = peak * gain * 0.6;
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

  async resume () {
    if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (e) { this.log('resume failed: ' + e.message); } }
    return this.ctx ? this.ctx.state : 'closed';
  }
}
