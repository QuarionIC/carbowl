/* Shared by the speech and listening workers (loaded with importScripts). */
/* global SherpaOnnx */
'use strict';

const CACHE_NAME = 'carbowl-models-v1';

/** Fetches a file (optionally stored as several parts), preferring the model cache. */
async function fetchBytes (base, entry) {
  const one = async rel => {
    const url = new URL(rel, base).href;
    let res = null;
    try { if (self.caches) { const cache = await caches.open(CACHE_NAME); res = await cache.match(url); } } catch (e) { res = null; }
    if (!res) res = await fetch(url);
    if (!res.ok) throw new Error(`could not load ${rel} (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
  if (!entry.parts) {
    const bytes = await one(entry.path);
    if (entry.size && bytes.length !== entry.size) throw new Error(`${entry.path} is ${bytes.length} bytes, expected ${entry.size}`);
    return bytes;
  }
  const out = new Uint8Array(entry.size);
  let at = 0;
  for (const part of entry.parts) { const b = await one(part.path); out.set(b, at); at += b.length; }
  if (at !== entry.size) throw new Error(`${entry.path} reassembled to ${at} bytes, expected ${entry.size}`);
  return out;
}

/** Loads every file of a manifest bundle into the runtime's in-memory file system under dir. */
async function loadBundle (runtime, base, bundle, dir, onProgress) {
  try { runtime.FS.mkdirTree(dir); } catch (e) { /* exists */ }
  const paths = {};
  let done = 0;
  for (const entry of bundle.files) {
    const name = entry.path.split('/').pop();
    const bytes = await fetchBytes(base, entry);
    runtime.FS.writeFile(dir + '/' + name, bytes);
    paths[name] = dir + '/' + name;
    done += entry.size;
    if (onProgress) onProgress(done, bundle.bytes);
  }
  return paths;
}

function unlinkAll (runtime, paths, keep = []) {
  for (const [name, p] of Object.entries(paths)) { if (keep.includes(name)) continue; try { runtime.FS.unlink(p); } catch (e) { /* already gone */ } }
}

async function startRuntime (base, log, manifest) {
  importScripts(new URL('vendor/sherpa/sherpa-onnx-wasm-web.js', base).href);
  const lines = [];
  // Hand the runtime its binary from the model cache when it is there, so starting needs no network.
  let wasmBinary;
  try { if (manifest && manifest.bundles.runtime) wasmBinary = (await fetchBytes(base, manifest.bundles.runtime.files[0])).buffer; } catch (e) { wasmBinary = undefined; }
  const runtime = await SherpaOnnx({
    ...(wasmBinary ? { wasmBinary } : {}),
    locateFile: f => new URL('vendor/sherpa/' + f, base).href,
    print: s => { lines.push(String(s)); if (lines.length > 200) lines.shift(); },
    printErr: s => { lines.push(String(s)); if (lines.length > 200) lines.shift(); if (log) log(String(s)); }
  });
  runtime.__lines = lines;
  return runtime;
}

const heapMiB = runtime => Math.round(runtime.HEAPU8.length / 1048576);

/** Messages for errors thrown as raw numbers by the WebAssembly runtime are useless; add context. */
function describeError (e, runtime) {
  if (e && e.message) return e.message;
  const tail = runtime && runtime.__lines ? runtime.__lines.slice(-3).join(' | ') : '';
  return `runtime error ${String(e)}${tail ? ' :: ' + tail : ''}`;
}
