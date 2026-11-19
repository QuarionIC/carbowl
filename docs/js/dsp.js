// The reader's signal processing, for the page: the code itself lives in workers/dsp.js, written
// as a plain script so that the speech worker can load the very same file with importScripts.
import './workers/dsp.js';

export const { resample, speechLevel, limit, timeScale, splitPace, finishClip, SPEECH_LEVEL, CEILING, MODEL_PACE_MAX } = globalThis.CarbowlDsp;
