// Numbers as spoken and as written. A speech recogniser writes "twenty four", an answer line says
// "24"; before the two are compared both are brought to digits (for exact checks) and back to words
// (for comparison by sound).

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const UNIT_WORDS = Object.keys(UNITS);
const TEN_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const kindOf = w => w in UNITS ? 'unit' : w in TENS ? 'tens' : w in SCALES ? 'scale' : null;
const isNumberWord = w => kindOf(w) !== null;

/** Reads a run of number words as ONE cardinal number, or returns null when it is not one ("seventeen twenty nine"). */
function cardinal (run) {
  let total = 0; let current = 0; let last = null; let seen = false;
  for (const w of run) {
    const k = kindOf(w);
    if (k === 'unit') {
      const v = UNITS[w];
      if (last === 'unit' || last === 'teen') return null;
      if (last === 'tens' && (v === 0 || v >= 10)) return null;
      current += v; last = v >= 10 ? 'teen' : 'unit';
    } else if (k === 'tens') {
      if (last === 'unit' || last === 'teen' || last === 'tens') return null;
      current += TENS[w]; last = 'tens';
    } else if (w === 'hundred') {
      if (current === 0) current = 1;
      if (current >= 100 || last === 'hundred') return null;
      current *= 100; last = 'hundred';
    } else if (k === 'scale') {
      if (last === 'scale') return null;
      total += (current || 1) * SCALES[w]; current = 0; last = 'scale';
    } else return null;
    seen = true;
  }
  return seen ? total + current : null;
}

/** Splits a run into the fewest consecutive pieces that are each one number: [17, 29], [1, 7, 2, 9]. */
function groups (run) {
  const out = [];
  let i = 0;
  while (i < run.length) {
    let best = null; let bestLen = 0;
    for (let len = Math.min(run.length - i, 8); len >= 1; len--) {
      const v = cardinal(run.slice(i, i + len));
      if (v !== null) { best = v; bestLen = len; break; }
    }
    if (best === null) { i++; continue; }
    out.push(best); i += bestLen;
  }
  return out;
}

/** The ways a run of number words can be meant, as digit strings; the likeliest first. */
function readings (run) {
  const one = cardinal(run);
  if (one !== null) return [String(one)];
  const g = groups(run);
  const separate = g.join(' ');
  let joined = null;
  if (g.length >= 2 && g.every(v => v >= 0 && v <= 9)) joined = g.join('');                                    // "one seven two nine"
  else if (g.length === 2 && g[0] >= 1 && g[0] <= 99 && g[1] >= 10 && g[1] <= 99) joined = String(g[0] * 100 + g[1]);  // "seventeen twenty nine", "four fifty one"
  else if (g.length === 3 && g[0] >= 10 && g[0] <= 99 && g[1] === 0 && g[2] <= 9) joined = String(g[0] * 100 + g[2]);  // "nineteen oh five"
  return joined ? [joined, separate] : [separate];
}

function tokenize (text) {
  return String(text == null ? '' : text).toLowerCase().replace(/(\d)\.(?=\d)/g, '$1 point ').replace(/(\d)\/(?=\d)/g, '$1 over ').replace(/[-‐-―]/g, ' ').split(/\s+/).filter(Boolean);
}

function tidy (s) {
  let t = ' ' + s + ' ';
  t = t.replace(/ (?:a|an|1) half /g, ' 1/2 ').replace(/ (?:a|an|1) third /g, ' 1/3 ').replace(/ 2 thirds /g, ' 2/3 ').replace(/ (?:a|an|1) (?:quarter|fourth) /g, ' 1/4 ').replace(/ 3 (?:quarters|fourths) /g, ' 3/4 ');
  t = t.replace(/ (\d+) over (\d+) /g, ' $1/$2 ');
  t = t.replace(/ (\d+ )?point ((?:\d ?)+)/g, (m, whole, frac) => ` ${(whole || '0').trim()}.${frac.replace(/ /g, '')} `);
  t = t.replace(/ (?:negative|minus) (\d)/g, ' -$1');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * The text with number words turned into digits, in every plausible reading.
 * "twenty four" -> ["24"]; "seventeen twenty nine" -> ["1729", "17 29"]; "one half" -> ["1/2"].
 * Text without number words comes back as its only variant.
 * @returns {string[]}
 */
export function numberVariants (text) {
  const tokens = tokenize(text);
  const pieces = []; // strings, or arrays of alternative strings for a run of number words
  let i = 0; let any = false;
  while (i < tokens.length) {
    const w = tokens[i];
    const startsRun = isNumberWord(w) && !(w in SCALES) ? true : ((w === 'a' || w === 'an') && tokens[i + 1] in SCALES);
    if (!startsRun) { pieces.push(w); i++; continue; }
    const run = [];
    if (w === 'a' || w === 'an') { run.push('one'); i++; }
    while (i < tokens.length) {
      const x = tokens[i];
      if (isNumberWord(x)) { run.push(x); i++; continue; }
      // "oh" is a zero only between other number words; "and" only after "hundred" or "thousand".
      if (x === 'oh' && run.length && isNumberWord(tokens[i + 1] || '')) { run.push('zero'); i++; continue; }
      if (x === 'and' && run.length && run[run.length - 1] in SCALES && isNumberWord(tokens[i + 1] || '') && !((tokens[i + 1] || '') in SCALES)) { i++; continue; }
      break;
    }
    pieces.push(readings(run)); any = true;
  }
  const build = pick => tidy(pieces.map(p => Array.isArray(p) ? p[Math.min(pick, p.length - 1)] : p).join(' '));
  const primary = build(0);
  if (!any) return [primary];
  const alt = build(1);
  return alt === primary ? [primary] : [primary, alt];
}

/** The likeliest all-digits form of a text ("two thirds" -> "2/3"). */
export function canonNumbers (text) { return numberVariants(text)[0]; }

/** The numbers in a canonical text, as written there: ["24", "1/2", "0.5", "-1"]. */
export function numberTokens (canonText) {
  return String(canonText == null ? '' : canonText).match(/-?\d+(?:[./]\d+)?/g) || [];
}

function belowThousand (n) {
  const parts = [];
  if (n >= 100) { parts.push(UNIT_WORDS[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { parts.push(TEN_WORDS[Math.floor(n / 10)]); n %= 10; if (n) parts.push(UNIT_WORDS[n]); } else if (n > 0) parts.push(UNIT_WORDS[n]);
  return parts.join(' ');
}

function integerWords (digits) {
  // Long strings and anything with a leading zero are read digit by digit.
  if (digits.length > 7 || (digits.length > 1 && digits[0] === '0')) return digits.split('').map(d => UNIT_WORDS[Number(d)]).join(' ');
  let n = Number(digits);
  if (n === 0) return 'zero';
  const parts = [];
  if (n >= 1e6) { parts.push(belowThousand(Math.floor(n / 1e6)), 'million'); n %= 1e6; }
  if (n >= 1000) { parts.push(belowThousand(Math.floor(n / 1000)), 'thousand'); n %= 1000; }
  if (n > 0) parts.push(belowThousand(n));
  return parts.join(' ');
}

const FRACTION_WORDS = { '1/2': 'one half', '1/3': 'one third', '2/3': 'two thirds', '1/4': 'one quarter', '3/4': 'three quarters' };

/** Digits written out as words, so that numbers can be compared by sound like everything else. */
export function digitsToWords (text) {
  return String(text == null ? '' : text)
    .replace(/(\d+)\/(\d+)/g, (m, a, b) => ` ${FRACTION_WORDS[m] || integerWords(a) + ' over ' + integerWords(b)} `)
    .replace(/(\d+)\.(\d+)/g, (m, a, b) => ` ${integerWords(a)} point ${b.split('').map(d => UNIT_WORDS[Number(d)]).join(' ')} `)
    .replace(/-(?=\d)/g, ' negative ')
    .replace(/\d+/g, m => ` ${integerWords(m)} `)
    .replace(/\s+/g, ' ').trim();
}
