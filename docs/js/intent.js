// Decides what a spoken utterance means in the current state of the game: a buzz, a command,
// an answer, or nothing (noise, or the app hearing its own voice).

import { wordsOf } from './speechtext.js';
import { soundKeys, soundSimilarity, stringSimilarity } from './phonetics.js';

const BUZZ_WORDS = new Set(['buzz', 'buzzed', 'buzzes', 'buzzs', 'buzzing', 'buzzer', 'buz', 'buzzz', 'bus', 'buss', 'buses', 'boss', 'bzz', 'bzzt', 'fuzz', 'buzzy', 'busz', 'buzzin']);

/** True for "buzz" and the spellings a recogniser commonly gives a short, isolated "buzz". */
export function isBuzzLike (word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return false;
  if (BUZZ_WORDS.has(w)) return true;
  if (/^bu+[zs]+(e[sd]|s)?$/.test(w)) return true;
  // Close misses such as "bauses", "buhz", "bozz": starts with b, short, sibilant ending.
  if (/^b[aou]h?[uo]?[zs]{1,2}(es)?$/.test(w) && w.length <= 6) return true;
  return false;
}

/**
 * @param {{ text: string, dur?: number }} utt transcript and speech duration (seconds)
 * @param {'strict'|'normal'|'off'} sensitivity
 * @returns {{ buzz: boolean, rest: string, why: string }} rest = words after the buzz word (an answer given in the same breath)
 */
export function classifyBuzz (utt, sensitivity = 'normal') {
  const none = { buzz: false, rest: '', why: '' };
  if (sensitivity === 'off') return none;
  const words = wordsOf(utt.text);
  if (!words.length) return none;
  const at = words.findIndex(isBuzzLike);
  // A buzz word must come first or after a single filler ("uh buzz"), never deep inside a sentence.
  if (at >= 0 && at <= 1) return { buzz: true, rest: words.slice(at + 1).join(' '), why: 'buzz word' };
  if (sensitivity === 'normal' && words.length <= 2 && (utt.dur === undefined || utt.dur <= 1.0)) {
    // A short blurt during a tossup is almost always the buzz, even when the word was misheard.
    // Words that sound like "buzz" (b/p/f + vowel + s/z) or any single short word qualify.
    const key = soundKeys(words[0])[0] || '';
    if (words.length === 1 || /^[PF]aS/.test(key)) return { buzz: true, rest: '', why: 'short blurt' };
  }
  return none;
}

const COMMANDS = [
  { name: 'right', re: /^(?:i was (?:right|correct)|that was (?:right|correct)|that's (?:right|correct)|thats (?:right|correct)|mark (?:it |that )?(?:as )?(?:right|correct)|count (?:it|that)|i got (?:it|that)(?: right)?|i said that|override)$/ },
  { name: 'wrong', re: /^(?:i was wrong|that was wrong|that's wrong|thats wrong|mark (?:it |that )?(?:as )?(?:wrong|incorrect)|i got (?:it|that) wrong|i was incorrect|that was incorrect)$/ },
  { name: 'skip', re: /^(?:skip|skip (?:it|this|that)|skip (?:the |this |that )?question|next|next question|next one|move on)$/ },
  { name: 'repeat', re: /^(?:repeat|repeat (?:it|that)|repeat (?:the |this |that )?question|say (?:it|that) again|read (?:it|that) again|again|one more time)$/ },
  // Two words on purpose: a lone "pause" is too easily a misheard "buzz".
  { name: 'pause', re: /^(?:pause (?:the |this )?(?:quiz|game|reading|question)|stop (?:the |this )?(?:quiz|game|reading)|hold on|wait a (?:second|minute|moment|sec))$/ },
  { name: 'resume', re: /^(?:resume|resume (?:the )?(?:quiz|game|reading)|continue|keep going|go on|go ahead|start|unpause|carry on|play)$/ },
  // Reading speed. Two words, so a stray "faster" in a question or a conversation changes nothing.
  { name: 'faster', re: /^(?:(?:read|go|talk|speak) (?:a (?:bit|little) )?faster|speed (?:it )?up|(?:a (?:bit|little)|much) faster)$/ },
  { name: 'slower', re: /^(?:(?:read|go|talk|speak) (?:a (?:bit|little) )?slower|slow (?:it )?down|(?:a (?:bit|little)|much) slower)$/ }
];

export const ALL_COMMANDS = COMMANDS.map(c => c.name);

// Command words of four letters or more. A recogniser often writes one of these by ear ("raid
// faster", "paws quiz", "I was write"), so heard words are snapped to the command word they sound like.
const COMMAND_WORDS = ['read', 'talk', 'speak', 'faster', 'slower', 'speed', 'slow', 'down', 'pause', 'quiz', 'game', 'reading', 'question', 'stop', 'hold', 'wait', 'second', 'minute', 'moment', 'skip', 'next', 'repeat', 'again', 'resume', 'continue', 'right', 'wrong', 'correct', 'incorrect', 'mark', 'going', 'keep', 'carry', 'start', 'play', 'more', 'time', 'little', 'much', 'move', 'that', 'this'];
const COMMAND_WORD_SET = new Set(COMMAND_WORDS);
const alikeCache = new Map();
/**
 * The command words a heard word could stand for, best first. Several can sound the same
 * ("write" may be "right" or "read"), so all close ones are kept and the phrase decides.
 */
function soundAlikes (w) {
  if (w.length < 3 || COMMAND_WORD_SET.has(w) || isBuzzLike(w)) return [w]; // "buzz" sounds like "pause" but is never a command
  let hit = alikeCache.get(w);
  if (!hit) {
    const found = [];
    for (const c of COMMAND_WORDS) {
      const s = soundSimilarity(w, c).score;
      if (s >= 0.85) found.push([s + 0.01 * stringSimilarity(w, c), c]);
    }
    found.sort((a, b) => b[0] - a[0]);
    hit = found.length ? found.slice(0, 3).map(f => f[1]) : [w];
    if (alikeCache.size > 2000) alikeCache.clear();
    alikeCache.set(w, hit);
  }
  return hit;
}

/** Every reading of the transcript with sound-alike words replaced by command words (bounded). */
function readings (text) {
  const options = wordsOf(text).slice(0, 12).map(soundAlikes);
  let out = [''];
  for (const opts of options) {
    const next = [];
    for (const prefix of out) for (const o of opts) { if (next.length < 48) next.push(prefix ? prefix + ' ' + o : o); }
    out = next;
  }
  return out.map(s => s.replace(/^(?:okay|ok|please|uh|um|hey|so|and|well|yeah)\s+/, '').replace(/\s+(?:please|now)$/, '')).filter(Boolean);
}

/**
 * @param {string} text transcript
 * @param {string[]} allowed command names valid right now
 * @returns {string|null} command name
 */
export function classifyCommand (text, allowed) {
  const candidates = readings(text);
  for (const c of COMMANDS) {
    if (!allowed.includes(c.name)) continue;
    for (const s of candidates) if (c.re.test(s)) return c.name;
  }
  return null;
}

// First words of commands that need a second word. On their own they mean nothing yet.
const COMMAND_LEADS = new Set(['read', 'talk', 'speak', 'speed', 'slow', 'pause', 'stop', 'hold', 'wait', 'keep', 'carry']);

/**
 * True when the utterance is a single word that could be the first half of a two-word command
 * whose second half is still to come ("read", "pause", "slow"). A buzz word never qualifies.
 */
export function isCommandLead (text) {
  const raw = wordsOf(text);
  if (raw.length !== 1 || isBuzzLike(raw[0])) return false;
  return soundAlikes(raw[0]).some(w => COMMAND_LEADS.has(w));
}

/**
 * True when what was heard is just the app's own speech leaking back into the microphone:
 * most heard words occur, in order, in the text spoken around that moment.
 * @param {string} heard transcript
 * @param {string} spoken text the app was saying at that time (a few seconds either side)
 */
export function isEcho (heard, spoken) {
  const h = wordsOf(heard); const s = wordsOf(spoken);
  if (h.length === 0) return false;
  if (!s.length) return false;
  // Longest common subsequence of words, allowing light misspelling of each word.
  const same = (a, b) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))));
  const dp = new Array(s.length + 1).fill(0);
  for (let i = 1; i <= h.length; i++) {
    let prev = 0;
    for (let j = 1; j <= s.length; j++) {
      const tmp = dp[j];
      dp[j] = same(h[i - 1], s[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const matched = dp[s.length];
  // One short common word ("this", "that") proves nothing; it is more likely a misheard buzz.
  if (h.length === 1) return matched === 1 && h[0].length >= 5;
  return matched / h.length >= 0.6;
}

const FILLER_ONLY_RE = /^(?:uh+|um+|er+|erm+|hm+|hmm+|ah+|oh+|mm+|mhm|so|well|okay|ok|like|let me think|let's see|lets see|i think|wait|hold on|one second|one sec|give me a second|the|a)(?:\s+(?:uh+|um+|er+|hm+|hmm+|ah+|oh+|so|well|okay|ok|like|the|a))*$/;

/** True when the utterance carries no answer yet ("um", "let me think"), so listening should continue. */
export function isFillerOnly (text) {
  const s = wordsOf(text).join(' ');
  return !s || FILLER_ONLY_RE.test(s);
}
