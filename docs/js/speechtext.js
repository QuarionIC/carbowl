// Turns QBReader question text into something a speech synthesiser reads well, and splits it into
// sentence-sized chunks with character offsets so reading progress (and the power mark) can be tracked.

const POWER_SENTINEL = '\u0001';

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'vs', 'etc', 'no', 'vol', 'ca', 'fl', 'ed', 'trans',
  'gen', 'col', 'lt', 'sgt', 'rev', 'fr', 'mt', 'ft', 'op', 'cf', 'e.g', 'i.e', 'u.s', 'u.k', 'a.d', 'b.c',
  'b.c.e', 'c.e', 'ph.d', 'pp', 'ch', 'bk', 'pt', 'viz', 'esp', 'approx', 'inc', 'ltd', 'co', 'messrs', 'mme', 'mlle'
]);

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities (s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITY_MAP[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const DIRECTION_RE = /^(read|reads|emphasi[sz]e|emphasis|pause|slowly|moderator|note to (the )?(moderator|reader)|notes? for (the )?(moderator|reader)|do not read|don't read|pronounced?|pron\.?|rhymes with|sic\b)/i;

/**
 * True when the text inside a pair of brackets or parentheses is a pronunciation guide or a note to the reader.
 * @param {boolean} [bracketed] square brackets: lowercase hyphenated respellings such as [shaw-krun] count too
 */
export function isReaderNote (inner, bracketed = false) {
  let s = String(inner).trim();
  if (!s) return true;
  if (DIRECTION_RE.test(s)) return true;
  const quoted = /^["'].*["']$/.test(s);
  if (quoted) s = s.slice(1, -1).trim();
  if (!s) return true;
  if (!/^[A-Za-zÀ-ɏ'" \-‐‑.]+$/.test(s)) return false;
  const words = s.split(/\s+/);
  const hasHyphen = /[-‐‑]/.test(s);
  const capsRun = /[A-Z]{2,}/.test(s);
  // A short quoted aside is a respelling ("mire", "nine four", "meese van der roh").
  if (quoted) return words.length <= 6;
  // Unquoted: hyphenated syllables, usually with the stressed one in capitals (KEER-kuh-gard).
  return words.length <= 6 && hasHyphen && (capsRun || bracketed);
}

const GREEK = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'gamma', Δ: 'delta', Θ: 'theta', Λ: 'lambda', Ξ: 'xi', Π: 'pi', Σ: 'sigma', Φ: 'phi', Ψ: 'psi', Ω: 'omega' };
const SYMBOLS = { '½': ' one half ', '⅓': ' one third ', '⅔': ' two thirds ', '¼': ' one quarter ', '¾': ' three quarters ', '²': ' squared ', '³': ' cubed ', '×': ' times ', '÷': ' divided by ', '≤': ' less than or equal to ', '≥': ' greater than or equal to ', '≠': ' not equal to ', '≈': ' approximately ', '±': ' plus or minus ', '∞': ' infinity ', '√': ' square root of ', '∑': ' sum ', '∫': ' integral ', '∈': ' in ', '∪': ' union ', '∩': ' intersect ', '→': ' to ', '↔': ' if and only if ', '°': ' degrees ', '∂': ' partial ', '∇': ' del ', '⊕': ' direct sum ', '⊗': ' tensor ', '·': ' ' };
const SIMPLE_FRACTIONS = { '1/2': 'one half', '1/3': 'one third', '2/3': 'two thirds', '1/4': 'one quarter', '3/4': 'three quarters' };
const POWER_WORD = { 2: ' squared', 3: ' cubed' };

/**
 * Math and programming notation, written the way a moderator would say it: "2^n" as "2 to the n",
 * "C++" as "C plus plus", "O(n log n)" as "O of n log n". Ordinary prose passes through untouched.
 */
export function notationForSpeech (t) {
  // Names of languages and algorithms first, before "+", "#" and "*" are read as operators.
  t = t.replace(/\b([A-Za-z][A-Za-z0-9]*)\+\+/g, '$1 plus plus').replace(/\b([A-GJ])#/g, '$1 sharp').replace(/#([A-Z])\b/g, 'sharp $1').replace(/\bA\*/g, 'A star');
  t = t.replace(/#\s?(\d)/g, 'number $1');
  // Powers: an explicit caret, or a flattened superscript next to an operator ("x2 + y2 = r2").
  t = t.replace(/([A-Za-z0-9)])\^\(?(-?[A-Za-z0-9]+(?:[+-][A-Za-z0-9]+)?)\)?/g, (m, base, exp) => base + (POWER_WORD[exp] || (exp === '-1' ? ' inverse' : ' to the ' + exp.replace(/^-/, 'minus '))));
  t = t.replace(/\b([a-z])([23])(?=\s*[+=])/g, (m, v, p) => v + POWER_WORD[p]);
  t = t.replace(/([+=]\s*)([a-z])([23])\b/g, (m, lead, v, p) => lead + v + POWER_WORD[p]);
  // Functions and orders of growth: "O(E logE)" -> "O of E log E", "f(x)" -> "f of x".
  t = t.replace(/\b([OΘΩ])\(([^()]{1,40})\)/g, (m, f, inner) => `${GREEK[f] ? 'big ' + GREEK[f] : 'O'} of ${inner.replace(/log(?=[A-Za-z0-9])/g, 'log ')}`);
  t = t.replace(/\b([fghFGPT])\(([a-z](?:, ?[a-z])*)\)/g, (m, f, args) => `${f} of ${args.replace(/, ?/g, ' and ')}`);
  // Identifiers written with underscores are read as their words.
  t = t.replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, '$1 ');
  t = t.replace(/\b(\d)\/(\d)\b(?![/\d])/g, m => SIMPLE_FRACTIONS[m] || m);
  // Operators between terms. A "+" inside a name was handled above; "=" has no other use in prose.
  t = t.replace(/([A-Za-z0-9)])\s*\+\s*(?=[A-Za-z0-9(])/g, '$1 plus ');
  t = t.replace(/\s*=\s*/g, ' equals ');
  t = t.replace(/(\S)\s+<\s+(?=\S)/g, '$1 less than ').replace(/(\S)\s+>\s+(?=\S)/g, '$1 greater than ');
  t = t.replace(/[½⅓⅔¼¾²³×÷≤≥≠≈±∞√∑∫∈∪∩→↔°∂∇⊕⊗·]/g, ch => SYMBOLS[ch]);
  t = t.replace(/[α-ωΓΔΘΛΞΠΣΦΨΩ]/g, ch => ` ${GREEK[ch] || ''} `);
  return t;
}

/**
 * Cleans raw (sanitized) question text for speech and display.
 * @returns {{ text: string, powerOffset: number }} powerOffset is the character offset of the power
 *   mark "(*)" in the cleaned text, or -1 when the question has none.
 */
export function cleanForSpeech (raw) {
  // Tags only: a bare "<" in "x < y" is not the start of one.
  let t = decodeEntities(String(raw == null ? '' : raw).replace(/<\/?[A-Za-z][^<>]*>/g, ''));
  t = t.replace(/[“”„‟″«»]/g, '"').replace(/[‘’‚‛′]/g, "'");
  t = t.replace(/[  -   　]/g, ' ').replace(/[​-‍﻿]/g, '');
  // Power marks: "(*)" is the standard one; "(+)" marks a superpower in a few sets.
  let seenPower = false;
  t = t.replace(/\(\s*\*\s*\)/g, () => { if (seenPower) return ' '; seenPower = true; return ` ${POWER_SENTINEL} `; });
  t = t.replace(/\(\s*\+\s*\)/g, ' ');
  // Bonus part value markers such as "[10]", "[10e]", "[10m]", "[h]".
  t = t.replace(/^\s*\[\s*(?:\d{1,2}\s*[emh]?|[emh])\s*\]\s*/i, '');
  // Pronunciation guides and notes to the reader.
  t = t.replace(/\s*\(([^()]{1,90})\)/g, (m, inner) => isReaderNote(inner) ? '' : m);
  // Kept brackets are editorial insertions inside quotations: "restor[ing]" joins, "[this position]" stands alone.
  t = t.replace(/(\s*)\[([^\[\]]{1,160})\]/g, (m, space, inner) => isReaderNote(inner, true) ? '' : (space ? ' ' : '') + inner.trim());
  // Shouted asides ("NOTE TO PLAYERS: THREE ANSWERS REQUIRED") are read as words, not spelled out.
  t = t.replace(/\b[A-Z]{2,}(?:[ :,]+[A-Z]{2,}){2,}\b/g, m => m[0] + m.slice(1).toLowerCase());
  // Old-style abbreviations.
  t = t.replace(/\bFTPE\b/g, 'for 10 points each').replace(/\bFTP\b/g, 'for 10 points');
  // Symbols that synthesisers read badly.
  t = t.replace(/(\d)\s*[–‒]\s*(\d)/g, '$1 to $2');
  t = t.replace(/\s*[—―]\s*|\s+[–‒]\s+|\s+--+\s+/g, ', ');
  t = t.replace(/[–‒‐‑]/g, '-');
  t = t.replace(/…/g, '...');
  t = t.replace(/_{2,}/g, ' blank ');
  t = t.replace(/\s*&\s*/g, ' and ');
  t = notationForSpeech(t);
  // Whitespace and punctuation tidy-up.
  t = t.replace(/\s+/g, ' ').replace(/ ([,.;:!?])/g, '$1').replace(/,(\s*,)+/g, ',').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
  let powerOffset = t.indexOf(POWER_SENTINEL);
  if (powerOffset >= 0) {
    const before = t.slice(0, powerOffset).replace(/\s+$/, '');
    const after = t.slice(powerOffset + 1).replace(/^\s+/, '');
    t = before + (before && after ? ' ' : '') + after;
    powerOffset = before.length ? before.length + 1 : 0;
    if (!after) powerOffset = t.length;
  }
  return { text: t, powerOffset };
}

/** Splits text into sentences without using regex lookbehind (older Safari lacks it). */
export function splitSentences (text) {
  const out = [];
  let start = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    // Swallow runs of terminators and closing quotes/brackets.
    let j = i + 1;
    while (j < n && /[.!?"')\]]/.test(text[j])) j++;
    if (j >= n) break;
    if (text[j] !== ' ') { i = j - 1; continue; }
    let k = j;
    while (k < n && text[k] === ' ') k++;
    if (k >= n) break;
    if (!/[A-Z0-9"'(À-Þ]/.test(text[k])) { i = j - 1; continue; }
    if (ch === '.') {
      // Look at the token that ends with this period.
      let s = i - 1;
      while (s >= start && !/\s/.test(text[s])) s--;
      const token = text.slice(s + 1, i).replace(/^[("'\[]+/, '');
      const bare = token.toLowerCase();
      if (/^[A-Za-z]$/.test(token)) { i = j - 1; continue; }                 // initials: "J. L. Austin"
      if (ABBREVIATIONS.has(bare)) { i = j - 1; continue; }
      if (/^([A-Za-z]\.)+[A-Za-z]$/.test(token)) { i = j - 1; continue; }     // "U.S", "W.V.O"
    }
    out.push({ text: text.slice(start, j), start });
    start = k;
    i = k - 1;
  }
  if (start < n) {
    const rest = text.slice(start);
    if (rest.trim()) out.push({ text: rest, start });
  }
  return out;
}

/** Breaks an over-long sentence at clause boundaries so no single utterance runs too long. */
function splitLong (piece, maxChars) {
  const out = [];
  let { text, start } = piece;
  while (text.length > maxChars) {
    // Aim for equal pieces, cutting at the clause boundary nearest the target.
    const pieces = Math.ceil(text.length / maxChars);
    const target = text.length / pieces;
    const lo = Math.max(20, target * 0.55); const hi = Math.min(maxChars, target * 1.45);
    let cut = -1;
    for (const re of [/[;:]\s/g, /,\s/g, /\s(?:and|but|or|which|who|that|while|because)\s/g, /\s/g]) {
      let m; let best = -1; let bestGap = Infinity;
      while ((m = re.exec(text)) !== null) {
        // For conjunctions cut before the word; for punctuation cut after it.
        const at = /^\s\w/.test(m[0]) && m[0].length > 1 ? m.index + 1 : m.index + m[0].length;
        if (at < lo || at > hi) continue;
        const gap = Math.abs(at - target);
        if (gap < bestGap) { bestGap = gap; best = at; }
      }
      if (best > 0) { cut = best; break; }
    }
    if (cut <= 0) cut = Math.min(maxChars, Math.round(target));
    const head = text.slice(0, cut);
    out.push({ text: head.replace(/\s+$/, ''), start });
    start += cut;
    text = text.slice(cut);
    const lead = text.length - text.replace(/^\s+/, '').length;
    start += lead; text = text.slice(lead);
  }
  if (text.trim()) out.push({ text, start });
  return out;
}

/**
 * @returns {{ text: string, start: number, end: number }[]} chunks covering the text in order.
 */
export function chunkForSpeech (text, maxChars = 240) {
  const chunks = [];
  for (const s of splitSentences(text)) {
    for (const p of splitLong(s, maxChars)) chunks.push({ text: p.text, start: p.start, end: p.start + p.text.length });
  }
  return chunks;
}

/** The part of an answerline worth saying aloud: everything before the bracketed alternatives. */
export function mainAnswer (answerSanitized) {
  let t = decodeEntities(String(answerSanitized == null ? '' : answerSanitized).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  t = t.replace(/^\[([^\]]*)\]\s*(?=\S)/, (m, inner) => /^(accept|or|prompt|do not|reject|note)\b/i.test(inner.trim()) ? '' : inner.trim() + ' ');
  const bracket = t.indexOf('[');
  if (bracket > 0) t = t.slice(0, bracket).trim();
  else if (bracket === 0) t = t.replace(/[\[\]]/g, ' ').trim();
  // Said aloud, "C++" is "C plus plus" and "O(n log n)" is "O of n log n" (before parentheses are dealt with below).
  t = notationForSpeech(t);
  // Parentheses: an optional leading part is spoken ("(first-order) logic"); a directive, a pronunciation
  // guide, or a trailing remark is not; an optional middle name ("Alvin (Ira) Goldman") is dropped.
  t = t.replace(/^\(([^)]*)\)\s*(?=\S)/, (m, inner) => /^(accept|or|prompt|do not|reject)\b/i.test(inner.trim()) ? '' : inner.trim() + ' ');
  t = t.replace(/\s*\([^)]*\)/g, '').replace(/[()]/g, ' ').trim();
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').replace(/[\s,;:]+$/, '').trim();
  return t;
}

/** Escapes answerline HTML but keeps the bold/underline/italic marks that show the required part. */
export function safeAnswerHtml (answerHtml) {
  const esc = String(answerHtml == null ? '' : answerHtml)
    .replace(/&(?!(?:#x?[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/&lt;(\/?)(b|u|i|em|strong)&gt;/gi, (m, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
}

/**
 * Splits an answer line for display: the answer itself, and the bracketed notes that follow it
 * (what else is accepted or prompted). Both are safe HTML.
 * @returns {{ main: string, notes: string }}
 */
export function splitAnswerHtml (answerHtml) {
  const safe = safeAnswerHtml(answerHtml).trim();
  let inTag = false; let cut = -1; let seenText = false;
  for (let i = 0; i < safe.length; i++) {
    const ch = safe[i];
    if (ch === '<') { inTag = true; continue; }
    if (ch === '>') { inTag = false; continue; }
    if (inTag) continue;
    if (ch === '[' && seenText) { cut = i; break; }
    if (/\S/.test(ch)) seenText = true;
  }
  if (cut < 0) return { main: safe, notes: '' };
  let notes = safe.slice(cut).trim();
  // One bracketed group loses its brackets; several groups are left as written.
  if (notes.startsWith('[') && notes.indexOf('[', 1) < 0) notes = notes.slice(1).replace(/\]((?:\s*<\/[a-z]+>)*)\s*$/, '$1');
  return { main: safe.slice(0, cut).trim(), notes: notes.trim() };
}

export function escapeHtml (s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Prepares a tossup for reading.
 * @returns {{ text: string, chunks: {text:string,start:number,end:number}[], powerOffset: number }}
 */
export function prepareTossup (tossup) {
  const { text, powerOffset } = cleanForSpeech(tossup.question_sanitized);
  return { text, chunks: chunkForSpeech(text), powerOffset };
}

/**
 * Prepares a bonus for reading.
 * @returns {{ leadin: {text:string, chunks:object[]}, parts: {text:string, chunks:object[]}[] }}
 */
export function prepareBonus (bonus) {
  const leadinText = cleanForSpeech(bonus.leadin_sanitized || '').text;
  return {
    leadin: { text: leadinText, chunks: chunkForSpeech(leadinText) },
    parts: (bonus.parts_sanitized || []).map(p => {
      const text = cleanForSpeech(p).text;
      return { text, chunks: chunkForSpeech(text) };
    })
  };
}

/** Normalised lowercase word list, used to tell the app's own speech (echo) from the user's. */
export function wordsOf (s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/đ/g, 'd')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
