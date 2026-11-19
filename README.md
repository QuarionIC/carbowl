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

**Light or dark.** The page follows the device until the sun or moon button beside the title is
used; after that it keeps the look that was chosen, on that device. Settings > Feedback >
Appearance > "Match this device" goes back to following.

**Review.** Every question heard is kept on the device, with what you said and whether it was
right (the list icon at the top). Opening "Question" under an entry shows it as its packet printed
it: the set and packet, the question's number, the text with pronunciation guides and the power in
bold up to its (*) mark, the ANSWER line with what must be said in bold and underlined, the
category in angle brackets; a bonus as its lead-in and "[10]" parts, each with its answer. A small
mark stands in the text at the word where you buzzed, green for a right answer and red for a wrong
one. Entries kept before 0.3.5 hold only the words that were read aloud; the first time one is
opened while online, its printed text is fetched from QBReader by the question's id and kept.

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
| `docs/js/speechtext.js` | Cleans question text for showing and reading (pronunciation guides, power marks, notes to the reader), splits into sentences |
| `docs/js/reading.js` | Words a sentence for the voice: what is shown as "Louis XIV", "No. 14", "1,514 miles" is said as "Louis the fourteenth", "Number 14", "one thousand five hundred fourteen miles" |
| `docs/js/workers/tts-worker.js` | Speech synthesis (Supertonic voice on the sherpa-onnx WebAssembly runtime) |
| `docs/js/workers/listen-worker.js` | Voice-activity detection (Silero) and recognition (Moonshine) on the microphone stream |
| `docs/js/workers/capture-worklet.js` | Microphone capture, resampled to 16 kHz on the audio thread |
| `docs/js/workers/dsp.js` (and `docs/js/dsp.js`, the same code as a module) | The voice's signal processing: rate conversion, loudness, limiting, change of pace |
| `docs/js/narrator.js` | Schedules sentences, tracks the character being spoken (for buzz position and power) |
| `docs/js/intent.js` | Decides whether an utterance is a buzz, a command, the reader's echo, or an answer |
| `docs/js/judge.js` | Answer judging: QBReader's own checker plus a sound-alike comparison for names heard "by ear" |
| `docs/js/game.js` | The quiz itself: tossup and bonus flow, prompts, scoring, pause/skip/override, spoken requests |
| `docs/js/audio.js` | One audio context for playing and capturing; keeps itself running across route changes |
| `docs/js/assistant.js` | The assistant: what the model is told, the request per model, replies streamed into sentences for the voice, the things it may ask the quiz to do |
| `docs/js/update.js` | Notices a newer published version (or a half-updated copy), fetches it as a verified set and reloads when idle |
| `docs/js/history.js` | Everything asked, kept across sessions |
| `docs/js/packet.js` | A kept question laid out as its packet printed it, and where in the printed text a buzz came |
| `docs/js/numbers.js` | Spoken numbers ("twenty four") against written ones ("24") when judging |
| `docs/js/clock.js` | Timers that keep time while the page is in the background |
| `docs/js/app.js` | Screen, settings, model download, review, the car check |

The app's own speech is synthesised in the page rather than by the system voice. On an iPhone, an
iPad and in Safari it leaves through a MediaStream played by an `<audio>` element, with nothing
connected to the audio context's own destination. On iOS that is what makes it audible beside an
open microphone (plain Web Audio output is turned down while capturing: WebKit bugs 218012, 236219),
what gives the echo canceller its reference, so that a spoken buzz can be heard while a question is
being read, and what lets the context keep running in the background (WebKit bug 237878). In other
browsers it goes straight to the context's destination (Settings > Car > Sound output chooses). The
audio engine never waits on `resume()` (it may not settle while interrupted); a once-a-second
watchdog nudges, re-opens or rebuilds whatever has stopped.

**What the voice is given to say** (since 0.3.6). The voice model reads plain words well and some
written forms badly: it was heard turning "Louis XIV" into "Louis Catouille", "1,514 miles" into
"one, five, fourteen miles", "19.9%" into "nineteen, nine percent" and "Sonata No. 14, Op. 27" into
noise, and halting after every initial of "J. L. Austin". So each sentence is shown as the question
was written and handed to the voice reworded (`reading.js`): rulers' numbers as "the fourteenth",
numbered things as "World War two", numbers with separators and decimals in words, a year like
1905 as "nineteen oh five", "No.", "Op.",
"Mt.", "St.", "Dr.", "vs.", "Jr." written out, initials without their full stops, letters the model
has no character for (ð, þ, æ, accents) in ones it has. Only forms that were heard to come out
wrong, and right when reworded, are touched; about one sentence in twenty is. Notes to the reader
that used to slip through and be read aloud ("Peter Pears (peers)", "[[all-oh-BRO-gis]]", "($)",
"methano•genesis") are removed before either. The measurements are below.

**What keeps the voice the same from one sentence to the next** (since 0.3.4):

- The voice quality (the model's number of refinement steps) is the one chosen in Settings, always.
  Earlier versions lowered it for the rest of the session when speech seemed to be generated
  slowly, which a busy computer could set off, and so could a page that was not on screen while it
  got ready (measured below: that is what made the voice turn rough "for no reason" in 0.3.1 to
  0.3.3). A device that really is too slow now shows as
  sentences starting late; that is logged, and after three in two minutes the listener is told
  which setting would help. Nothing is changed for them.
- The model makes 44.1 kHz audio; the sound system runs at the output device's rate. The conversion
  is done in the speech worker with a windowed-sinc filter, and the browser is always handed audio
  at its own rate, because its built-in conversion draws straight lines between samples and filters
  nothing (see the measurements below).
- Every clip is brought to the same loudness (RMS of the spoken parts 19 dB below full scale)
  instead of being set by its single highest peak, and its peaks are held under a ceiling by a
  look-ahead limiter.
- Volume above 1× is made by pressing the loudest peaks down, not by running over full scale.
- Up to 1.5× the voice model itself speaks at the reading speed asked for. Above that it speaks at
  1.5× and the result is compressed in time: asked for more itself, the model drops sounds.
- Between sentences the output is never true silence (a Bluetooth link or a digital output that
  mutes itself on silence would swallow the start of the next sentence). On computers that is a
  30 Hz tone 80 dB below full scale (since 0.3.5); through an iPhone's call audio it is a faint
  hiss, as before. Up to 0.3.4 the hiss was used everywhere, and a laptop's own sound effects were
  measured turning it up by 16 dB (see below).

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
- Speech generation runs at about four times real time in desktop Chrome on an idle laptop. On the
  same laptop with a game running (2026-11-18) a sentence at the standard quality took 0.6 to 0.9
  of its own length, which is where versions up to 0.3.3 lowered the quality for the session.

### The voice (2026-11-18)

Scripts: `tools/exp/voice-quality.cjs`, `speed-quality.cjs` and `pace-tune.cjs`. Eighteen
sentences from real tossups, speaker 5 (the default: the first of the men's voices, which Settings
called "Female 1" until 0.3.6), every comparison on the same sentences. "Misheard"
is the share of words the larger Moonshine recogniser got wrong when played the result: a stand-in
for clarity, not a listening test. HNR (harmonics-to-noise ratio) and CPP (cepstral peak
prominence) fall when a voice turns rough or noisy. The laptop was busy with a game throughout, so
the times are those of a loaded machine.

Quality setting, at 1.3×:

| Setting | Time to make, as a share of the speech's length | Misheard | HNR | CPP |
|---|---|---|---|---|
| 2 (what 0.3.3 could fall to) | 0.44 | 6.3% | 7.43 dB | 20.17 dB |
| 3 "Faster" | 0.55 | 4.5% | 7.69 dB | 20.39 dB |
| 5 "Standard" | 0.79 | 5.1% | 7.81 dB | 20.44 dB |
| 8 "Best" | 0.96 | 3.8% | 7.82 dB | 20.55 dB |

Sentence by sentence, quality 2 is measurably rougher than 5 (HNR lower by 0.38 dB, standard error
0.14; CPP by 0.27 dB, standard error 0.12). Between 3, 5 and 8 these instruments find no difference
larger than their own noise; whatever an ear hears there, they do not show it.

Reading speed, at quality 5. "The model's own" is the model asked for that pace directly, which is
what every version up to 0.3.3 did at every speed; "compressed" is the model speaking at 1.5× and
the result shortened in time (`dsp.js`, `timeScale`), which is what 0.3.4 does above 1.5×:

| Pace | The model's own: misheard | HNR | Compressed from 1.5×: misheard | HNR |
|---|---|---|---|---|
| 1.0× | 5.3% | 8.23 dB | | |
| 1.3× | 4.3 to 5.1% | 7.65 to 7.81 dB | | |
| 1.5× | 4.3 to 5.3% | 7.53 to 7.73 dB | | |
| 1.65× | 10.4% (3 of 18 sentences over 25%) | 7.50 dB | 5.1% (none over 25%) | 7.26 dB |
| 1.8× | not measured | | 4.0% (none) | 6.84 dB |
| 2.0× | 41.4% (14 of 18 over 25%) | 7.47 dB | 5.1% (none) | 6.38 dB |

Asked to speak faster than about 1.5×, the model drops and slurs sounds; compressing its 1.5×
speech keeps the words. The price shows in HNR, which is lower for compressed speech (by 0.3 dB at
1.65× and 1.2 dB at 2×; part of that is the pace itself, since HNR also falls from 8.2 to 7.5 dB
as the model's own speech goes from 1.0× to 1.65×). Stretch length and search range were tried
from 20 to 40 ms and ±5 to ±12 ms; they moved HNR by 0.2 dB at most. Compressing costs about
0.15 s of computing per sentence, and a 2× reading needs a third more speech made per second
heard than the model's own 2× did.

- The same sentence made four times is never the same audio twice (the model starts from noise),
  and its clarity varies: one sentence was misheard at 26%, 0%, 9% and 0% over four takes.
- Loudness from sentence to sentence: with each clip set by its highest peak (up to 0.3.3) the
  spoken parts ranged over 3.2 dB (-20.8 to -17.6 dB, standard deviation 0.75 dB); set by loudness
  (0.3.4) questions, verdicts and one-word phrases all measured -19.0 dB in the browser.
- Rate conversion, measured in Chromium 156 on three real sentences against a properly filtered
  conversion: the browser's own adds an error 37 dB below the speech at 48 kHz, 34 dB at 24 kHz,
  26 dB at 16 kHz and 18.5 dB at 8 kHz (a 10 kHz tone played into a 16 kHz system comes out as a
  6 kHz one, 1.5 dB down). The conversion in `dsp.js` keeps such images below -75 dB (tested).
- Volume at 1.5×: 17 to 139 samples per clip would have run over full scale and been clipped; they
  are now held at 0.97 and the clip is 3.0 to 3.4 dB louder (3.5 dB asked for).
- None of this has been heard through a phone or a car. What a phone-call link (CarPlay,
  Bluetooth hands-free) does to the voice after the page hands it over is outside the page's
  reach: a link running at 8 or 16 kHz carries nothing above 4 or 8 kHz, whatever it is given.

### A page that is not on screen (2026-11-19)

Scripts: `tools/exp/lab-server.mjs` (serves the site, the pages under `tools/exp/lab/`, and an
earlier version's scripts beside them) with `lab/bg-speed.html` and `lab/old-rule.html`, opened in
Chrome 157 with a throwaway profile and a stand-in microphone, the window minimised. The same
laptop, otherwise lightly used. The figure is the time speech took to make as a share of its own
length (quality 5, 1.3×).

| The page is | and has | Two runs |
|---|---|---|
| minimised | no sound output at all | 1.55, 1.84 |
| minimised | sound output open, sending true silence | 1.81, 1.62 |
| minimised | the keep-awake tone of 0.3.5 (30 Hz, 80 dB below full scale) | 1.71, 1.58 |
| minimised | the keep-awake hiss of 0.2.0 to 0.3.4 (81 dB below full scale) | 1.87, 1.57 |
| minimised | a 20 Hz tone 60 dB below full scale (not something the app plays) | 0.22, 0.22 |
| minimised | the 0.3.5 tone and a microphone open, as during a quiz | 0.23, 0.23 |
| on screen | nothing, or a microphone open (0.3.3's code, 29 phrases) | 0.26, 0.26, 0.25, 0.25 |

Chrome runs a page that is not on screen at idle priority (Windows showed the page's process in
the "Idle" priority class) unless the page is playing something louder than Chrome's own threshold
for "audible" or holds a microphone. Speech is then made six to eight times more slowly: slower than
it is spoken.

Version 0.3.3's own reader and speech code, put through what it did as soon as a page had loaded
(making its 29 fixed phrases, about a minute of speech), chose these qualities:

| The page is | and has | Quality, phrase by phrase | It logged |
|---|---|---|---|
| on screen | nothing else (twice), a microphone (twice) | 5 for all 29, four times | nothing |
| minimised | a microphone open (twice) | 5 for all 29, twice | nothing |
| minimised | nothing else (twice) | 5 for 8 phrases, 3 for 7, 2 for the other 14, both times | "this device generates speech slowly (2.09 of real time at quality 5); lowering voice quality to 3 so the reader keeps up", then "(1.40 of real time at quality 3); lowering voice quality to 2" |

So in 0.3.1 to 0.3.3 a page that got ready while it was not on screen read the whole following
session at quality 2, the roughest setting, and one that got ready on screen read at quality 5.
From 0.3.1 a page also reloads itself into a new version when idle, which is often when it is not
being looked at. The rule was removed in 0.3.4: the quality is the Settings value, whatever the
speed. During a quiz the microphone is open, so a quiz running behind another window is made at
full speed; without a microphone it would start each question late.

A minimised window is what was tested. A tab behind another tab is in the same state as far as the
page can tell (`document.visibilityState` is "hidden"), and is expected to be treated the same; that
arrangement was not run. Other browsers were not tried.

### After the page: what a Windows laptop does to the voice (2026-11-19)

Scripts: `tools/exp/wasapi.cs` (compiled on the spot by Windows PowerShell; plays a prepared
programme the way an ordinary program does and records Windows' own copy of what it sends to the
output, after its software effects and before the hardware), `sound-path.mjs` and `sound-lab.mjs`
(line each played clip up with what came out and measure the difference), `sound-clarity.cjs` (the
recogniser, HNR and CPP on the same sentence before and after). One laptop: Realtek sound with
Dolby, Realtek and intelliGo effects, on which Windows reports "loudness equalizer", "virtual
surround", "speaker protection" and "noise suppression" as on for everything played. Four
sentences in the reader's voice at the level the app plays them (spoken parts 19 dB below full
scale).

| Output, and how it was played | Level, out against in | Peaks above the average, in → out | Samples pinned at full scale | Damage |
|---|---|---|---|---|
| Built-in speakers, as any program plays | +9.2 dB | 16.7 → 10.8 dB | 0.10% | -19.0 dB |
| Built-in speakers, the same 12 dB quieter (one sentence) | +15.9 dB | 17.1 → 16.4 dB | under 0.001% | -22.1 dB |
| Built-in speakers, the same 24 dB quieter (one sentence) | +24.3 dB | 17.1 → 17.1 dB | none | -26.3 dB |
| Built-in speakers, asking Windows for no processing (a control; a web page cannot ask) | +5.2 dB | 16.7 → 14.7 dB | 0.001% | -23.4 dB |
| Headphone socket, as any program plays (two sentences, three takes) | +4.3 to +4.6 dB | 16.8 → 15.4 to 15.6 dB | 0.001% | -28.5 to -28.8 dB |

"Damage" is what is left of the output once a fixed change of tone and a volume that rides up and
down (in seven bands, 21 ms at a time) have both been allowed for. For scale, the same measure
reads -37 dB for a fixed change of tone alone, -28 dB when the volume also rides ±4 dB over half a
second, and -34, -25 and -17 dB when the peaks are clipped by 3, 6 and 10 dB.

- On the built-in speakers Windows turns the voice up by 9 dB and holds its peaks at full scale,
  6 dB closer to the average than they went in; the quieter the sound, the more it is turned up
  (24 dB for speech 24 dB quieter), so lowering the app's level changes little. The tone is changed
  too: +6 to +10 dB from 100 to 200 Hz, -3.5 dB at 800 Hz, +11 to +14 dB from 8 to 12.5 kHz, relative to
  1 kHz (the last also when no processing is asked for, so that part is the speaker's own tuning).
  On the headphone socket the voice passes nearly as it is: +4.5 dB, flat within 3 dB above 250 Hz.
- The same sentences before and after the speakers' processing: 3 and 4 of 64 words misheard, HNR
  lower by 0.19 dB (standard error 0.06), CPP by 0.42 dB (0.01). For comparison, the fall to
  quality 2 that 0.3.4 removed cost 0.38 dB of HNR and 0.27 dB of CPP. Headphones: HNR +0.4 dB,
  CPP unchanged (one sentence at four lower levels).
- The app's faint keep-awake hiss (white noise 81 dB below full scale) left the speakers' processing
  at -64.7 dB, 16 dB louder and mostly around 10 kHz, and 16 dB louder at every level tried down
  to 30 dB lower. A 30 Hz tone at -83 dB left at -69 dB with nothing above -139 dB at 250 Hz, 1,
  4 or 10 kHz; on the headphone socket the two came out at -76.4 and -77.5 dB. Since 0.3.5 the
  tone is what computers get.
- A microphone held open changed nothing in what the headphone socket was sent (none, as a call,
  plainly: level +4.3, +4.6 and +4.4 dB; damage -28.8, -28.8 and -28.5 dB). The audio engine
  process used 26 to 42% of one processor core whenever anything played.
- The sound drivers on this laptop date from 2024. The one sound-related update in the three weeks
  before was to the intelliGo companion app, on 2 November, before Carbowl existed.
- What this does not cover: anything after Windows' software (the amplifier, the loudspeakers, the
  room); the speakers with a microphone open, or at levels above the app's; any other computer.
  The quiet clips of the control take and one louder clip on the headphone socket were spoiled by
  another program's sound and are left out. Nobody listened: these are measurements.

### What the reader is given to say (2026-11-19)

Scripts: `tools/exp/text-audit.mjs` and `text-diff.mjs` (what the questions hold, and every
difference the text handling makes to them), `say-probe.cjs`, `initials-probe.cjs`,
`say-confirm.cjs` with `say-confirm-report.mjs` (the voice saying a sentence, a recogniser
listening), `clip-edges.cjs`, `noise-floor.cjs`, `voice-facts.cjs`. The sample is the 305 fixture
questions and 750 more drawn from QBReader across every category: 2,179 question texts and 1,804
answers, 8,409 pieces to speak. The listener is the larger Moonshine recogniser, not a person. It
shows whether the words came out; it says nothing about how natural they sounded, and it has
habits of its own (it writes "Charles II" for a spoken "Charles the second"), which the scoring
levels out as far as it can. Every comparison from here on uses the runtime's `seed` option: the
same seed and text give the same audio, sample for sample (checked), so two ways of writing a
sentence start from the same noise.

**Notes to the reader that were being read aloud.** 22 of the 2,179 texts are now cleaned
differently, each one read against the original: asides that respell the word before them without
the usual capitals and hyphens ("Peter Pears (peers)", "snRNPs (snurps)", "Tay Ninh (TYE nun)"),
guides in double square brackets ("Allobroges [[all-oh-BRO-gis]]" left "[]" behind), quoted guides
with a comma or a digit in them, the marks "($)" and "(**)", dots between syllables
("di•iso•propyl•amide"), and words left stuck together where a note had no space after it. One
aside that used to be dropped as if it were a respelling is kept: a painting's other title. Heard
before the change: "It was first sung by Peter Pierce Pierce"; a "($)" came out as "ah" and half a
second of silence.

**Written forms the voice got wrong** (three seeded takes each; what the recogniser heard):

| Written | Heard | Reworded | Heard |
|---|---|---|---|
| Louis XIV built Versailles, and Louis XVI was executed | "Louis Catouille … Louis Xt's", "Louis Cartivray … Louis Sixties", "Louis Cartier … Louis Coxie" | Louis the fourteenth … Louis the sixteenth | right, three times |
| Act III of this play follows Act IV of another | "Act three … Act Vuff", "… active vv", "… Act Vos" | Act three … Act four | both numbers right, three times |
| World War I ended in 1918 | "World War I ended in nineteen", "World War in nineteen eighteen", "World War ended in nineteen, eighteen" | World War one ended in 1918 | right, three times |
| iron(III) oxide and copper(II) sulfate | "iron-eag oxide and coppery sulphate", "iron Ai and copper sulphate", "a clear and curry sulphate" | iron three oxide and copper two sulfate | right, three times |
| It sold 784,000 copies and then 2,500 more | "seven or eighty four thousand … two, five, five hundred"; right once; "… and then to five hundred" | seven hundred eighty-four thousand … two thousand five hundred | right, three times |
| The constant is 8.314, pi is about 3.14, and it rose 2.5 percent | "eight, three, four, four … three, fourteen … two, five percent", three times | 8 point three one four … 3 point one four … 2 point five percent | right, three times |
| the Piano Sonata No. 14, Op. 27 No. 2 | "No, fourteenths, five to seven, No, two"; "No, Fourth Tone, Op, Vinty seven"; "No, Hop, twenty seven" | Number 14, Opus 27 Number 2 | "number fourteen, Opus twenty seven, number two", three times |
| William F. Buckley, Jr. founded this magazine | "Buckley here founded", right once, "Buckley, dear, founded" | William F Buckley Junior | right, three times |
| The answer is E. M. Forster | "Monsieur Foster", "E. M. S. Foster", "E. Monsieur Foster" | E M Forster | right, three times |
| self-portraits 'with a red scarf' and 'with a horn' | the first phrase missing once, "and" missing once | the same in double quotes | right, three times |

Two takes each, unseeded: "Wladyslaw IV" was heard as "Lady Slagh Avi" and "Vladislav Gae",
"Boniface VIII" as "Boniface B." and "Boniface Zurich", "Mt. Fuji" as "metaphogy" and "Mint Fuji",
"vs. the control" as "viz" and "Vez", "19.9%" as "nineteen, nine percent" both times, "above −35.9
degrees" without its minus or with a stray letter, and "Guðrun … Þorgerðr" as "Gurun … Bourgeour".
"José Müller met Beyoncé in São Paulo" was garbled in all three seeded takes with its accents and
came through but for the first name in two of three without them. The decimals have a known
cause: the runtime cuts the text at every full stop and joins it again with a space, so the model
is given "19. 9".

**The confirmation.** Every piece of the sample that `reading.js` rewrites was a candidate (399 of
8,409, about one in twenty). For each kind of rewrite other than numbers, 14 of them spread over
the sample (all 8 for the odd letters) were spoken as written and as rewritten with the same two
seeds; for numbers, all 48 with three seeds. Both transcripts were scored against the intended
reading. Pieces that are not rewritten reach the voice unchanged and cannot come out differently.
The figures are for the rules as they ship.

| Kind of rewrite | Sentences | Words not heard, as written | Reworded | Difference per take (standard error) | Takes better / worse / same |
|---|---|---|---|---|---|
| Roman numerals | 14 | 16.3% | 10.0% | -7.9 points (1.9) | 18 / 2 / 8 |
| Years with a nought (1905) | 14 | 15.7% | 10.1% | -6.3 (1.8) | 27 / 9 / 6 |
| Decimals | 11 | 12.0% | 7.6% | -4.5 (0.9) | 24 / 3 / 6 |
| Numbers with separators, other than plain round ones | 7 | 7.0% | 3.9% | not worked out: 7 sentences | 6 / 2 / 13 |
| Titles and abbreviations (Mr., Dr., St., Mt., No., v.) | 14 | 5.9% | 4.5% | -1.9 (0.8) | 9 / 1 / 18 |
| Initials without their full stops | 14 | 6.3% | 4.5% | -2.1 (1.4) | 11 / 3 / 14 |
| Single-quoted phrases | 14 | 9.0% | 6.9% | -1.9 (1.1) | 7 / 2 / 19 |
| Letters and marks outside the model's alphabet | 8 | 25.0% | 20.5% | -2.7 (2.1) | 6 / 3 / 7 |
| All of them | 96 | 11.6% | 8.0% | -4.0 (0.6) | 108 / 25 / 91 |

Two things changed because of this run. Plain round numbers ("6,000", "20,000", "100,000",
"2,000,000": one or two digits and then only noughts) were first put in words like the rest; over
their 15 sentences the voice read them as well as written as in words (6.8% of words not heard
against 6.9%), and "accounts above 100,000 euros" lost its "above" in two takes of three in words
and in none as written, so they are left as written. And a percent sign left on a word ("19 point
nine%") was read as part of it once; it is now written out. The takes that came out worse were
read one by one. Most are the recogniser's spelling ("Jay Presper Eckert" for "J Presper Eckert",
"World War Ii" for "World War two") or a slip somewhere else in the sentence, which another seed
moves elsewhere. Two are at the rewrite itself and remain: "John D MacDonald" was heard without
its "John" in one take of two (the other take was better than as written), and "the seventeen oh
one Act" as "the seventeen, a one-active" (as written it came out "seven hundred one Act").

Initials were also tried on 20 names in a fixed sentence, three seeds each, four ways: as written
the name was heard right in 44 of 60 takes, without the full stops in 47 (take by take: better 8,
worse 5), as letter names ("Jay El Austin") in 46, run together ("JL Austin") in 40. Without the
full stops the sentence is 0.38 s shorter (3.33 to 2.95 s): the voice no longer halts after each
letter. "I. M. Pei" came out wrong in every form and still does.

**Tried and left as written**, because no reworded form was heard better: "etc." (fine as it
is), "et al." (garbled in all four forms tried), dotted abbreviations (no one way of writing them
won: "B.C.E." came out best as written, "p.m." as "PM", "A.A.L." wrong in every form), letter
names for initials, and a comma or full stop added where a long sentence is cut (the pitch at the
end of a piece does not depend on its last punctuation mark: 18 takes of each ending, differences
well inside a spread of 3 to 4 semitones).

**Other things found on the way.**

- The ten speakers are five women (speakers 0 to 4, median pitch 174 to 239 Hz) and five men (5 to
  9, 90 to 122 Hz). Settings had the names the other way round: the default voice, listed as
  "Female 1", has always been the first of the men's. The names are now right; the voices are the
  same.
- What trimming removes from the ends of a clip is not speech. Over 80 sentences the loudest 5 ms
  cut from a start was 22.7 dB under the level of the speech and typically 32 dB under it, which
  is the level of the model's own background: a steady low sound 30 to 36 dB under the voice
  before the first word (38 to 42 dB under it after the last), almost all of it between 63 and
  250 Hz. It is there at every quality setting (2, 3, 5, 8, 12, 16 and 24 steps) and for every
  speaker; from 500 Hz up the background is 55 dB or more under the voice. Nothing was changed.
- In 561 takes two lost more than a quarter of a second of speech at an end (a first word that
  never sounded); too rare, and too little of what goes wrong, to build a retry on.

Not verified: none of this was heard by a person, on any device. The recogniser cannot tell
"Charles two" from "Charles the second" in what it writes, so the gain from saying a ruler's
number as an ordinal rests on that being how it is read, not on a measurement. The lists behind the
rules (rulers' names, numbered things) are finite: a name they do not know gets the plain number,
which is how "II" and "III" were read before.

### The assistant

- The assistant has been run only against the stand-in API (in Node and in desktop Chromium, where a
  spoken "Moderator, who was David Hume?" was recognised, answered aloud and the reading resumed),
  plus one request to the real API with a made-up key to confirm that a browser on the published
  site reaches it and is turned away properly. No real model has answered through it yet, so the
  quality and speed of its answers are unmeasured.

## Credits and licences

See [NOTICE.md](NOTICE.md). Questions and the answer checker are from QBReader; speech runs on
sherpa-onnx with Moonshine, Silero VAD and Supertonic models.
