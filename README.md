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
- With an assistant key (below): **"Moderator, ..."** and then anything, in your own words: "who was
  David Hume?", "why was that the answer?", "switch to math", "slow down a bit". Between questions a
  question needs no "Moderator". **"Thanks"** or **"stop"** cuts an answer short.
- The big button on screen always works as a buzzer.

Everything except fetching questions (and the assistant, when you use it) runs on the device: the
voice, the speech recognition and the answer judging. After the one-time model download the quiz
keeps going through patches with no signal as long as questions are buffered. Every question asked
is kept on the device (IndexedDB) for review across sessions, with what was said and the verdict.

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

**Which version am I on?** The small number beside the title is the version running in that page.
A page that stays open goes on running the code it was loaded with, so Carbowl looks for a newer
version by itself (when it starts, when it comes back into view, and every quarter of an hour),
fetches it as a complete, checksum-verified set, and reloads into it at a moment when nothing is
going on: never during a quiz. Settings > Troubleshooting > "Check for updates" does it on demand.
A page showing no number at all is older than 0.3.1 and has to be reloaded by hand once.

**The assistant.** Open questions are answered by Anthropic's Claude, called straight from the page
with your own Anthropic API key (Settings > Assistant; make a key at console.anthropic.com). The key
is kept in the browser's storage on that device, apart from the other settings, is never written to
the log, and is sent only to api.anthropic.com. Use a key made just for this, with a spending
limit: a key held in a browser can be read by anyone with the unlocked device, and by any other
page published under the same GitHub Pages account (they share one origin). What you ask is sent to
Anthropic together with the state of the quiz: the question in play as far as it has been read (its
answer and the part not yet read stay on the device), the last few questions with their answers
and yours, and the score. Three models are on offer; Settings > Assistant > "Ask a test question"
times the chosen one with your key. Without a key everything else works as before.

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
| `docs/js/assistant.js` | The assistant: what the model is told, the request per model, replies streamed into sentences for the voice, the things it may ask the quiz to do |
| `docs/js/update.js` | Notices a newer published version (or a half-updated copy), fetches it as a verified set and reloads when idle |
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

The assistant can be tried without a key against a stand-in for Anthropic's API, which speaks the
documented streaming format and applies the documented request rules of the three models:

```bash
node tools/mock-anthropic.mjs --port 8392
```

Then open `http://localhost:8391/?test&api=http://127.0.0.1:8392`, save any text as the key, and run
`carbowlAssistantTest()`. The `api` parameter only works when the page itself is served from this
computer and only for an address on this computer; the published site ignores it. The stand-in
shows that requests are well formed and replies are handled; what a real model says, and how fast,
it cannot show.

**Releasing.** Change `VERSION` in `docs/js/app.js` (and `version` in `package.json`), then run
`node tools/stamp-version.mjs`: it writes `docs/version.json`, the version plus a SHA-256 checksum
of every file of the app. Copies of the app on people's devices compare themselves with that list,
so it has to be re-stamped after the last change to anything under `docs/`; a test fails when it is
stale, and `node tools/check-live.mjs` compares the published files with it after a push.

`tools/build-site.mjs` assembles the third-party runtime and models from `downloads/` into `docs/`
(see the script header for where each file comes from). `tools/build-vendor.mjs` bundles Anthropic's
SDK from `node_modules` into `docs/vendor/anthropic-sdk.js` (run `npm install` first; only needed
when the SDK version changes, the bundle is committed). The tests need no `npm install`. `tools/exp/`
holds the measurement scripts used to choose the voice, the recogniser and the thresholds.

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
- The assistant has been run only against the stand-in API (in Node and in desktop Chromium, where a
  spoken "Moderator, who was David Hume?" was recognised, answered aloud and the reading resumed),
  plus one request to the real API with a made-up key to confirm that a browser on the published
  site reaches it and is turned away properly. No real model has answered through it yet, so the
  quality and speed of its answers are unmeasured.

## Credits and licences

See [NOTICE.md](NOTICE.md). Questions and the answer checker are from QBReader; speech runs on
sherpa-onnx with Moonshine, Silero VAD and Supertonic models.
