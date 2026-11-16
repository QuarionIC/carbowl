/* Microphone capture: runs on the audio thread, converts the microphone signal from the device
 * rate (usually 48 kHz) to 16 kHz mono with a band-limited (windowed-sinc, polyphase) resampler,
 * and posts 40 ms frames stamped with the AudioContext time of their last sample.
 * Frames go to the port handed over in a { port } message (the listening worker), or back to the
 * main thread until that arrives.
 */
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentTime */
'use strict';

const TARGET = 16000;
const FRAME = 640;
const HALF = 12;    // sinc half-width, in zero crossings
const PHASES = 64;  // sub-sample positions kept in the filter table
const SILENCE = new Float32Array(128);

class CaptureProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super();
    // The page keeps one clock across audio contexts; this context's share of it starts at `offset`.
    this.offset = (options && options.processorOptions && Number(options.processorOptions.offset)) || 0;
    this.frames = 0; this.beatAcc = 0; this.beatN = 0; this.sawInput = false;
    this.ratio = sampleRate / TARGET;            // input samples per output sample
    const cutoff = Math.min(1, TARGET / sampleRate) * 0.92;
    this.reach = Math.ceil(HALF / cutoff);       // input samples used either side of a centre
    this.taps = 2 * this.reach + 1;
    // table[phase * taps + k] = weight of input sample (i0 - reach + k) for a centre at i0 + phase/PHASES
    this.table = new Float32Array(PHASES * this.taps);
    for (let p = 0; p < PHASES; p++) {
      let sum = 0;
      for (let k = 0; k < this.taps; k++) {
        const x = (k - this.reach - p / PHASES) * cutoff;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = Math.abs(x) >= HALF ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x / HALF);
        const v = sinc * w;
        this.table[p * this.taps + k] = v; sum += v;
      }
      for (let k = 0; k < this.taps; k++) this.table[p * this.taps + k] /= sum;
    }
    this.size = 4096;
    this.hist = new Float32Array(this.size);     // circular history of input samples
    this.inCount = 0;                            // input samples seen
    this.nextOut = this.reach + 1;               // position (in input samples) of the next output sample
    this.out = new Float32Array(FRAME);
    this.outN = 0;
    this.sink = null;
    this.gain = 1;
    this.stopped = false;
    this.port.onmessage = e => {
      if (e.data && e.data.port) this.sink = e.data.port;
      if (e.data && typeof e.data.gain === 'number') this.gain = e.data.gain;
      // A replaced microphone path must fall silent at once: left running, it would keep sending
      // frames beside the new one and the listener would hear everything twice.
      if (e.data && e.data.stop) { this.stopped = true; this.sink = null; }
    };
  }

  process (inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    // With nothing connected (or a muted track) the browser passes no channels: treat that as
    // silence so that time keeps moving for the listener and end-of-speech is still detected.
    const present = !!(input && input.length && input[0]);
    if (present) this.sawInput = true;
    const ch0 = present ? input[0] : SILENCE;
    const ch1 = input && input.length > 1 ? input[1] : null;
    const n = ch0.length; const size = this.size; const hist = this.hist; const mask = size - 1;
    for (let i = 0; i < n; i++) hist[(this.inCount + i) & mask] = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
    this.inCount += n;
    const reach = this.reach; const taps = this.taps; const table = this.table;
    while (this.nextOut + reach + 1 < this.inCount) {
      let i0 = Math.floor(this.nextOut);
      let phase = Math.round((this.nextOut - i0) * PHASES);
      if (phase === PHASES) { phase = 0; i0 += 1; }
      const base = phase * taps; const first = i0 - reach;
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += hist[(first + k) & mask] * table[base + k];
      const v = this.gain * acc;
      this.out[this.outN++] = v;
      this.beatAcc += v * v; this.beatN++;
      this.nextOut += this.ratio;
      if (this.outN === FRAME) {
        const frame = this.out; this.out = new Float32Array(FRAME); this.outN = 0;
        // Time of the newest input sample, minus the stretch of input not yet turned into output.
        const t = this.offset + currentTime + n / sampleRate - (this.inCount - this.nextOut) / sampleRate;
        (this.sink || this.port).postMessage({ samples: frame, t }, [frame.buffer]);
        this.frames++;
        // Twice a second the page is told that frames are flowing (they go straight to the listening
        // worker, so the page would otherwise never know), how loud they are, and whether the
        // microphone is really supplying them.
        if (this.frames % 12 === 0) {
          this.port.postMessage({ beat: true, frames: this.frames, rms: Math.sqrt(this.beatAcc / Math.max(1, this.beatN)), input: this.sawInput });
          this.beatAcc = 0; this.beatN = 0; this.sawInput = false;
        }
      }
    }
    return true;
  }
}

registerProcessor('carbowl-capture', CaptureProcessor);
