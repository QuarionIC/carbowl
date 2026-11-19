// How a piece of text is said. What is shown on screen stays as the question was written
// ("Louis XIV", "No. 14", "1,514 miles", "19.9%"); what the voice model is handed is this module's
// rewriting of it ("Louis the fourteenth", "Number 14", "one thousand five hundred fourteen
// miles", "19 point nine%"). The model reads plain words well and these written forms badly.
// Every rule below was added after the written form was heard to come out wrong (the model's
// speech played to a speech recogniser, three takes each) and the rewritten form right, or no
// worse and less halting; the README, "What the reader is given to say", has the cases and the
// counts. Forms that were tried and did not come out better are left as they are written
// ("etc.", "et al.", "B.C.E.", "9/4 time", "the 1990s").
//
// Two facts about the speech runtime shape these rules. It cuts the text at every full stop and
// puts it back together with a space, so "19.9" reaches the model as "19. 9"; and a character the
// model has no entry for is not dropped but handed to it as a nonsense token. So no full stop is
// left inside a number, and nothing leaves here that is outside the model's alphabet.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const ORDINAL_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];

function below1000 (n) {
  const parts = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] + ' hundred'); n %= 100; }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
  else if (n > 0 || !parts.length) parts.push(ONES[n]);
  return parts.join(' ');
}

/** A whole number in words: 1514 -> "one thousand five hundred fourteen". */
export function cardinalWords (n) {
  n = Math.floor(Math.abs(Number(n)));
  if (!Number.isFinite(n) || n >= 1e15) return String(n);
  if (n < 1000) return below1000(n);
  const parts = [];
  for (const [size, name] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) { parts.push(below1000(Math.floor(n / size)) + ' ' + name); n %= size; }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(' ');
}

/** 1 to 99 as "first" ... "ninety-ninth". */
export function ordinalWords (n) {
  n = Math.floor(n);
  if (!(n >= 0 && n < 100)) return String(n);
  if (n < 20) return ORDINALS[n];
  return n % 10 ? TENS[Math.floor(n / 10)] + '-' + ORDINALS[n % 10] : ORDINAL_TENS[Math.floor(n / 10)];
}

/** The digits after a decimal point, one by one: "314" -> "three one four". */
const digitWords = s => s.split('').map(d => ONES[Number(d)]).join(' ');

const ROMAN_RE = /^X{0,3}(?:IX|IV|V?I{0,3})$/;
/** I to XXXIX as a number; 0 for anything else (larger numerals are left as they are written). */
export function romanValue (s) {
  if (!s || !ROMAN_RE.test(s)) return 0;
  const val = { I: 1, V: 5, X: 10 }; let n = 0;
  for (let i = 0; i < s.length; i++) { const a = val[s[i]]; const b = val[s[i + 1]] || 0; n += a < b ? -a : a; }
  return n;
}

const words = s => new Set(s.split(/\s+/).filter(Boolean));

// Capitalised words that open a sentence and are not names: after a single letter with a full
// stop, or a numeral, one of these means a new sentence has begun.
const STARTERS = words(`The A An This That These Those It Its He She They We You I His Her Their Our My In On At By For From With Without To Of And But Or Nor So Yet If
  When While As Because Since After Before Until Though Although Where Why How What Who Whom Which Whose Then Thus Here There Now One Two Three Four Five Another Other Others Some
  Many Most Several Each Every All Both Neither Either No Not Name Identify Give Answer During Despite Unlike Like Along According Such Also Later Earlier However Instead Still Once
  Upon Under Over Between Among Through Into Onto About Against Do Does Did Can Could Should Would Will May Might Must Is Are Was Were Have Has Had Ten Points First Second Third
  Finally Today Tonight Tomorrow Yesterday Sometimes Maybe Perhaps Only Even Just Any Much More Less Few Per Via Than Out Up Down Off Near Around Within Across Behind Beyond Besides
  Except Following Using Given Based Whether Shall Am Yes Oh Dear Lord Never Always Often Soon Next Again Hence Therefore Me Him Us Them Twenty Thirty`);

// Things that are numbered rather than people: "World War II" is "two" where "Louis XIV" is "the fourteenth".
const NUMBERED = words(`war act book part chapter volume vol title article amendment type phase class section episode scene canto stage grade level factor schedule vatican apollo saturn gemini
  titan atlas delta symphony sonata concerto quartet quintet trio opus number mark division group zone figure table appendix category tier season round bowl olympiad proposition
  photosystem complex collagen nerve angiotensin polymerase topoisomerase interferon prelude etude nocturne ballade impromptu scherzo partita suite cantata elegy ode satire eclogue
  epistle sermon meditation critique stanza psalm sura surah hymn tablet fragment papyrus codex folio plate panel wrestlemania fantasy rocky superman crusade coalition`);
// ... and the ones after which a lone "I" is the number one, never the pronoun: capitalised as headings are, or words of science.
const NUMBERED_ONE = words(`War Act Book Part Chapter Volume Vol Title Article Type Phase Class Section Episode Scene Canto Stage Photosystem Vatican Appendix Schedule Category Tier Figure Table Mark
  Division Group Grade Level photosystem topoisomerase polymerase angiotensin collagen interferon`);

// Given names that rulers and popes number: after one of these a Roman numeral is "the Nth".
const REGNAL = words(`Henry Edward George William Charles James Richard John Mary Elizabeth Anne Stephen Harold Edgar Edmund Alfred Ethelred Aethelred Canute Cnut Robert David Alexander Louis
  Philip Philippe Francis Francois Napoleon Clovis Pepin Lothair Otto Conrad Frederick Friedrich Wilhelm Rudolf Rudolph Maximilian Ferdinand Leopold Joseph Franz Karl Carlos Felipe
  Fernando Alfonso Alphonso Afonso Pedro Peter Juan Joao Manuel Sancho Isabella Isabel Joanna Juana Catherine Christina Gustav Gustavus Eric Erik Olaf Olav Haakon Harald Magnus
  Christian Margaret Margrethe Sigismund Casimir Wladyslaw Vladislaus Boleslaw Stanislaw Augustus Bela Andrew Ladislaus Matthias Wenceslaus Ivan Vasili Vasily Basil Nicholas Paul
  Mehmed Mehmet Murad Selim Suleiman Bayezid Osman Ahmed Mustafa Mahmud Abdulhamid Ismail Abbas Tahmasp Darius Xerxes Artaxerxes Cyrus Cambyses Shapur Khosrow Khosrau Kavad Bahram
  Yazdegerd Ptolemy Cleopatra Antiochus Seleucus Mithridates Ramesses Ramses Thutmose Amenhotep Seti Pepi Mentuhotep Senusret Psamtik Constantine Constantius Constans Theodosius
  Valentinian Justin Justinian Leo Michael Nikephoros Alexios Alexius Andronikos Romanos Baldwin Urban Innocent Clement Benedict Pius Gregory Boniface Sixtus Julius Adrian Celestine
  Honorius Martin Eugene Callixtus Victor Umberto Humbert Amadeus Emmanuel Menelik Tewodros Yohannes Rama Kamehameha Pomare Tupou Moctezuma Montezuma Chandragupta Pulakeshin Rajendra
  Jayavarman Suryavarman Sargon Shalmaneser Nebuchadnezzar Ashurnasirpal Abgar Herod Agrippa Oscar Albert Baudouin Willem Rainier Carol Zog Fuad Faisal Hassan Mohammed Muhammad
  Abdullah Hussein Mswati Letsie Moshoeshoe Sobhuza Demetrius Attalus Eumenes Perdiccas Amyntas Archelaus Cleomenes Leonidas Agis Agesilaus Hattusili Mursili Suppiluliuma Tudhaliya
  Ramiro Ordono Berengar Lothar Arnulf Childeric Chlothar Dagobert Theodoric Alaric Roger Bohemond Tancred Raymond Godfrey Fulk Amalric Hugh Odo Rupert Wenceslas Vladislav Ottokar
  Mieszko Kazimierz Zygmunt Jan Stefan Dmitri Dmitry Vsevolod Yaroslav Vladimir Sviatoslav Mstislav Igor Oleg Feodor Fyodor Boris Simeon Kaloyan Krum Tervel Orhan Ibrahim
  Abdulmejid Abdulaziz Nabonidus Ahmose Sneferu Sobekhotep Intef Shoshenq Osorkon Takelot Necho Nectanebo Selassie Iyasu Mutesa`);
const TITLE_BEFORE = /\b(?:King|Queen|Emperor|Empress|Pope|Antipope|Tsar|Czar|Tsarina|Sultan|Shah|Pharaoh|Prince|Princess|Duke|Duchess|Count|Earl|Kaiser|Caliph|Patriarch|Elector|Margrave|Archduke|Doge|Emir|Khan|Saint)(?:\s+[A-Z][A-Za-z'-]+){0,2}$/;
// After a lone "I": words that make it the pronoun ("the part I played") rather than a number.
const PRONOUN_VERB = /^\s+(?:am|was|have|had|will|would|can|could|should|shall|must|may|might|do|did|don't|didn't|like|liked|love|loved|want|wanted|need|needed|know|knew|think|thought|mean|meant|see|saw|use|used|prefer|hate|feel|felt|say|said|go|went|get|got|make|made|take|took|find|found|wish|hope|believe|suppose|guess|wonder|remember|recall|read|wrote|write|play|played|sing|sang|ever|never|always|just|really|also|still|once)\b/;

// Written abbreviations and what a reader says for them. Each is followed by a full stop in the text.
const BEFORE_NAME = { Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Dr: 'Doctor', Prof: 'Professor', St: 'Saint', Ste: 'Saint', Mt: 'Mount', Ft: 'Fort', Gen: 'General', Col: 'Colonel', Lt: 'Lieutenant', Sgt: 'Sergeant', Capt: 'Captain', Rev: 'Reverend', Gov: 'Governor', Sen: 'Senator', Rep: 'Representative', Pres: 'President' };
const BEFORE_NUMBER = { No: 'Number', Nos: 'Numbers', Op: 'Opus', Vol: 'Volume', vol: 'volume' };

// Letters the voice model has no character for, written with ones it has.
const FOLD = { 'ð': 'th', 'Ð': 'Th', 'þ': 'th', 'Þ': 'Th', 'æ': 'ae', 'Æ': 'Ae', 'œ': 'oe', 'Œ': 'Oe', 'ø': 'o', 'Ø': 'O', 'ß': 'ss', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H', 'ŋ': 'ng', 'Ŋ': 'Ng', 'ə': 'e', 'Ə': 'E', 'ʃ': 'sh', 'ʒ': 'zh', 'ɛ': 'e', 'ɔ': 'o', 'ɑ': 'a', 'ɪ': 'i', 'ʊ': 'u', 'ĸ': 'k', 'ŧ': 't', 'Ŧ': 'T', 'ŀ': 'l', 'ĳ': 'ij', 'Ĳ': 'IJ' };

/** True when the text that follows begins a new sentence: a capitalised word that opens sentences and is not a name. */
function sentenceFollows (rest) {
  const m = /^\s+["'(]?([A-Z][A-Za-z']*)/.exec(rest);
  return !!m && STARTERS.has(m[1]);
}

function characters (t) {
  t = t.replace(/[“”„‟″«»]/g, '"').replace(/[‘’‚‛′ʼʻʹʽʾʿ´`＇]/g, "'");
  t = t.replace(/[  -   　]/g, ' ').replace(/[​-‍﻿­]/g, '');
  // A true minus sign before a number ("−35.9 degrees" came out without it, or as a stray letter).
  t = t.replace(/−\s?(?=[\d.])/g, ' minus ').replace(/−/g, '-');
  t = t.replace(/\s*[—―]\s*/g, ', ').replace(/(\d)\s*[–‒]\s*(\d)/g, '$1 to $2').replace(/[–‒‐‑]/g, '-').replace(/…/g, '...');
  // "@" in an address is "at"; inside a word it stands for the letter ("Inter@ctive" came out as "Inter at C T V").
  t = t.replace(/@(?=[\w-]+\.[a-z]{2,})/gi, ' at ').replace(/([A-Za-z])@(?=[a-z])/g, '$1a').replace(/@/g, ' at ');
  t = t.replace(/[^\u0000-\u007F]/g, ch => FOLD[ch] !== undefined ? FOLD[ch] : ch);
  // Accented letters lose their accents: with them, "José Müller met Beyoncé in São Paulo" was garbled in every take.
  return t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function abbreviations (t) {
  // "Dr. Benway", "Mt. Fuji", "St. Basil": a title or a place word before a name ("Mt." was garbled, and each full stop was a halt).
  t = t.replace(/\b(Mrs|Mr|Ms|Dr|Prof|Ste|St|Mt|Ft|Gen|Col|Lt|Sgt|Capt|Rev|Gov|Sen|Rep|Pres)\.\s+(?=[A-Z])/g, (m, a) => BEFORE_NAME[a] + ' ');
  t = t.replace(/\b(Mrs|Mr|Ms|Dr|Prof)\.(?=\s+and\s+(?:Mister|Missus|Miz|Doctor|Professor)\b)/g, (m, a) => BEFORE_NAME[a]);
  // "No. 14", "Op. 27": before a number ("Sonata No. 14, Op. 27 No. 2" was garbled in every take).
  t = t.replace(/\b(Nos|No|Op|Vol|vol)\.\s*(?=\d)/g, (m, a) => BEFORE_NUMBER[a] + ' ');
  // "vs." came out as "viz" or "vez"; "Jr." as "here" or "dear".
  // (A lone "v." only between two names, as in "Plessy v. Ferguson": elsewhere it is a variable ending a sentence.)
  t = t.replace(/\bvs\.(?=\s)/g, 'versus').replace(/([A-Z][A-Za-z'.-]+ )v\.(?= ([A-Z][A-Za-z'-]*))/g, (m, before, next) => STARTERS.has(next) ? m : before + 'versus');
  t = t.replace(/,?(\s+)(Jr|Sr)\.(?=[\s,;:)']|$)/g, (m, gap, a, at, all) => gap + (a === 'Jr' ? 'Junior' : 'Senior') + (sentenceFollows(all.slice(at + m.length)) ? '.' : ''));
  t = t.replace(/\bPh\.\s?D\.?(?=[\s,;:)']|$)/g, (m, at, all) => 'PhD' + (m.endsWith('.') && sentenceFollows(all.slice(at + m.length)) ? '.' : ''));
  return t;
}

function romanNumerals (t) {
  // An oxidation state: "iron(III) oxide" is said "iron three oxide".
  t = t.replace(/([A-Za-z])\((I{1,3}|IV|VI{0,3}|V)\)/g, (m, a, r) => `${a} ${cardinalWords(romanValue(r))}`);
  // A numbered body: "the XVIII Dynasty", "II Corps".
  t = t.replace(/\b([IVX]{2,})(?:th|st|nd|rd)?(\s+)(Dynasty|dynasty|Corps|Legion|Army|Olympiad|Crusade|Century|century)\b/g, (m, r, gap, noun) => romanValue(r) ? `${ordinalWords(romanValue(r))}${gap}${noun}` : m);
  return t.replace(/\b([A-Za-z][A-Za-z'-]*)(\s+)([IVX]+)\b(?!\.[A-Za-z]|\s*\.\s+[A-Z]\.)/g, (m, head, gap, numeral, at, all) => {
    const n = romanValue(numeral);
    if (!n) return m;
    const before = all.slice(0, at);
    const after = all.slice(at + m.length);
    const word = head.replace(/'s$/, '');
    const capital = /^[A-Z]/.test(word);
    const lone = numeral.length === 1;
    if (NUMBERED.has(word.toLowerCase())) {
      if (numeral === 'I' && (!NUMBERED_ONE.has(word) || PRONOUN_VERB.test(after))) return m;
      return `${head}${gap}${cardinalWords(n)}`;
    }
    const person = capital && (REGNAL.has(word) || TITLE_BEFORE.test((before + word).trimEnd()));
    if (lone) {
      // "I", "V" and "X" are also a pronoun, an initial and a letter (Malcolm X): only after a ruler's name.
      if (!person) return m;
      if (numeral === 'I' && !/^(?:'s\b|\s*[,.;:)]|\s+of\b|\s+and\b|\s*$)/.test(after)) return m;
      // "John V. Atanasoff": with a full stop and a name after it, the letter may be an initial. Left as written.
      if (/^\.\s+[A-Z]/.test(after) && !sentenceFollows(after.slice(1))) return m;
      return `${head}${gap}the ${ordinalWords(n)}`;
    }
    if (!capital || STARTERS.has(word)) return m;
    if (person || /^(?:'s\b|\s+of\s+[A-Z])/.test(after)) return `${head}${gap}the ${ordinalWords(n)}`;
    return `${head}${gap}${cardinalWords(n)}`;
  });
}

function initials (t) {
  // Runs of initials before a name: "J. L. Austin", "W.E.B. Du Bois", "U.S. Senate". With the
  // full stops the voice halts after each letter; without them it reads the letters as well and
  // a tenth faster. (A run followed by a word that opens sentences is the end of one: left alone.)
  t = t.replace(/(^|[^A-Za-z0-9.])((?:[A-Z]\.\s?){2,})(?=([A-Z][A-Za-z'-]+))/g, (m, lead, run, next) => STARTERS.has(next) ? m : lead + run.replace(/[^A-Z]/g, '').split('').join(' ') + ' ');
  // One initial inside a name: "John F. Kennedy", "F. Scott Fitzgerald", "J. Alfred Prufrock",
  // "O. Henry's". The same shape ends a sentence ("... of actinium K. Reacting with ..."), so the
  // word after must not be one that opens sentences, and either the word before is a capitalised
  // name or the name goes on after it.
  t = t.replace(/(^|[^A-Za-z0-9.])((?:[A-Z][A-Za-z'-]+\s+)?)([A-Z])\.\s+(?=([A-Z][A-Za-z-]+)('s\b|\s+[A-Z][a-z])?)/g, (m, lead, before, letter, next, more) => {
    // (Not a lone "A": without its full stop "A. Philip Randolph" would begin with the word "a".
    // Nor "I", "V" or "X", which at the end of a name are numbers or part of it: "Malcolm X. Farrakhan ...".)
    if (STARTERS.has(next) || 'AIVX'.includes(letter)) return m;
    const first = before.trim();
    if (!(first && !STARTERS.has(first)) && !more) return m;
    return lead + before + letter + ' ';
  });
  return t;
}

function numbers (t) {
  const CURRENCY = { $: ['dollars', 'cents'], '£': ['pounds', 'pence'], '€': ['euros', 'cents'] };
  const whole = digits => digits.includes(',') ? cardinalWords(digits.replace(/,/g, '')) : digits;
  const decimal = (digits, frac) => `${whole(digits)} point ${digitWords(frac)}`;
  // "6,000", "20,000", "100,000", "2,000,000": one or two digits and then only noughts. The voice
  // reads these as they are written, and no better in words (15 sentences, three takes each), so
  // they are left alone.
  const plainRound = digits => /^[1-9]\d?0*(?:,000)+$/.test(digits);
  // Money written with separators or a decimal point: "$427,000" lost part of the number in one take of two.
  t = t.replace(/([$£€])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s?(?:hundred|thousand|million|billion|trillion)\b)?/g, (m, sign, digits, frac, scale) => {
    if ((!digits.includes(',') || plainRound(digits)) && frac === undefined) return m;
    const [unit, small] = CURRENCY[sign];
    if (frac !== undefined && frac.length === 2 && !scale && !digits.includes(',')) return `${digits} ${unit} and ${Number(frac)} ${small}`;
    return `${frac !== undefined ? decimal(digits, frac) : whole(digits)}${scale ? ' ' + scale.trim() : ''} ${unit}`;
  });
  // Thousands separators: "1,514 miles" came out as "one, five, fourteen miles" and took other words of the sentence with it.
  t = t.replace(/(^|[^\d.,$£€])(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?(?![\d,])/g, (m, lead, digits, frac) => frac === undefined && plainRound(digits) ? m : lead + (frac !== undefined ? decimal(digits, frac) : whole(digits)));
  // Decimals: cut at the full stop by the runtime, "19.9" was read "nineteen, nine" and "8.314" "eight, three, four, four".
  t = t.replace(/(^|[^\d.,A-Za-z])(\d+)\.(\d+)(?!\d|\.\d)/g, (m, lead, digits, frac) => lead + decimal(digits, frac));
  t = t.replace(/(^|[\s(])\.(\d+)(?!\d|\.\d)/g, (m, lead, frac) => `${lead}point ${digitWords(frac)}`);
  // A percent sign left on a word ("19 point nine%") was read as part of it ("nine-thenth").
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\s?%/g, '$1 percent');
  // A year with a nought in the tens: "1905" came out as "nineteen zero five", "nineteen through
  // five", "six hundred eight" for 1608 (14 sentences, three takes each: 15.7% of words not heard as written, 10.1% so).
  t = t.replace(/(^|[^\d.,$£€])(1[1-9])0([1-9])(?!\d|,\d{3}|%|\.\d|(?:st|nd|rd|th)\b)/g, (m, lead, century, unit) => `${lead}${below1000(Number(century))} oh ${ONES[Number(unit)]}`);
  return t;
}

function quotes (t) {
  // The runtime deletes the space before an apostrophe, gluing a phrase in 'single quotes' to the
  // word before it (the phrase was then lost in one take of three). It is given double quotes; a
  // lone leading apostrophe ('59, 'twixt) is dropped.
  t = t.replace(/(^|[\s(])'([^'"]{1,80}?)'(?=[\s.,;:!?)"]|$)/g, '$1"$2"');
  return t.replace(/(^|[\s("])'(?=[A-Za-z0-9])/g, '$1');
}

/**
 * Lines the written text up with its spoken form, so that a place in one can be found in the
 * other: the reader knows how far into the spoken form the voice is, and the screen, the power
 * mark and the buzz position are all counted in characters of the written text. Words that are
 * the same in both are matched in order; a rewritten stretch ("1,514" against "one thousand five
 * hundred fourteen") lies between two matches and is spread evenly.
 * @returns {number[][]|null} pairs [place in said, place in written], rising in both; null when the two are the same
 */
export function alignment (written, said) {
  if (written === said) return null;
  const tokens = s => { const out = []; const re = /\S+/g; let m; while ((m = re.exec(s)) !== null) out.push({ w: m[0], at: m.index, end: m.index + m[0].length }); return out; };
  const a = tokens(written); const b = tokens(said);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i].w === b[j].w ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [[0, 0]];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].w === b[j].w) { pairs.push([b[j].at, a[i].at], [b[j].end, a[i].end]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  pairs.push([said.length, written.length]);
  return pairs;
}

function across (pairs, pos, from, to) {
  if (!pairs) return pos;
  if (pos <= pairs[0][from]) return pairs[0][to];
  for (let k = 1; k < pairs.length; k++) {
    const p = pairs[k - 1]; const q = pairs[k];
    if (pos > q[from]) continue;
    const span = q[from] - p[from];
    return span > 0 ? p[to] + (pos - p[from]) * (q[to] - p[to]) / span : q[to];
  }
  return pairs[pairs.length - 1][to];
}
/** The place in the written text that goes with a place in the spoken form (both in characters). */
export const placeInWritten = (pairs, saidPos) => across(pairs, saidPos, 0, 1);
/** ... and the place in the spoken form that goes with a place in the written text. */
export const placeInSaid = (pairs, writtenPos) => across(pairs, writtenPos, 1, 0);

/** The steps of speakable(), in order, for the tools that measure each one's effect (tools/exp/say-confirm.cjs). */
export const STAGES = { characters, abbreviations, romanNumerals, initials, numbers, quotes };

/**
 * The text as it is handed to the voice model.
 * @param {string} text what is shown (already cleaned of pronunciation guides and power marks)
 * @returns {string}
 */
export function speakable (text) {
  let t = String(text == null ? '' : text);
  if (!t.trim()) return '';
  t = characters(t);
  t = abbreviations(t);
  t = romanNumerals(t);
  t = initials(t);
  t = numbers(t);
  t = quotes(t);
  // Whatever is still outside the model's alphabet becomes a space ("<" and ">" too: the runtime
  // marks the language with them; "/", "#", "[", "]", "_" and "|" it turns into spaces itself).
  t = t.replace(/[^A-Za-z0-9 !"$%&'()+,\-.:;?£€]/g, ' ');
  return t.replace(/\s+/g, ' ').replace(/ ([,;:!?]|\.(?!\d))/g, '$1').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}
