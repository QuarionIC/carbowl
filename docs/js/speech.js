// Main-thread clients for the two speech workers, plus the model downloader.

export const CACHE_NAME = 'carbowl-models-v1';

export const VOICES = {
  supertonic: { label: 'Natural (Supertonic)', bundles: ['tts-supertonic'], speakers: 10, speakerNames: ['Female 1', 'Female 2', 'Female 3', 'Female 4', 'Female 5', 'Male 1', 'Male 2', 'Male 3', 'Male 4', 'Male 5'] },
  'piper-lessac': { label: 'Plain (Piper)', bundles: ['tts-piper-lessac', 'phonemizer'], speakers: 1, speakerNames: ['Lessac'] }
};
export const RECOGNIZERS = {
  'moonshine-base': { label: 'Accurate', bundles: ['asr-moonshine-base', 'vad'] },
  'moonshine-tiny': { label: 'Light', bundles: ['asr-moonshine-tiny', 'vad'] }
};

export async function loadManifest (base) {
  const res = await fetch(new URL('models/manifest.json', base), { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load the model list (HTTP ' + res.status + ').');
  return res.json();
}

/** Every network file needed for the chosen voice and recogniser: [{ path, size }]. */
export function requiredFiles (manifest, { voice, asr }) {
  const names = ['runtime', ...(VOICES[voice] || VOICES.supertonic).bundles, ...(RECOGNIZERS[asr] || RECOGNIZERS['moonshine-base']).bundles];
  const files = [];
  for (const name of names) {
    const b = manifest.bundles[name];
    if (!b) throw new Error('Missing model bundle: ' + name);
    for (const f of b.files) { if (f.parts) files.push(...f.parts); else files.push({ path: f.path, size: f.size }); }
  }
  return files;
}

async function openCache () {
  if (!('caches' in self)) return null;
  try { return await caches.open(CACHE_NAME); } catch (e) { return null; }
}

/** How much of the required set is already stored on this device. */
export async function cacheStatus (base, files) {
  const cache = await openCache();
  let have = 0; let total = 0; const missing = [];
  for (const f of files) {
    total += f.size;
    let hit = false;
    if (cache) { try { hit = !!(await cache.match(new URL(f.path, base).href)); } catch (e) { hit = false; } }
    if (hit) have += f.size; else missing.push(f);
  }
  return { have, total, missing, cacheAvailable: !!cache };
}

/**
 * Downloads missing files into the cache, reporting bytes as they arrive.
 * Without a cache (private browsing) the files are simply fetched so the HTTP cache warms up.
 */
export async function downloadModels (base, files, { onProgress, signal } = {}) {
  const cache = await openCache();
  const status = await cacheStatus(base, files);
  let done = status.have;
  const report = () => { if (onProgress) onProgress(done, status.total); };
  report();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
  for (const f of status.missing) {
    const url = new URL(f.path, base).href;
    let attempt = 0;
    for (;;) {
      attempt++;
      const before = done;
      try {
        const res = await fetch(url, { signal, cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.path}`);
        const chunks = []; let got = 0;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          for (;;) { const { done: end, value } = await reader.read(); if (end) break; chunks.push(value); got += value.length; done = before + got; report(); }
        } else { const b = new Uint8Array(await res.arrayBuffer()); chunks.push(b); got = b.length; }
        if (got !== f.size) throw new Error(`${f.path}: got ${got} bytes, expected ${f.size}`);
        if (cache) {
          const type = f.path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
          await cache.put(url, new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type, 'Content-Length': String(got) } }));
        }
        done = before + f.size; report();
        break;
      } catch (e) {
        done = before; report();
        if ((signal && signal.aborted) || attempt >= 4) throw e;
        await new Promise(resolve => setTimeout(resolve, 800 * attempt));
      }
    }
  }
  return { bytes: status.total };
}

export async function clearModelCache () { try { await caches.delete(CACHE_NAME); } catch (e) { /* nothing to clear */ } }

class WorkerClient extends EventTarget {
  constructor (url, name, log) {
    super();
    this.log = log || (() => {});
    this.name = name;
    this.worker = new Worker(url, { name });
    this.ready = null;
    this.info = null;
    this.worker.onmessage = e => this._onMessage(e.data);
    this.worker.onerror = e => {
      const msg = `${name} worker crashed: ${e.message || 'unknown error'}`;
      this.log(msg);
      if (this._rejectReady) this._rejectReady(new Error(msg));
      this.dispatchEvent(new CustomEvent('crash', { detail: msg }));
    };
  }

  _init (msg) {
    this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    this.worker.postMessage(msg);
    return this.ready;
  }

  terminate () { try { this.worker.terminate(); } catch (e) { /* gone */ } }
}

/** Speech synthesis: text in, audio samples out. */
export class TtsClient extends WorkerClient {
  constructor ({ base, log }) {
    super(new URL('js/workers/tts-worker.js', base), 'carbowl-speech', log);
    this.base = base;
    this.nextId = 1;
    this.pending = new Map();
    this.stats = { jobs: 0, genMs: 0, audioMs: 0 };
    this.byQuality = new Map(); // refinement steps -> { jobs, genMs, audioMs }
    this.recent = [];           // the last sentences generated: { steps, speed, genMs, audioMs }
    this.outRate = 0;
  }

  /** Generation statistics for one quality setting. */
  statsFor (steps) { return this.byQuality.get(steps) || { jobs: 0, genMs: 0, audioMs: 0 }; }

  /**
   * How fast speech is being generated lately at one quality setting: time taken divided by the
   * length of the speech (0.5 = twice as fast as it is spoken; above 1 the reader cannot keep up).
   * @returns {{ jobs: number, factor: number }} over the last `last` sentences of 1.5 s or more
   */
  recentFactor (steps, last = 8) {
    const rows = this.recent.filter(r => r.steps === steps).slice(-last);
    let gen = 0; let audio = 0;
    for (const r of rows) { gen += r.genMs; audio += r.audioMs; }
    return { jobs: rows.length, factor: audio ? gen / audio : 0 };
  }

  init ({ manifest, voice }) { return this._init({ type: 'init', base: String(this.base), manifest, voice, outRate: this.outRate }); }

  /**
   * Tells the worker which rate the sound system runs at, so that speech arrives already at that
   * rate (converted properly, and off the page's thread). Clips made before the rate was known, or
   * for another rate, are converted when played.
   */
  setOutputRate (rate) {
    rate = rate > 0 ? Math.round(rate) : 0;
    if (rate === this.outRate) return;
    this.outRate = rate;
    this.worker.postMessage({ type: 'rate', sampleRate: rate });
  }

  _onMessage (m) {
    if (m.type === 'ready') { this.info = m; this._resolveReady(m); } else if (m.type === 'error') { this.log('speech worker: ' + m.error); if (this._rejectReady) this._rejectReady(new Error(m.error)); } else if (m.type === 'log') this.log('speech worker: ' + m.text);
    else if (m.type === 'audio') {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      this.stats.jobs++; this.stats.genMs += m.genMs; this.stats.audioMs += m.audioMs;
      if (p && p.steps !== undefined && m.audioMs >= 1500) { // very short clips say little about sustained speed
        const q = this.byQuality.get(p.steps) || { jobs: 0, genMs: 0, audioMs: 0 };
        q.jobs++; q.genMs += m.genMs; q.audioMs += m.audioMs; this.byQuality.set(p.steps, q);
        this.recent.push({ steps: p.steps, speed: p.speed, genMs: m.genMs, audioMs: m.audioMs });
        if (this.recent.length > 60) this.recent.splice(0, 20);
      }
      if (p) p.resolve({ samples: m.samples, sampleRate: m.sampleRate, genMs: m.genMs, audioMs: m.audioMs, limited: m.limited });
    } else if (m.type === 'failed') {
      const p = this.pending.get(m.id); this.pending.delete(m.id);
      if (p) p.reject(Object.assign(new Error(m.error), { cancelled: m.error === 'cancelled' }));
    }
  }

  /** Average generation time divided by audio duration; above ~0.8 the reader cannot keep up. */
  get realTimeFactor () { return this.stats.audioMs ? this.stats.genMs / this.stats.audioMs : 0; }

  /** @returns {{ id: number, promise: Promise<{samples: Float32Array, sampleRate: number}> }} */
  speak (text, { sid = 0, speed = 1, steps = 5, priority = 5, group = '' } = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, steps, speed }); });
    promise.catch(() => {}); // callers attach their own handlers; avoid unhandled-rejection noise for cancellations
    this.worker.postMessage({ type: 'speak', id, text, sid, speed, steps, priority, group });
    return { id, promise };
  }

  cancel ({ group, ids, all } = {}) { this.worker.postMessage({ type: 'cancel', group, ids, all }); }
}

/** Listening: utterances out. */
export class ListenClient extends WorkerClient {
  constructor ({ base, log }) {
    super(new URL('js/workers/listen-worker.js', base), 'carbowl-listen', log);
    this.base = base;
    this.modeId = 0;
    this.mode = 'off';
    this.transcripts = new Map();
    this.nextId = 1;
    this.level = { rms: 0, peak: 0, speaking: false, t: 0 };
  }

  init ({ manifest, asr, vadThreshold }) { return this._init({ type: 'init', base: String(this.base), manifest, asr, vadThreshold }); }

  _onMessage (m) {
    switch (m.type) {
      case 'ready': this.info = m; this._resolveReady(m); break;
      case 'error': this.log('listening worker: ' + m.error); if (m.fatal && this._rejectReady) this._rejectReady(new Error(m.error)); this.dispatchEvent(new CustomEvent('workererror', { detail: m.error })); break;
      case 'log': this.log('listening worker: ' + m.text); break;
      case 'level': this.level = m; this.dispatchEvent(new CustomEvent('level', { detail: m })); break;
      case 'transcript': { const p = this.transcripts.get(m.id); this.transcripts.delete(m.id); if (p) p(m); break; }
      case 'utterance': case 'speechstart': case 'speechend':
        // Results that belong to an earlier mode are stale: the game has moved on.
        if (m.modeId === this.modeId) this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
        break;
      default: break;
    }
  }

  /** Creates the channel the capture worklet writes microphone frames to; returns the worklet's end. */
  createAudioPort () {
    const ch = new MessageChannel();
    this.worker.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    return ch.port2;
  }

  /** Stops listening to any microphone channel; frames are then taken from feed() (the scripted microphone of the self-tests). */
  detachPorts () { this.worker.postMessage({ type: 'port', port: null }); }

  /** @param {'off'|'spot'|'answer'} mode  @param {{ since?: number }} [o] re-examine audio from this AudioContext time */
  setMode (mode, { since } = {}) {
    this.modeId++; this.mode = mode;
    this.worker.postMessage({ type: 'mode', mode, id: this.modeId, since });
    return this.modeId;
  }

  feed (samples, t) { this.worker.postMessage({ type: 'feed', samples, t }, [samples.buffer]); }

  /** One-off transcription of a clip (any sample rate); resolves to { text, asrMs }. */
  transcribe (samples, sampleRate = 16000) {
    const id = this.nextId++;
    return new Promise(resolve => { this.transcripts.set(id, resolve); this.worker.postMessage({ type: 'transcribe', id, samples, sampleRate }); });
  }
}
