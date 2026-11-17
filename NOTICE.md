# Third-party components

Carbowl's own code lives in `docs/js`, `docs/index.html`, `docs/app.css`, `docs/sw.js`, `tools/` and
`test/`. It ships the following third-party files unmodified unless noted.

| Component | Files | Source | Licence |
|---|---|---|---|
| sherpa-onnx browser runtime 2.0.1 | `docs/vendor/sherpa/*` | `sherpa_onnx_web` 2.0.1 from pub.dev (k2-fsa/sherpa-onnx) | Apache-2.0 (`docs/vendor/sherpa/LICENSE`) |
| | | *Modified:* the initial memory size in `sherpa-onnx-wasm-web.wasm` is lowered from 512 MiB to 64 MiB (two bytes in the memory section; see `tools/build-site.mjs`). | |
| qb-answer-checker 1.1.9 | `docs/vendor/qb-answer-checker.js` | npm (qbreader/qb-answer-checker) | ISC; bundles number-to-words (MIT), see `qb-answer-checker.LICENSE.txt` |
| Anthropic SDK for TypeScript 1.9.0 | `docs/vendor/anthropic-sdk.js` | npm (`@anthropic-ai/sdk`), bundled for the browser and minified with esbuild by `tools/build-vendor.mjs`, otherwise unmodified | Apache-2.0; the bundle also contains @opentelemetry/api (Apache-2.0), standardwebhooks and @stablelib/base64 (MIT) and fast-sha256 (Unlicense): full texts in `docs/vendor/anthropic-sdk.LICENSES.txt` |
| Moonshine speech recognition (base and tiny, English, quantized 2026-02-27) | `docs/models/asr-moonshine-*` | k2-fsa/sherpa-onnx releases, `asr-models` | MIT (`LICENSE` in each folder) |
| Silero VAD | `docs/models/vad/silero_vad.onnx` | k2-fsa/sherpa-onnx releases, `asr-models` | MIT (snakers4/silero-vad) |
| Supertonic text-to-speech (int8, 2026-03-06) | `docs/models/tts-supertonic` | k2-fsa/sherpa-onnx releases, `tts-models` | Model: OpenRAIL-M (Supertone Inc.); sample code MIT (`LICENSE` in the folder) |

Large files are stored in parts of at most 45 MB (`*.part0`, `*.part1`, ...) and reassembled in the
browser; `docs/models/manifest.json` lists sizes and checksums.

The assistant's answers come from Anthropic's Claude API at run time, with a key the listener
supplies; nothing of Anthropic's is stored in this repository apart from the SDK above.

Question text, answerlines, categories and difficulty levels come from the
[QBReader](https://www.qbreader.org) API at run time and are not stored in this repository, apart from
a small sample under `test/fixtures` used by the tests.

Fonts (Newsreader, IBM Plex Sans, IBM Plex Mono) are loaded from Google Fonts under the SIL Open Font
Licence.
