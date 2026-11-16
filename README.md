# Carbowl

Hands-free quizbowl practice for the car. Carbowl pulls tossups and bonuses from
[QBReader](https://www.qbreader.org), reads them aloud, and listens:

- **Tossups**: say **"buzz"** while the question is being read (or within a few seconds after), wait
  for the beep, then say your answer. The reader stops the moment it hears a voice and carries on
  if it was nothing. Two falling notes mean "say that again?". **"Never mind"** takes a buzz back.
- **Bonuses**: just say the answer during or after each part.
- Any time: **"repeat the question"**, **"what were the earlier clues"**, **"go back"** (the last
  sentence), **"skip question"**, **"pause quiz"**, **"resume"**, **"read faster / slower"**,
  **"volume up / down"**.
- Things it can tell you: **"what was the answer"**, **"spell that"**, **"what's my score"**,
  **"what set is this from"**, **"what can I say"**. The answer to a question still in play is
  never given.
- Right after a verdict: **"I was right"** or **"I was wrong"** overrules the judge.
- The big button on screen always works as a buzzer.

Everything except fetching questions runs on the device: the voice, the speech recognition and the
answer judging. After the one-time model download the quiz keeps going through patches with no
signal as long as questions are buffered. Every question asked is kept on the device (IndexedDB)
for review across sessions, with what was said and the verdict.

## Using it

Open the site in Safari (iPhone) or Chrome, download the speech models once on Wi-Fi (about 240 MB),
then tap **Start**. The start screen has one-tap topic switches (Philosophy, Math, Computer
Science); Settings has every QBReader category, subcategory and alternate subcategory, all eleven
difficulty levels (default: medium college and harder, philosophy), reading speed and voice, and
timings.

**In the car.** With CarPlay or Bluetooth the car shows Carbowl as a phone call: that is how a web
page gets the car's microphone. The car's call volume is separate from its music volume (Settings >
Car > Play test tone, and turn the knob while it sounds). Run it in a **Safari tab**, not as a Home
Screen app: in a tab it keeps going with the phone locked or another app in front; a Home Screen
app loses the microphone in the background. Settings > Car > **Run the car check** is a two-minute
guided test that reports what the phone and the car actually did.

## How it works

| Part | What it does |
|---|---|
| `docs/js/qb.js` | QBReader categories and difficulties, query building, buffered question feed |
| `docs/js/speechtext.js` | Cleans question text for speech (pronunciation guides, power marks), splits into sentences |
| `docs/js/workers/tts-worker.js` | Speech synthesis (Supertonic voice on the sherpa-onnx WebAssembly runtime) |
| `docs/js/workers/listen-worker.js` | Voice-activity detection (Silero) and recognition (Moonshine) on the microphone stream |
| `docs/js/workers/capture-worklet.js` | Microphone capture, resampled to 16 kHz on the audio thread |
| `docs/js/narrator.js` | Schedules sentences, tracks the character being spoken (for buzz position and power) |
| `docs/js/intent.js` | Decides whether an utterance is a buzz, a command, the reader's echo, or an answer |
| `docs/js/judge.js` | Answer judging: QBReader's own checker plus a sound-alike comparison for names heard "by ear" |
| `docs/js/game.js` | The quiz itself: tossup and bonus flow, prompts, scoring, pause/skip/override, spoken requests |
| `docs/js/audio.js` | One audio context for playing and capturing; keeps itself running across route changes |
| `docs/js/history.js` | Everything asked, kept across sessions |
| `docs/js/numbers.js` | Spoken numbers ("twenty four") against written ones ("24") when judging |
| `docs/js/clock.js` | Timers that keep time while the page is in the background |
| `docs/js/app.js` | Screen, settings, model download, review, the car check |

The app's own speech is synthesised in the page rather than by the system voice. It leaves through
a MediaStream played by an `<audio>` element, with nothing connected to the audio context's own
destination. On iOS that is what makes it audible beside an open microphone (plain Web Audio output
is turned down while capturing: WebKit bugs 218012, 236219), what gives the echo canceller its
reference, so that a spoken buzz can be heard while a question is being read, and what lets the
context keep running in the background (WebKit bug 237878). The audio engine never waits on
`resume()` (it may not settle while interrupted); a once-a-second watchdog nudges, re-opens or
rebuilds whatever has stopped.

## Developing

```bash
npm test                        # unit and whole-game tests (no network)
CARBOWL_LIVE=1 npm test         # also the live QBReader API checks
node tools/serve.mjs --port 8391  # serve docs/ locally
```

Open `http://localhost:8391/?test` and run `carbowlSelfTest()` in the console for an end-to-end
run with a scripted microphone (synthetic voices speak the buzz and the answers).

`tools/build-site.mjs` assembles the third-party runtime and models from `downloads/` into `docs/`
(see the script header for where each file comes from). `tools/exp/` holds the measurement scripts
used to choose the voice, the recogniser and the thresholds.

## What was measured, and how

All recognition numbers below come from synthetic voices (ten Supertonic speakers) on a laptop, not
from a person in a car. They guided the design; they are not a promise.

- Buzz detection (voice-activity detection + recognition, "normal" sensitivity): 58-59 of 60 clean,
  52-56 of 60 with road-like noise at 10 dB signal-to-noise; zero false buzzes on 7 minutes of
  question audio when the reader's own voice was 30 dB or more below the speaker's.
- With the reader's voice leaking at only 10 dB below the speaker (no echo cancellation), buzzes
  during reading were not detected at all: echo cancellation, or a pause between sentences, is required.
- A dedicated keyword-spotting model (sherpa-onnx KWS, 3.3M parameters) caught only about half of
  isolated "buzz" utterances and was dropped.
- Spoken answers judged against real answerlines: 92% accepted with the larger Moonshine model
  (QBReader's checker alone: 65%), 82% with noise; 1 of 60 wrong answers accepted (a legitimate
  overlap).
- Speech generation runs at about four times real time in desktop Chrome.

## Credits and licences

See [NOTICE.md](NOTICE.md). Questions and the answer checker are from QBReader; speech runs on
sherpa-onnx with Moonshine, Silero VAD and Supertonic models.
