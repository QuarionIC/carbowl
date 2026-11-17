// Verifies a deployed copy of the site: every file named in models/manifest.json must be served
// with the exact size (and, with --hash, the exact content) recorded at build time, and the app's
// own files must be present with sensible content types.
// Usage: node tools/check-live.mjs [base-url] [--hash]
import crypto from 'node:crypto';

const base = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://quarionic.github.io/carbowl/').replace(/\/?$/, '/');
const hash = process.argv.includes('--hash');
let bad = 0;
const fail = msg => { bad++; console.log('FAIL ' + msg); };

async function head (rel) {
  const res = await fetch(base + rel, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
  return { status: res.status, type: res.headers.get('content-type') || '', length: Number(res.headers.get('content-length') || -1) };
}

for (const [rel, type] of [['', 'text/html'], ['app.css', 'text/css'], ['sw.js', 'javascript'], ['js/app.js', 'javascript'], ['js/game.js', 'javascript'], ['js/assistant.js', 'javascript'], ['vendor/anthropic-sdk.js', 'javascript'],['js/workers/tts-worker.js', 'javascript'], ['js/workers/listen-worker.js', 'javascript'], ['js/workers/capture-worklet.js', 'javascript'], ['js/workers/common.js', 'javascript'], ['vendor/qb-answer-checker.js', 'javascript'], ['vendor/sherpa/sherpa-onnx-wasm-web.js', 'javascript'], ['vendor/sherpa/sherpa-onnx-wasm-web.wasm', 'application/wasm']]) {
  const h = await head(rel);
  if (h.status !== 200) fail(`${rel || 'index'}: HTTP ${h.status}`); else if (!h.type.includes(type)) fail(`${rel || 'index'}: content type ${h.type}, expected ${type}`);
}

const manifest = await (await fetch(base + 'models/manifest.json')).json();
let files = 0; let bytes = 0;
for (const [name, bundle] of Object.entries(manifest.bundles)) {
  for (const f of bundle.files) {
    const pieces = f.parts || [f];
    const digest = crypto.createHash('sha256');
    let total = 0;
    for (const p of pieces) {
      files++;
      if (hash) {
        const res = await fetch(base + p.path);
        if (res.status !== 200) { fail(`${p.path}: HTTP ${res.status}`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== p.size) fail(`${p.path}: ${buf.length} bytes, expected ${p.size}`);
        digest.update(buf); total += buf.length;
      } else {
        const h = await head(p.path);
        if (h.status !== 200) fail(`${p.path}: HTTP ${h.status}`); else if (h.length !== p.size) fail(`${p.path}: ${h.length} bytes, expected ${p.size}`);
        total += h.length;
      }
    }
    bytes += total;
    if (total !== f.size) fail(`${f.path}: parts add up to ${total}, expected ${f.size}`);
    if (hash && f.sha256 && digest.digest('hex').slice(0, 16) !== f.sha256) fail(`${f.path}: content differs from the build (${name})`);
  }
}
console.log(`${base}: ${files} model/runtime files, ${(bytes / 1048576).toFixed(1)} MB, ${hash ? 'sizes and contents' : 'sizes'} checked; problems: ${bad}`);

// The app's own files against the published list (version.json): each must be served byte for byte
// as listed, or copies of the app on people's devices will refuse to update to it.
const before = bad;
let listed = 0; let published = '';
try {
  const res = await fetch(base + 'version.json', { cache: 'no-store' });
  if (res.status !== 200) fail(`version.json: HTTP ${res.status}`);
  else {
    const info = await res.json();
    published = info.version;
    const app = await (await fetch(base + 'js/app.js', { cache: 'no-store' })).text();
    const running = (app.match(/const VERSION = '([^']+)'/) || [])[1];
    if (running !== info.version) fail(`version.json says ${info.version} but js/app.js is ${running}`);
    for (const [file, want] of Object.entries(info.files || {})) {
      listed++;
      const r = await fetch(base + file, { cache: 'no-store' });
      if (r.status !== 200) { fail(`${file}: HTTP ${r.status}`); continue; }
      const got = crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
      if (got !== want) fail(`${file}: served content does not match version.json`);
    }
    // The page as people open it (the address without "index.html") must be that same page.
    if (info.files && info.files['index.html']) {
      const r = await fetch(base, { cache: 'no-store' });
      const got = crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
      if (got !== info.files['index.html']) fail('the page at the site address does not match version.json');
    }
  }
} catch (e) { fail('version.json: ' + e.message); }
console.log(`${base}: version ${published || '?'}, ${listed} app files checked against version.json; problems: ${bad - before}`);
process.exit(bad ? 1 : 0);
