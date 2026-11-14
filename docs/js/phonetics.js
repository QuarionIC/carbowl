// Sound-alike keys for comparing what a speech recogniser heard with what an answerline says.
// Recognisers spell names by ear ("kirk a guard", "can't", "neecha"), so comparison happens on a
// coarse consonant skeleton with vowel positions marked, with a few alternates for letters whose
// sound depends on the language of origin (ch, w, j, gn, French silent endings).
//
// Codes: P (b,p) T (d,t,th) K (g,k,hard c,q) F (f,v,ph) S (s,z,sh,ch,j,ts) M N L R H, 'a' = any vowel run.

const isVowel = ch => ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u' || ch === 'y';

export function letters (s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd')
    .replace(/[^a-z]/g, '');
}

function encode (s, o) {
  const n = s.length;
  const out = [];
  const push = c => { if (out[out.length - 1] !== c) out.push(c); };
  const vowel = () => push('a');
  let i = 0;
  const at = (str, pos = i) => s.startsWith(str, pos);
  while (i < n) {
    const c = s[i];
    const next = s[i + 1] || '';
    const prev = s[i - 1] || '';
    if (at('tzsch')) { push('S'); i += 5; continue; }
    if (at('tsch')) { push('S'); i += 4; continue; }
    if (at('sch')) { push('S'); i += 3; continue; }
    if (at('tch')) { push('S'); i += 3; continue; }
    if (at('ch')) { push(o.chK ? 'K' : 'S'); i += 2; continue; }
    if (at('sh') || at('zh')) { push('S'); i += 2; continue; }
    if (at('ph') || at('pf')) { push('F'); i += 2; continue; }
    if (at('th')) { push('T'); i += 2; continue; }
    if (at('ght')) { push('T'); i += 3; continue; }
    if (at('gh')) { if (i === 0) push('K'); i += 2; continue; }
    if (i === 0 && (at('kn') || at('gn') || at('pn') || at('mn'))) { push('N'); i += 2; continue; }
    if (i === 0 && at('wr')) { push('R'); i += 2; continue; }
    if (i === 0 && at('ps')) { push('S'); i += 2; continue; }
    if (at('gn') && o.gnN) { push('N'); i += 2; continue; }
    if (at('mb') && i + 2 === n) { push('M'); i += 2; continue; }
    if (at('wh')) { if (s[i + 2] === 'o') push('H'); else if (o.wF) push('F'); else vowel(); i += 2; continue; }
    if (at('qu')) { push('K'); i += 2; continue; }
    if (at('ck') || at('cq')) { push('K'); i += 2; continue; }
    if (at('cz') || at('cs')) { push('S'); i += 2; continue; }
    if (at('dg') && 'eiy'.includes(s[i + 2] || '-')) { push('S'); i += 2; continue; }
    if (at('dj') || at('tj') || at('ts') || at('tz') || at('ds') || at('dz')) { push('S'); i += 2; continue; }
    if (at('ill') && o.illY && isVowel(s[i + 3] || '')) { vowel(); i += 3; continue; }
    if (at('ng')) {
      const after = s[i + 2] || '';
      push('N');
      if (after && isVowel(after)) push('K');
      i += 2; continue;
    }
    switch (c) {
      case 'a': case 'e': case 'i': case 'o': case 'u': case 'y': vowel(); break;
      case 'b': case 'p': push('P'); break;
      case 'd': case 't': push('T'); break;
      case 'g': case 'k': push('K'); break;
      case 'q': push(o.qS ? 'S' : 'K'); break;
      case 'c': push('eiy'.includes(next || '-') ? 'S' : 'K'); break;
      case 'f': case 'v': push('F'); break;
      case 's': case 'z': push('S'); break;
      case 'x': if (i === 0) push('S'); else { push('K'); push('S'); } break;
      case 'j': if (o.jY) vowel(); else push('S'); break;
      case 'w': if (o.wF) push('F'); else vowel(); break;
      case 'h': if (i === 0 && isVowel(next)) push('H'); else if (isVowel(prev) && isVowel(next)) vowel(); break;
      case 'l': push('L'); break;
      case 'm': push('M'); break;
      case 'n': push('N'); break;
      case 'r': push('R'); break;
      default: break;
    }
    i++;
  }
  // Collapse vowel runs separated by nothing (push already de-duplicates), then drop final vowels.
  while (out.length > 1 && out[out.length - 1] === 'a') out.pop();
  if (o.dropFinal && out.length > 3) {
    const last = out[out.length - 1];
    if (last === 'T' || last === 'S' || (last === 'R' && /ier$/.test(s))) {
      out.pop();
      // French "-ault / -auld / -ald": the l goes too.
      if (/(ault|auld|aud|aux|eaux|ould)$/.test(s) && out[out.length - 1] === 'L') out.pop();
      while (out.length > 1 && out[out.length - 1] === 'a') out.pop();
    }
  }
  return out.join('');
}

const keyCache = new Map();

/**
 * @param {string} text one or more words; spaces and punctuation are ignored
 * @returns {string[]} distinct sound keys, primary first
 */
export function soundKeys (text) {
  const s = letters(text);
  if (!s) return [];
  const hit = keyCache.get(s);
  if (hit) return hit;
  const base = { chK: false, wF: false, jY: false, gnN: false, qS: false, illY: false, dropFinal: false };
  const toggles = [];
  if (s.includes('ch')) toggles.push('chK');
  if (s.includes('w')) toggles.push('wF');
  if (s.includes('j')) toggles.push('jY');
  if (s.indexOf('gn') > 0) toggles.push('gnN');
  if (/q(?!u)/.test(s)) toggles.push('qS');
  if (s.includes('ill')) toggles.push('illY');
  if (/([tsdx]|ier)$/.test(s)) toggles.push('dropFinal');
  const keys = new Set([encode(s, base)]);
  for (const t of toggles) keys.add(encode(s, { ...base, [t]: true }));
  if (toggles.length > 1) {
    const all = { ...base }; for (const t of toggles) all[t] = true;
    keys.add(encode(s, all));
    // Pairs involving the commonest alternates.
    for (const t of toggles) if (t !== 'dropFinal' && toggles.includes('dropFinal')) keys.add(encode(s, { ...base, [t]: true, dropFinal: true }));
  }
  const list = [...keys].filter(Boolean);
  if (keyCache.size > 5000) keyCache.clear();
  keyCache.set(s, list);
  return list;
}

/** Damerau-Levenshtein distance (adjacent transpositions count as one edit). */
export function editDistance (a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = null;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

export function stringSimilarity (a, b) {
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - editDistance(a, b) / len;
}

const consonantCount = key => key.replace(/a/g, '').length;

/** Spelling with look-alike letters merged, so "kuhn" and "coon" count as close in spelling. */
function looseSpelling (s) {
  return s.replace(/ph/g, 'f').replace(/wh(?=o)/g, 'h').replace(/ck|[cq]/g, 'k').replace(/v/g, 'f').replace(/z/g, 's')
    .replace(/oo|ou|ew|ue/g, 'u').replace(/ee|ea|ie|ey/g, 'i').replace(/(.)\1+/g, '$1').replace(/e$/, '');
}

/**
 * How alike two words or phrases sound, from 0 to 1.
 * Short words must match exactly on their sound key and also look somewhat alike in spelling,
 * because a two-consonant skeleton is shared by far too many words.
 * @returns {{ score: number, keyA: string, keyB: string }}
 */
export function soundSimilarity (a, b) {
  const ka = soundKeys(a); const kb = soundKeys(b);
  let best = { score: 0, keyA: ka[0] || '', keyB: kb[0] || '' };
  if (!ka.length || !kb.length) return best;
  const la = letters(a); const lb = letters(b);
  if (la === lb) return { score: 1, keyA: ka[0], keyB: kb[0] };
  const spell = stringSimilarity(la, lb);
  const loose = Math.max(spell, stringSimilarity(looseSpelling(la), looseSpelling(lb)));
  for (const x of ka) {
    for (const y of kb) {
      const short = Math.min(consonantCount(x), consonantCount(y));
      let score;
      if (short <= 1) score = x === y && loose >= 0.5 ? 0.85 : Math.min(0.6, stringSimilarity(x, y));
      else if (short === 2) score = x === y ? (loose >= 0.34 ? 0.9 : 0.7) : Math.min(0.7, stringSimilarity(x, y));
      else score = stringSimilarity(x, y);
      if (score > best.score) best = { score, keyA: x, keyB: y };
    }
  }
  // Agreement in spelling is evidence too: "inquiry" / "enquiry", "color" / "colour".
  if (spell > best.score) best = { score: spell, keyA: best.keyA, keyB: best.keyB };
  return best;
}
