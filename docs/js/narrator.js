// The reader: turns text into speech through the synthesis worker and plays it sentence by
// sentence, keeping track of exactly which character is being spoken at any moment (needed to
// know where a buzz landed, and to resume after an interruption).

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Narrator {
  /**
   * @param {object} o
   * @param {import('./speech.js').TtsClient} o.tts
   * @param {import('./audio.js').AudioEngine} o.audio
   * @param {() => { sid: number, speed: number, steps: number }} o.voice current voice settings
   */
  constructor ({ tts, audio, voice, log }) {
    this.tts = tts; this.audio = audio; this.voice = voice; this.log = log || (() => {});
    this.cache = new Map();   // key -> Promise<audio>
    this.pinned = new Set();  // keys never evicted (fixed phrases)
    this.current = null;      // the Reading or one-off phrase now playing
    this.groupN = 0;
  }

  _key (text, v) { return `${v.sid}|${v.speed}|${v.steps}|${text}`; }

  /** Synthesis quality follows how fast this device generates speech, so the reader never falls behind. */
  _voice () {
    const v = { ...this.voice() };
    const rtf = this.tts.realTimeFactor;
    if (this.tts.stats.jobs >= 4 && v.steps > 2) {
      if (rtf > 1.0) v.steps = 2; else if (rtf > 0.7) v.steps = Math.min(v.steps, 3);
    }
    return v;
  }

  /** Starts (or reuses) synthesis of a piece of text. */
  synth (text, { priority = 5, group = '', pin = false, voice } = {}) {
    const v = voice || this._voice();
    const key = this._key(text, v);
    let p = this.cache.get(key);
    if (!p) {
      const job = this.tts.speak(text, { ...v, priority, group });
      p = job.promise.then(a => { if (!a.samples.length) throw new Error('empty audio'); return a; });
      p.catch(() => { if (this.cache.get(key) === p) this.cache.delete(key); });
      this.cache.set(key, p);
      if (this.cache.size > 90) {
        for (const k of this.cache.keys()) { if (this.cache.size <= 70) break; if (!this.pinned.has(k) && k !== key) this.cache.delete(k); }
      }
    }
    if (pin) this.pinned.add(key);
    return p;
  }

  /** Pre-generates fixed phrases so feedback such as "Correct" is instant. */
  async preload (phrases, { onProgress } = {}) {
    let done = 0;
    await Promise.all(phrases.map(t => this.synth(t, { priority: 8, pin: true }).catch(e => this.log(`could not prepare "${t}": ${e.message}`)).then(() => { done++; if (onProgress) onProgress(done, phrases.length); })));
  }

  newGroup (label = 'g') { return `${label}-${++this.groupN}`; }
  cancelGroup (group) { if (group) this.tts.cancel({ group }); }

  /** Stops whatever is being spoken right now. */
  stop () { if (this.current) this.current.stop(); }

  /**
   * Speaks one short piece of text and resolves when it has finished ('ended') or was cut ('stopped').
   * A phrase that cannot be synthesised resolves as 'failed' rather than throwing: the game must go on.
   */
  async say (text, { priority = 1, group = '', gain = 1 } = {}) {
    if (!text) return 'ended';
    let audio;
    try { audio = await this.synth(text, { priority, group }); } catch (e) { this.log(`speech failed for "${text.slice(0, 40)}": ${e.message}`); return 'failed'; }
    // A paused reading stays paused underneath a phrase ("Quiz paused"); anything audible is cut.
    const under = this.current && this.current.kind === 'reading' && this.current.state === 'paused' ? this.current : null;
    if (this.current && !under) this.current.stop();
    const handle = this.audio.play(audio.samples, audio.sampleRate, { gain });
    const me = { stop: () => handle.stop(), text, kind: 'phrase', startAt: handle.startAt, endAt: handle.endAt };
    this.current = me;
    const how = await handle.ended;
    if (this.current === me) this.current = under && under.state !== 'stopped' && under.state !== 'finished' ? under : null;
    return how;
  }

  /**
   * Reads chunks in order.
   * @param {{ text: string, start: number, end: number }[]} chunks
   * @param {{ group?: string, gap?: number, lookahead?: number, onProgress?: (offset: number) => void, from?: number }} [o]
   *   gap: pause between chunks in seconds; from: character offset to start at
   * @returns {Reading}
   */
  read (chunks, o = {}) {
    if (this.current) this.current.stop();
    const reading = new Reading(this, chunks, o);
    this.current = reading;
    reading.done.then(() => { if (this.current === reading) this.current = null; });
    return reading;
  }

  /** Queues synthesis for the first chunks of something that will be read soon. */
  prepare (chunks, { group = '', count = 2, priority = 6 } = {}) {
    for (const c of chunks.slice(0, count)) this.synth(c.text, { priority, group }).catch(() => {});
  }
}

export class Reading {
  constructor (narrator, chunks, { group = '', gap = 0.12, lookahead = 2, onProgress, from = 0 } = {}) {
    this.n = narrator; this.chunks = chunks; this.group = group; this.gap = gap; this.lookahead = lookahead; this.onProgress = onProgress;
    this.kind = 'reading';
    this.timeline = [];       // { i, startAt, offset, bufferDur, endAt }
    this.state = 'reading';   // reading | paused | stopped | finished
    this.handle = null;
    this.pausedAt = null;     // { i, sec }
    this.underruns = 0;
    this.index = 0;
    this.startOffset = from;
    this._wake = null;
    this.done = this._run().catch(e => { this.n.log('reader error: ' + (e && e.message)); this.state = 'stopped'; return 'stopped'; });
    this._ticker = setInterval(() => { if (this.onProgress && this.state === 'reading') this.onProgress(this.position()); }, 120);
    this.done.then(() => clearInterval(this._ticker));
  }

  _queueAhead (i) {
    for (let k = i; k < Math.min(this.chunks.length, i + 1 + this.lookahead); k++) this.n.synth(this.chunks[k].text, { priority: k === i ? 0 : 2 + (k - i), group: this.group }).catch(() => {});
  }

  async _run () {
    const { chunks } = this;
    let i = 0; let startSec = 0;
    if (this.startOffset > 0) {
      i = chunks.findIndex(c => c.end > this.startOffset); if (i < 0) return this._finish('finished');
    }
    let fraction = this.startOffset > chunks[i]?.start ? (this.startOffset - chunks[i].start) / Math.max(1, chunks[i].end - chunks[i].start) : 0;
    let nextStart = 0;
    while (i < chunks.length) {
      if (this.state === 'stopped') return 'stopped';
      if (this.state === 'paused') { await new Promise(resolve => { this._wake = resolve; }); continue; }
      this.index = i;
      this._queueAhead(i);
      let audio;
      const waitFrom = performance.now();
      try { audio = await this.n.synth(chunks[i].text, { priority: 0, group: this.group }); } catch (e) {
        if (this.state === 'stopped') return 'stopped';
        // One retry, then skip the sentence rather than stall the whole question.
        try { await sleep(150); audio = await this.n.synth(chunks[i].text, { priority: 0, group: this.group }); } catch (e2) { this.n.log(`skipping a sentence that would not synthesise: ${e2.message}`); i++; fraction = 0; continue; }
      }
      if (this.state === 'stopped') return 'stopped';
      if (this.state === 'paused') continue;
      if (this.pausedAt && this.pausedAt.i === i) { startSec = this.pausedAt.sec; this.pausedAt = null; } else if (fraction > 0) { startSec = Math.max(0, fraction * (audio.samples.length / audio.sampleRate) - 0.3); fraction = 0; } else startSec = 0;
      const now = this.n.audio.time;
      if (nextStart && now > nextStart + 0.25 && performance.now() - waitFrom > 250) this.underruns++;
      const handle = this.n.audio.play(audio.samples, audio.sampleRate, { when: Math.max(now + 0.02, nextStart), offset: startSec });
      this.handle = handle;
      const bufferDur = audio.samples.length / audio.sampleRate;
      this.timeline.push({ i, startAt: handle.startAt, offset: startSec, bufferDur, endAt: handle.endAt });
      this._queueAhead(i + 1);
      const how = await handle.ended;
      this.handle = null;
      if (this.state === 'stopped') return 'stopped';
      if (this.state === 'paused' || how === 'stopped') continue; // replay this chunk from the pause point
      nextStart = handle.endAt + this.gap;
      i++;
    }
    return this._finish('finished');
  }

  _finish (how) { if (this.state !== 'stopped') this.state = how; this.endedAt = this.n.audio.time; return this.state === 'stopped' ? 'stopped' : how; }

  /** Character offset being spoken at the given AudioContext time (default: now). */
  positionAt (t = this.n.audio.time) {
    let last = null;
    for (const seg of this.timeline) { if (seg.startAt <= t) last = seg; else break; }
    if (!last) return this.timeline.length ? this.chunks[this.timeline[0].i].start : (this.startOffset || 0);
    const c = this.chunks[last.i];
    const sec = Math.min(last.bufferDur, last.offset + Math.max(0, t - last.startAt));
    const stoppedEarly = last.stoppedAt !== undefined ? Math.min(sec, last.stoppedAt) : sec;
    return Math.round(c.start + (c.end - c.start) * Math.min(1, stoppedEarly / Math.max(0.05, last.bufferDur)));
  }

  position () { return this.state === 'finished' ? (this.chunks.length ? this.chunks[this.chunks.length - 1].end : 0) : this.positionAt(); }

  /** Text spoken between two AudioContext times (used to recognise our own voice coming back as echo). */
  textBetween (t0, t1, fullText) {
    const a = this.positionAt(t0); const b = this.positionAt(t1);
    return fullText.slice(Math.max(0, a - 12), Math.min(fullText.length, b + 12));
  }

  /** True while sound is (or is about to be) coming out. */
  get speaking () { return this.state === 'reading'; }

  _markStop () {
    const seg = this.timeline[this.timeline.length - 1];
    if (seg && this.handle) seg.stoppedAt = this.handle.position();
  }

  pause () {
    if (this.state !== 'reading') return;
    this.state = 'paused';
    if (this.handle) { this._markStop(); this.pausedAt = { i: this.index, sec: Math.max(0, this.handle.position() - 0.35) }; this.handle.stop(0.03); }
  }

  resume () {
    if (this.state !== 'paused') return;
    this.state = 'reading';
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
  }

  stop () {
    if (this.state === 'stopped' || this.state === 'finished') return;
    const wasPaused = this.state === 'paused';
    this.state = 'stopped';
    if (this.handle) { this._markStop(); this.handle.stop(); }
    if (wasPaused && this._wake) { const w = this._wake; this._wake = null; w(); }
    this.n.cancelGroup(this.group);
  }
}
