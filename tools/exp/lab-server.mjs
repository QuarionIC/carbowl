// A local server for experiments that need the app's own code in a real browser: it serves docs/
// as the site, the pages under tools/exp/lab/ at /__lab/, and takes what those pages report
// (POST /__lab/report, one JSON object per request) into downloads/out/lab/report.jsonl.
// This computer only. Usage: node tools/exp/lab-server.mjs [--port 8393]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(HERE, '..', '..', 'docs');
const PAGES = path.join(HERE, 'lab');
const OUT = path.join(HERE, '..', '..', 'downloads', 'out', 'lab');
const i = process.argv.indexOf('--port');
const PORT = i > 0 ? Number(process.argv[i + 1]) : 8393;
// --old <folder>: an earlier version's docs/ (say, from "git archive <commit> docs/js"), served at
// /__old/ so that a lab page can run that version's code beside this one's.
const o = process.argv.indexOf('--old');
const OLD = o > 0 ? path.resolve(process.argv[o + 1]) : (process.env.CARBOWL_OLD ? path.resolve(process.env.CARBOWL_OLD) : '');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav' };

function handle (req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); res.end(); return; }
  if (req.method === 'POST' && rel === '/__lab/report') {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size < 4e6) chunks.push(c); });
    req.on('end', () => {
      fs.mkdirSync(OUT, { recursive: true });
      fs.appendFileSync(path.join(OUT, 'report.jsonl'), Buffer.concat(chunks).toString('utf8').replace(/\s*\n\s*/g, ' ') + '\n');
      res.writeHead(204); res.end();
    });
    return;
  }
  const lab = rel.startsWith('/__lab/'); const old = OLD && rel.startsWith('/__old/');
  const root = lab ? PAGES : old ? OLD : SITE;
  if (lab) rel = rel.slice('/__lab'.length); else if (old) rel = rel.slice('/__old'.length);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`Carbowl lab server: http://localhost:${PORT}/`));
http.createServer(handle).on('error', e => console.log('IPv6 loopback not available: ' + e.code)).listen(PORT, '::1');
