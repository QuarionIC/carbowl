// Waits until the published site serves a given version of the app, then says how long it took.
// Usage: node tools/wait-live.mjs <version> [base] [timeoutSeconds]
const [version, base = 'https://quarionic.github.io/carbowl/', timeout = '240'] = process.argv.slice(2);
if (!version) { console.error('usage: node tools/wait-live.mjs <version> [base] [timeoutSeconds]'); process.exit(2); }
const t0 = Date.now();
for (;;) {
  try {
    const res = await fetch(new URL('js/app.js?nocache=' + Date.now(), base), { cache: 'no-store' });
    const text = res.ok ? await res.text() : '';
    const m = text.match(/const VERSION = '([^']+)'/);
    if (m && m[1] === version) { console.log(`live site serves ${m[1]} after ${Math.round((Date.now() - t0) / 1000)} s`); process.exit(0); }
    process.stdout.write(`serving ${m ? m[1] : 'HTTP ' + res.status}... `);
  } catch (e) { process.stdout.write(`(${e.message}) `); }
  if (Date.now() - t0 > Number(timeout) * 1000) { console.log('\nstill not updated'); process.exit(1); }
  await new Promise(resolve => setTimeout(resolve, 10000));
}
