// Judges a spoken answer against a QBReader answerline.
//
// Two judges vote. The first is QBReader's own checker (qb-answer-checker), which understands
// answerline grammar exactly but expects typed text. The second compares by sound, because a
// speech recogniser writes names by ear ("kirk a guard"). An answer is accepted if either accepts.

import { soundSimilarity } from './phonetics.js';
import { numberVariants, canonNumbers, numberTokens, digitsToWords } from './numbers.js';

const DIRECTIVES = {
  accept: ['accept', 'or', 'antiprompt on', 'anti-prompt on', 'antiprompt', 'anti-prompt', 'also accept'],
  prompt: ['prompt on', 'prompt'],
  reject: ['do not accept or prompt on', 'do not accept', 'do not prompt on', 'do not prompt', 'reject', "don't accept or prompt on", "don't accept"]
};
const ALL_DIRECTIVES = Object.values(DIRECTIVES).flat();
const startsWithPhrase = (s, phrase) => s.startsWith(phrase) && (s.length === phrase.length || /[\s:,"'<(]/.test(s[phrase.length]));

/**
 * Names that are written with symbols are said as words ("C++" is "C plus plus", "C#" is "C sharp",
 * "A*" is "A star"). Without this the symbols are simply dropped and "C" alone would match.
 */
export function symbolNames (s) {
  return String(s == null ? '' : s)
    .replace(/\b([A-Za-z][A-Za-z0-9]*)\+\+/g, '$1 plus plus')
    .replace(/\b([A-Ga-gJj])#/g, '$1 sharp').replace(/#([A-Z])\b/g, 'sharp $1')
    .replace(/\b([Aa])\*/g, '$1 star');
}

function normalize (s) {
  return symbolNames(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/þ/g, 'th').replace(/ð/g, 'd')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\(s\)/g, 's')
    .replace(/[“”„‟❝❞]/g, '"')
    .replace(/[‘-‛]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/[·⋅‧]/g, '')
    .replace(/<\/?(i|em)>/g, '');
}
const stripTags = s => s.replace(/<[^>]*>/g, '');
// A decimal point or a fraction bar between digits is part of the number, not punctuation.
const plain = s => stripTags(s).replace(/(\d)\.(?=\d)/g, '$1 point ').replace(/(\d)\/(?=\d)/g, '$1 over ').replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();

function underlined (s) {
  const m = s.match(/<u>[\s\S]*?<\/u>/g);
  if (!m) return '';
  return plain(m.map(x => x.slice(3, -4)).join(' '));
}
function quoted (s) {
  const m = stripTags(s).match(/"[^"]+"/g);
  if (!m) return [];
  return m.map(x => plain(x.slice(1, -1))).filter(Boolean);
}

// Conditions a moderator applies ("accept X before 'Y' is read"); they are not part of the answer.
const CONDITION_RE = /\s+(?:before|until|after|once|unless|if)\s+(?:"|'|it\b|they\b|he\b|she\b|mention|mentioned|read|the end|the word|that|[\w' -]+ (?:is|are|was|has been|have been) (?:read|mentioned|said|given))[\s\S]*$/;
const TRAILING_NOTE_RE = /\s+(?:but do not|by asking|with ["']|so long as|as long as|at any (?:point|time)|in place of|alone|in (?:either|any) order|or (?:other )?(?:obvious |clear |reasonable )?equivalents?|or (?:other )?(?:similar|synonymous|descriptive|reasonable) answers?|or word forms?|and word forms?)\b[\s\S]*$/;
const META_ANSWER_RE = /^(?:obvious |clear |reasonable |other |any |similar )*(?:equivalents?|word forms?|synonyms?|descriptions?|descriptive answers?|answers? (?:like|such as|indicating|mentioning|that)\b.*|partial answers?|either(?: underlined)?(?: part| name| answer)?|any underlined (?:portion|part|answer)|in either order|in any order|more specific answers?|less specific answers?|anything (?:mentioning|indicating|involving|like)\b.*|other answers?.*|similar answers?.*|specific .*)$/;

/**
 * Removes moderator conditions such as: accept First Critique before "Kant" is read.
 * Left in, the quoted word ("Kant") would itself be taken for an acceptable answer.
 */
export function stripConditions (answerline) {
  return String(answerline == null ? '' : answerline)
    .replace(/\s+(?:before|until|after|once)\s+(?:the\s+)?(?:mention\s+of\s+|word\s+)?(?:<[^>]+>)*["\u201C][^"\u201D\];]*["\u201D](?:<[^>]+>)*(?:\s+(?:is|are|was|has\s+been|have\s+been)\s+(?:read|mentioned|said|given))?/gi, '')
    .replace(/\s+(?:before|until|after)\s+(?:it\s+is\s+|they\s+are\s+|being\s+)?(?:read|mentioned|mention)\b/gi, '');
}

function cleanCandidate (text) {
  let t = text.replace(CONDITION_RE, '').replace(TRAILING_NOTE_RE, '').trim();
  t = t.replace(/^(?:either|just|simply|only|answers? (?:like|such as|of)|the (?:phrase|term|word|name)|word forms? (?:of|like|such as))\s+/, '');
  t = t.replace(/^[:\s]+/, '').replace(/[.\s]+$/, '');
  return t;
}

/**
 * @param {string} answerline QBReader answer HTML (with <b>/<u> marks when available)
 * @returns {{ main: string, clauses: { directive: 'accept'|'prompt'|'reject', phrases: string[], directedPrompt?: string, isMain?: boolean }[] }}
 */
export function parseAnswerline (answerline) {
  let a = normalize(stripConditions(answerline));
  if (/<b>/.test(a) && !/<u>/.test(a)) a = a.replace(/<b>/g, '<u>').replace(/<\/b>/g, '</u>');
  if (a.includes('[') && !a.includes(']')) a += ']';
  a = a.replace(/<\/?(b|strong)>/g, '');

  const sectionBodies = [];
  const mainRaw = a.replace(/\[[^\]]*\]/g, m => { sectionBodies.push(m.slice(1, -1)); return ' '; });
  // Parentheses in the main answer: a directive section, or an optional part of the answer.
  let mainWithOptional = mainRaw;
  let mainWithoutOptional = mainRaw;
  mainRaw.replace(/\(([^)]*)\)/g, (m, inner) => {
    const body = stripTags(inner).trim();
    if (ALL_DIRECTIVES.some(d => startsWithPhrase(body, d))) {
      sectionBodies.push(inner);
      mainWithOptional = mainWithOptional.replace(m, ' ');
    } else {
      mainWithOptional = mainWithOptional.replace(m, ' ' + inner + ' ');
    }
    mainWithoutOptional = mainWithoutOptional.replace(m, ' ');
    return m;
  });

  const clauses = [];
  const addClause = (directive, formatted, { directedPrompt, isMain } = {}) => {
    const phrases = new Set();
    for (const f of formatted) {
      const u = underlined(f);
      const full = cleanCandidate(plain(f));
      const qs = quoted(f);
      if (qs.length && !isMain) { for (const q of qs) phrases.add(cleanCandidate(q)); }
      if (u) phrases.add(u);
      if (full && !(qs.length && !isMain && !u)) phrases.add(full);
    }
    const list = [...phrases].map(p => p.replace(/^(?:the|a|an)\s+/, '').trim()).filter(p => p && !META_ANSWER_RE.test(p));
    if (list.length) clauses.push({ directive, phrases: [...new Set(list)], directedPrompt, isMain: !!isMain });
  };

  // Main answer: alternatives joined by " or " are each acceptable.
  const mainAlternatives = v => v.split(/,? or /).map(s => s.trim()).filter(Boolean);
  addClause('accept', [...mainAlternatives(mainWithoutOptional), ...mainAlternatives(mainWithOptional)], { isMain: true });
  const main = clauses.length ? clauses[0].phrases[0] : plain(mainWithoutOptional);

  for (const body of sectionBodies) {
    for (let clause of body.split(';')) {
      clause = clause.trim();
      if (!clause) continue;
      let directive = 'accept';
      const bare = stripTags(clause).trim();
      let found = false;
      // Longest phrases first so "do not accept or prompt on" wins over "do not accept".
      const ordered = Object.entries(DIRECTIVES).flatMap(([d, phrases]) => phrases.map(p => [d, p])).sort((x, y) => y[1].length - x[1].length);
      for (const [d, phrase] of ordered) {
        if (startsWithPhrase(bare, phrase)) {
          directive = d; found = true;
          const idx = clause.indexOf(phrase);
          clause = clause.slice(idx + phrase.length).replace(/^[\s:]+/, '');
          break;
        }
      }
      if (!found && /^(note|the language|i\.e\.|e\.g\.|this |it |they |read |moderator)/.test(bare)) continue;
      let directedPrompt;
      if (directive === 'prompt') {
        const m = clause.match(/\s+(?:by asking|with)\s+["']?([^"']+)["']?/);
        if (m && /by asking|with ["']/.test(clause)) { directedPrompt = stripTags(m[1]).trim(); clause = clause.slice(0, m.index); }
      }
      const formatted = clause.split(/,? or |, (?:and |or )?/).map(s => s.trim()).filter(Boolean);
      addClause(directive, formatted, { directedPrompt });
    }
  }

  const whole = stripTags(a);
  const mainTokens = (main || '').split(' ').filter(t => t.length > 2);
  if (/accept either|accept any\b/.test(whole) && mainTokens.length > 1) clauses.push({ directive: 'accept', phrases: mainTokens });
  if (/prompt on (?:a )?partial|prompt on either/.test(whole) && mainTokens.length > 1) clauses.push({ directive: 'prompt', phrases: mainTokens });
  return { main, clauses };
}

const FILLER_RE = /^(?:buzz|uh+|um+|er+|erm+|hm+|ah+|oh|okay|ok|so|well|yeah|yes|right|like|i think|i believe|i guess|i suppose|i want to say|i would say|i'd say|i'll say|i am going to say|i'm going to say|i'm gonna say|im gonna say|gonna say|let's say|lets say|let's go with|lets go with|i'll go with|going with|maybe|probably|possibly|perhaps|is it|is that|is this|it is|it's|its|that is|that's|thats|this is|what is|what are|who is|who are|what's|who's|the answer is|my answer is|answer is|answer|could it be|would it be|it could be|it might be|might be|that would be|this would be|that'd be)\b[\s,]*/;
const GIVE_UP_RE = /^(?:i (?:do not|don't|dont) know|(?:i have |i've got )?no (?:idea|clue)|pass|skip|next|nothing|no answer|i (?:give up|forget|forgot)|(?:i'm |im )?not sure|dunno|i (?:can't|cannot) remember|who knows)$/;

export function normalizeTranscript (t) {
  let s = normalize(t).replace(/[.,!?;:"()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(FILLER_RE, '');
    if (next === s || !next.trim()) break; // never strip the whole answer away
    s = next.trim();
  }
  return s.replace(/[\s,]+(?:i think|i guess|i believe|maybe|probably|right|question mark)$/, '').trim();
}

export function isGiveUp (t) {
  const s = normalize(t).replace(/[.,!?;:"]/g, ' ').replace(/\s+/g, ' ').trim();
  return GIVE_UP_RE.test(s);
}

const ARTICLE_RE = /^(?:the|a|an)$/;

/** Best sound match between any run of consecutive transcript words and the phrase. */
export function bestWindowMatch (transcriptTokens, phrase) {
  const pTokens = phrase.split(' ').filter(Boolean);
  const pJoined = pTokens.join('');
  let best = { score: 0, window: '' };
  if (!pJoined) return best;
  const n = transcriptTokens.length;
  const maxLen = Math.min(n, pTokens.length + 4, 12);
  for (let i = 0; i < n; i++) {
    if (ARTICLE_RE.test(transcriptTokens[i]) && n - i > 1) continue; // a window never starts on an article
    let joined = '';
    for (let len = 1; len <= maxLen && i + len <= n; len++) {
      joined += transcriptTokens[i + len - 1];
      // Cheap length filter before the comparatively costly comparison.
      if (joined.length < pJoined.length * 0.5 || joined.length > pJoined.length * 2 + 2) continue;
      const { score } = soundSimilarity(joined, pJoined);
      if (score > best.score) best = { score, window: transcriptTokens.slice(i, i + len).join(' ') };
    }
  }
  return best;
}

const RANK = { accept: 3, prompt: 2, reject: 1 };

/**
 * @param {object} o
 * @param {string} o.answerline answer HTML from QBReader
 * @param {string[]} o.transcripts what the recogniser heard, best guess first
 * @param {Function} [o.checkAnswer] qb-answer-checker's default export
 * @param {number} [o.threshold] sound similarity needed to accept (0..1)
 * @param {string[]} [o.previous] earlier answers in a prompt chain
 * @returns {{ directive: 'accept'|'prompt'|'reject', directedPrompt?: string, heard: string, method: string, score: number, matched?: string, gaveUp?: boolean, empty?: boolean }}
 */
export function judgeAnswer ({ answerline, transcripts, checkAnswer, threshold = 0.8, previous = [] }) {
  const heardAll = (transcripts || []).map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  const heard = heardAll[0] || '';
  if (!heardAll.length) return { directive: 'reject', heard: '', method: 'empty', score: 0, empty: true };
  if (heardAll.every(isGiveUp)) return { directive: 'reject', heard, method: 'gave-up', score: 0, gaveUp: true };

  const variants = new Set();
  for (const t of heardAll) {
    const norm = normalizeTranscript(t);
    if (norm) variants.add(norm);
    for (const p of previous) {
      const pn = normalizeTranscript(p);
      if (pn && norm) { variants.add(`${pn} ${norm}`); variants.add(`${norm} ${pn}`); }
    }
  }
  // Spoken numbers also in digits ("twenty four" as "24"), which is how answer lines write them.
  for (const v of [...variants]) for (const n of numberVariants(v)) variants.add(n);
  const parsed = parseAnswerline(answerline);
  // For the comparison by sound every phrase has its numbers in words, and its numbers noted in
  // digits: where both sides name numbers they must be the same numbers ("root 2" is not "root 3").
  const bySound = new Map();
  const soundForm = phrase => {
    let f = bySound.get(phrase);
    if (!f) { const canon = canonNumbers(phrase); f = { words: digitsToWords(canon), numbers: numberTokens(canon) }; bySound.set(phrase, f); }
    return f;
  };
  const official = symbolNames(stripConditions(answerline));
  let result = { directive: 'reject', heard, method: 'none', score: 0 };
  const better = cand => {
    if (RANK[cand.directive] > RANK[result.directive] || (cand.directive === result.directive && cand.score > result.score)) result = { ...cand, heard };
  };

  for (const v of variants) {
    // Judge 1: QBReader's checker on the text as heard.
    if (typeof checkAnswer === 'function') {
      try {
        const r = checkAnswer(official, v);
        if (r && r.directive === 'accept') return { directive: 'accept', heard, method: 'exact', score: 1, matched: v };
        if (r && r.directive === 'prompt') better({ directive: 'prompt', directedPrompt: r.directedPrompt || undefined, method: 'exact', score: 1, matched: v });
      } catch (e) { /* fall through to the sound judge */ }
    }
    // Judge 2: by sound.
    const canonHeard = canonNumbers(v);
    const heardNumbers = numberTokens(canonHeard);
    const tokens = digitsToWords(canonHeard).split(' ').filter(Boolean);
    const top = { accept: { score: 0 }, prompt: { score: 0 }, reject: { score: 0 } };
    for (const clause of parsed.clauses) {
      for (const phrase of clause.phrases) {
        const form = soundForm(phrase);
        if (form.numbers.length && heardNumbers.length && !form.numbers.every(x => heardNumbers.includes(x))) continue;
        const m = bestWindowMatch(tokens, form.words);
        if (m.score > top[clause.directive].score) top[clause.directive] = { score: m.score, phrase, window: m.window, directedPrompt: clause.directedPrompt };
      }
    }
    const rejected = top.reject.score >= threshold && top.reject.score >= top.accept.score;
    if (!rejected && top.accept.score >= threshold) better({ directive: 'accept', method: 'sound', score: top.accept.score, matched: top.accept.phrase });
    else if (!rejected && top.prompt.score >= threshold) better({ directive: 'prompt', directedPrompt: top.prompt.directedPrompt, method: 'sound', score: top.prompt.score, matched: top.prompt.phrase });
    else if (result.directive === 'reject' && top.accept.score > result.score) result = { ...result, score: top.accept.score, matched: top.accept.phrase };
  }
  return result;
}
