// Prints a WebAssembly file's memory limits and whether it uses threads / SIMD-relevant features.
// Usage: node tools/wasm-info.cjs <file.wasm>
'use strict';
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let pos = 8;
function leb () { let result = 0; let shift = 0; let b; do { b = buf[pos++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return result; }
const names = { 0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data', 12: 'datacount' };
console.log('size', buf.length, 'magic', buf.subarray(0, 4).toString('hex'), 'version', buf.readUInt32LE(4));
while (pos < buf.length) {
  const id = buf[pos++]; const size = leb(); const start = pos;
  if (id === 5) {
    const count = leb();
    for (let i = 0; i < count; i++) {
      const flagsPos = pos; const flags = buf[pos++]; const initPos = pos; const initial = leb(); const initLen = pos - initPos;
      const max = (flags & 1) ? leb() : null;
      console.log(`memory[${i}] flags=0x${flags.toString(16)} (shared=${!!(flags & 2)}, memory64=${!!(flags & 4)}) initial=${initial} pages (${initial / 16} MiB) max=${max === null ? 'none' : max + ' pages (' + max / 16 + ' MiB)'} @flags offset ${flagsPos}, initial offset ${initPos} (${initLen} bytes)`);
    }
  }
  if (id === 2) {
    const count = leb(); let mem = 0;
    for (let i = 0; i < count; i++) {
      const ml = leb(); const mod = buf.toString('utf8', pos, pos + ml); pos += ml; const fl = leb(); const field = buf.toString('utf8', pos, pos + fl); pos += fl; const kind = buf[pos++];
      if (kind === 0) leb();
      else if (kind === 1) { pos++; const f = buf[pos++]; leb(); if (f & 1) leb(); } else if (kind === 2) { const f = buf[pos++]; const ini = leb(); const mx = (f & 1) ? leb() : null; mem++; console.log(`imported memory ${mod}.${field}: flags=0x${f.toString(16)} initial=${ini} pages max=${mx}`); } else if (kind === 3) { pos += 2; } else if (kind === 4) { pos++; leb(); }
    }
    console.log('imports:', count, 'imported memories:', mem);
  }
  console.log(`section ${names[id] || id} size ${size}`);
  pos = start + size;
}
