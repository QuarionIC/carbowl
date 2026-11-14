// Decides what a spoken utterance means in the current state of the game: a buzz, a command,
// an answer, or nothing (noise, or the app hearing its own voice).

import { wordsOf } from './speechtext.js';
import { soundKeys } from './phonetics.js';

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
  { name: 'resume', re: /^(?:resume|resume (?:the )?(?:quiz|game|reading)|continue|keep going|go on|go ahead|start|unpause|carry on|play)$/ }
];

/**
 * @param {string} text transcript
 * @param {string[]} allowed command names valid right now
 * @returns {string|null} command name
 */
export function classifyCommand (text, allowed) {
  const s = wordsOf(text).join(' ').replace(/^(?:okay|ok|please|uh|um|hey|so|and|well|yeah)\s+/, '').replace(/\s+(?:please|now)$/, '');
  if (!s) return null;
  for (const c of COMMANDS) if (allowed.includes(c.name) && c.re.test(s)) return c.name;
  return null;
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
