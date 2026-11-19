// QBReader data source: category tree, difficulty labels, query building, and a buffered question feed.
// The category tree and difficulty labels mirror qbreader/website (shared/categories.js and
// client/scripts/components/DifficultyDropdown.jsx) as of November 2026.

export const API_BASE = 'https://www.qbreader.org/api';

export const CATEGORY_TREE = [
  { name: 'Literature', subs: ['American Literature', 'British Literature', 'Classical Literature', 'European Literature', 'World Literature', 'Other Literature'], alts: ['Drama', 'Long Fiction', 'Poetry', 'Short Fiction', 'Misc Literature'] },
  { name: 'History', subs: ['American History', 'Ancient History', 'European History', 'World History', 'Other History'], alts: [] },
  { name: 'Science', subs: ['Biology', 'Chemistry', 'Physics', 'Other Science'], alts: ['Math', 'Astronomy', 'Computer Science', 'Earth Science', 'Engineering', 'Misc Science'] },
  { name: 'Fine Arts', subs: ['Visual Fine Arts', 'Auditory Fine Arts', 'Other Fine Arts'], alts: ['Architecture', 'Dance', 'Film', 'Jazz', 'Musicals', 'Opera', 'Photography', 'Misc Arts'] },
  { name: 'Religion', subs: ['Religion'], alts: [] },
  { name: 'Mythology', subs: ['Mythology'], alts: [] },
  { name: 'Philosophy', subs: ['Philosophy'], alts: [] },
  { name: 'Social Science', subs: ['Social Science'], alts: ['Anthropology', 'Economics', 'Linguistics', 'Psychology', 'Sociology', 'Other Social Science'] },
  { name: 'Current Events', subs: ['Current Events'], alts: [] },
  { name: 'Geography', subs: ['Geography'], alts: [] },
  { name: 'Other Academic', subs: ['Other Academic'], alts: [] },
  { name: 'Pop Culture', subs: ['Movies', 'Music', 'Sports', 'Television', 'Video Games', 'Other Pop Culture'], alts: [] }
];

export const ALL_SUBCATEGORIES = CATEGORY_TREE.flatMap(c => c.subs);
export const ALL_ALTERNATES = CATEGORY_TREE.flatMap(c => c.alts);

// Which subcategories carry an alternate-subcategory tag ("Other Science" questions are tagged
// Math, Astronomy, Computer Science, ...; Biology questions are not tagged at all).
const ALT_HOME = { Literature: null, Science: ['Other Science'], 'Fine Arts': ['Other Fine Arts'], 'Social Science': ['Social Science'] };
const altHome = cat => ALT_HOME[cat.name] === null ? cat.subs : (ALT_HOME[cat.name] || []);

/**
 * Topics offered as one-tap switches on the main screen. Math and Computer Science are not
 * QBReader categories of their own: they are alternate subcategories of Science > Other Science.
 */
export const QUICK_TOPICS = [
  { key: 'philosophy', label: 'Philosophy', cat: 'Philosophy', sub: 'Philosophy' },
  { key: 'math', label: 'Math', cat: 'Science', sub: 'Other Science', alt: 'Math' },
  { key: 'cs', label: 'Computer Science', cat: 'Science', sub: 'Other Science', alt: 'Computer Science' }
];

export function topicOn (filters, topic) {
  return filters.subs.includes(topic.sub) && (!topic.alt || filters.alts.includes(topic.alt));
}

/** Switches a quick topic on or off; returns new filters and leaves the ones passed in alone. */
export function setTopic (filters, topic, on) {
  const f = { ...filters, subs: filters.subs.slice(), alts: filters.alts.slice() };
  const cat = CATEGORY_TREE.find(c => c.name === topic.cat);
  if (!topic.alt) {
    f.subs = on ? [...new Set([...f.subs, topic.sub])] : f.subs.filter(s => s !== topic.sub);
    return f;
  }
  const others = f.alts.filter(a => !cat.alts.includes(a));
  let mine = f.alts.filter(a => cat.alts.includes(a));
  if (on) {
    // Switching Math on must not also bring in astronomy and earth science.
    if (!f.subs.includes(topic.sub)) { f.subs.push(topic.sub); mine = [topic.alt]; } else mine = [...new Set([...mine, topic.alt])];
  } else {
    mine = mine.filter(a => a !== topic.alt);
    // Nothing left under this subcategory: drop it, and reset the narrowing for the next time it is ticked.
    if (!mine.length) { f.subs = f.subs.filter(s => s !== topic.sub); mine = cat.alts.slice(); }
  }
  f.alts = [...others, ...mine];
  return f;
}

export const DIFFICULTIES = [
  { value: 0, label: 'Pop Culture', short: 'Pop' },
  { value: 1, label: 'Middle School', short: 'MS' },
  { value: 2, label: 'Easy High School', short: 'Easy HS' },
  { value: 3, label: 'Regular High School', short: 'Regular HS' },
  { value: 4, label: 'Hard High School', short: 'Hard HS' },
  { value: 5, label: 'National High School', short: 'Nats HS' },
  { value: 6, label: 'Easy College', short: 'Easy College', dots: 1 },
  { value: 7, label: 'Medium College', short: 'Medium College', dots: 2 },
  { value: 8, label: 'Regionals College', short: 'Regionals', dots: 3 },
  { value: 9, label: 'Nationals College', short: 'Nationals', dots: 4 },
  { value: 10, label: 'Open', short: 'Open' }
];

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2026;

export function defaultFilters () {
  return {
    subs: ['Philosophy'],
    alts: ALL_ALTERNATES.slice(),
    difficulties: [7, 8, 9, 10],
    minYear: 2010,
    maxYear: MAX_YEAR
  };
}

/** Repairs a filters object loaded from storage so that it only holds known values. */
export function sanitizeFilters (f) {
  const d = defaultFilters();
  if (!f || typeof f !== 'object') return d;
  const arr = (v, allowed, fallback) => Array.isArray(v) ? v.filter(x => allowed.includes(x)) : fallback;
  const year = (v, fallback) => Number.isInteger(v) && v >= MIN_YEAR && v <= MAX_YEAR ? v : fallback;
  const out = {
    subs: arr(f.subs, ALL_SUBCATEGORIES, d.subs),
    alts: arr(f.alts, ALL_ALTERNATES, d.alts),
    difficulties: arr(f.difficulties, DIFFICULTIES.map(x => x.value), d.difficulties),
    minYear: year(f.minYear, d.minYear),
    maxYear: year(f.maxYear, d.maxYear)
  };
  if (out.minYear > out.maxYear) [out.minYear, out.maxYear] = [out.maxYear, out.minYear];
  return out;
}

/** Categories that have at least one selected subcategory. */
export function activeCategories (filters) {
  return CATEGORY_TREE.filter(c => c.subs.some(s => filters.subs.includes(s)));
}

/**
 * Builds the query string for /random-tossup or /random-bonus.
 * QBReader semantics: a category listed with none of its subcategories means "all of them", and the
 * alternate-subcategory filter always lets untagged questions through. isValidQuestion() applies the
 * stricter client-side rule that QBReader's own single-player page uses.
 */
export function buildParams (filters, number, extra = {}) {
  const cats = activeCategories(filters);
  const p = new URLSearchParams();
  // No difficulty ticked means "any difficulty", as on QBReader.
  if (filters.difficulties.length) p.set('difficulties', filters.difficulties.slice().sort((a, b) => a - b).join(','));
  p.set('categories', cats.map(c => c.name).join(','));
  p.set('subcategories', cats.flatMap(c => c.subs.filter(s => filters.subs.includes(s))).join(','));
  const alts = cats.flatMap(c => c.alts.filter(a => filters.alts.includes(a)));
  if (alts.length) p.set('alternateSubcategories', alts.join(','));
  p.set('minYear', String(filters.minYear));
  p.set('maxYear', String(filters.maxYear));
  p.set('number', String(number));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p;
}

/**
 * Mirrors CategoryManager.isValidCategory in qbreader/website, with one addition: when a category's
 * alternates have been narrowed (say, only Math), an "Other Science" question that carries no
 * alternate tag at all is turned away too, unless `allowUntagged` is set. QBReader lets those through.
 */
export function isValidQuestion (q, filters, { allowUntagged = false } = {}) {
  if (!q || typeof q !== 'object') return false;
  const cats = activeCategories(filters);
  const cat = cats.find(c => c.name === q.category);
  if (!cat) return false;
  if (cat.subs.length > 1 && !filters.subs.includes(q.subcategory)) return false;
  if (q.alternate_subcategory && !filters.alts.includes(q.alternate_subcategory)) return false;
  if (!q.alternate_subcategory && !allowUntagged && isUntaggedInNarrowed(q, filters)) return false;
  if (filters.difficulties.length && !filters.difficulties.includes(q.difficulty)) return false;
  return true;
}

/** True for a question with no alternate tag in a subcategory whose alternates the listener has narrowed. */
export function isUntaggedInNarrowed (q, filters) {
  if (!q || q.alternate_subcategory) return false;
  const cat = CATEGORY_TREE.find(c => c.name === q.category);
  if (!cat || !cat.alts.length || !altHome(cat).includes(q.subcategory)) return false;
  const chosen = cat.alts.filter(a => filters.alts.includes(a)).length;
  return chosen > 0 && chosen < cat.alts.length;
}

export function filterSignature (filters) {
  return JSON.stringify([
    filters.subs.slice().sort(), filters.alts.slice().sort(),
    filters.difficulties.slice().sort((a, b) => a - b), filters.minYear, filters.maxYear
  ]);
}

function isUsableTossup (t) {
  return !!(t && t._id && typeof t.question_sanitized === 'string' && t.question_sanitized.trim() &&
    typeof t.answer_sanitized === 'string' && t.answer_sanitized.trim());
}
function isUsableBonus (b) {
  return !!(b && b._id && Array.isArray(b.parts_sanitized) && b.parts_sanitized.length > 0 &&
    Array.isArray(b.answers_sanitized) && b.answers_sanitized.length === b.parts_sanitized.length &&
    b.parts_sanitized.every(p => typeof p === 'string' && p.trim()) &&
    b.answers_sanitized.every(a => typeof a === 'string' && a.trim()));
}

/**
 * One question by its id, as QBReader holds it now. Review uses it to show a question kept before
 * its printed text was stored. Resolves to null when QBReader no longer has it (or the id is not
 * one of QBReader's); rejects when the service cannot be reached.
 */
export async function fetchQuestionById (type, id, fetchImpl) {
  if (!/^[0-9a-f]{24}$/i.test(String(id || ''))) return null;
  const kind = type === 'bonus' ? 'bonus' : 'tossup';
  const res = await (fetchImpl || ((...a) => fetch(...a)))(`${API_BASE}/${kind}-by-id?id=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`QBReader answered HTTP ${res.status}`);
  const data = await res.json();
  return (data && data[kind]) || null;
}

export class NoQuestionsError extends Error {
  constructor (type) { super(`No ${type}s match the current categories and difficulties.`); this.name = 'NoQuestionsError'; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Buffered, de-duplicated feed of random questions. Keeps a small buffer per type (also persisted)
 * so that a short loss of signal on the road does not stall the quiz.
 */
export class QuestionFeed {
  /**
   * @param {object} o
   * @param {typeof fetch} [o.fetchImpl]
   * @param {{get: Function, set: Function}} [o.store] persistent key/value store (JSON values)
   * @param {number} [o.batch] questions per request
   * @param {number} [o.low] refill when a buffer drops below this
   * @param {(msg: string, data?: object) => void} [o.log]
   */
  constructor ({ fetchImpl, store, batch = 10, low = 4, log, threePartOnly = true } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.store = store || { get: (k, d) => d, set: () => {} };
    this.batch = batch;
    this.low = low;
    this.log = log || (() => {});
    this.threePartOnly = threePartOnly;
    this.filters = defaultFilters();
    this.sig = filterSignature(this.filters);
    this.buffers = { tossup: [], bonus: [] };
    this.inflight = { tossup: null, bonus: null };
    this.seen = new Set(this.store.get('seen', []));
    const saved = this.store.get('buffer', null);
    if (saved && saved.sig && saved.buffers) { this._savedSig = saved.sig; this._savedBuffers = saved.buffers; }
  }

  setFilters (filters) {
    this.filters = sanitizeFilters(filters);
    const sig = filterSignature(this.filters);
    if (sig === this.sig && !this._savedBuffers) return;
    this.sig = sig;
    this.buffers = { tossup: [], bonus: [] };
    this.allowUntagged = false; this._untaggedRounds = 0;
    this.gen = (this.gen || 0) + 1; // invalidates in-flight fetches made for older filters
    this.inflight = { tossup: null, bonus: null };
    if (this._savedBuffers && this._savedSig === sig) {
      for (const type of ['tossup', 'bonus']) {
        const usable = type === 'tossup' ? isUsableTossup : isUsableBonus;
        this.buffers[type] = (this._savedBuffers[type] || []).filter(q => usable(q) && !this.seen.has(q._id));
      }
    }
    this._savedBuffers = null;
    this._persist();
  }

  buffered (type) { return this.buffers[type].length; }

  _persist () {
    this.store.set('buffer', { sig: this.sig, buffers: this.buffers });
  }

  _markSeen (id) {
    this.seen.add(id);
    if (this.seen.size > 4000) this.seen = new Set([...this.seen].slice(-3000));
    this.store.set('seen', [...this.seen]);
  }

  async _fetchBatch (type) {
    const gen = this.gen;
    const extra = type === 'bonus' && this.threePartOnly ? { threePartBonuses: true } : {};
    const url = `${API_BASE}/random-${type}?${buildParams(this.filters, this.batch, extra)}`;
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new NoQuestionsError(type);
    if (!res.ok) throw new Error(`QBReader answered HTTP ${res.status}`);
    const data = await res.json();
    const list = (type === 'tossup' ? data.tossups : data.bonuses) || [];
    if (gen !== this.gen) return 0; // filters changed while the request was in flight
    const usable = type === 'tossup' ? isUsableTossup : isUsableBonus;
    const have = new Set(this.buffers[type].map(q => q._id));
    let added = 0; let repeats = 0; let untagged = 0;
    const valid = q => isValidQuestion(q, this.filters, { allowUntagged: this.allowUntagged });
    for (const q of list) {
      if (!usable(q) || have.has(q._id)) continue;
      if (!valid(q)) { if (isUntaggedInNarrowed(q, this.filters)) untagged++; continue; }
      if (this.seen.has(q._id)) { repeats++; continue; }
      have.add(q._id);
      this.buffers[type].push({ ...q, type });
      added++;
    }
    // A narrowed topic (only Math, say) whose questions mostly carry no tag would starve the quiz:
    // after two rounds with nothing but untagged questions, take those as well.
    if (added === 0 && untagged > 0 && !this.allowUntagged) {
      this._untaggedRounds = (this._untaggedRounds || 0) + 1;
      if (this._untaggedRounds >= 2) {
        this.allowUntagged = true;
        this.log('feed: tagged questions ran short, also taking untagged ones', { type });
        for (const q of list) { if (usable(q) && valid(q) && !have.has(q._id) && !this.seen.has(q._id)) { have.add(q._id); this.buffers[type].push({ ...q, type }); added++; } }
      }
    } else if (added > 0) this._untaggedRounds = 0;
    // Everything valid was already heard: the pool is exhausted, so start over rather than stall.
    if (added === 0 && repeats > 0) {
      this._exhausted = (this._exhausted || 0) + 1;
      if (this._exhausted >= 2) {
        this.log('feed: pool exhausted, allowing repeats', { type });
        this.seen.clear(); this._exhausted = 0;
        for (const q of list) {
          if (usable(q) && valid(q) && !have.has(q._id)) { have.add(q._id); this.buffers[type].push({ ...q, type }); added++; }
        }
      }
    } else if (added > 0) this._exhausted = 0;
    this._persist();
    return added;
  }

  /** Starts a background refill if the buffer is low. Never throws. */
  prefetch (type) {
    if (this.buffers[type].length >= this.low || this.inflight[type]) return this.inflight[type] || Promise.resolve();
    const p = this._fetchBatch(type)
      .catch(err => { this.log('feed: prefetch failed', { type, error: String(err && err.message || err) }); })
      .finally(() => { if (this.inflight[type] === p) this.inflight[type] = null; });
    this.inflight[type] = p;
    return p;
  }

  /**
   * Returns the next question of the given type, fetching when the buffer is empty.
   * Retries on network errors (calling onWaiting once so the app can say it is waiting);
   * throws NoQuestionsError when the filters match nothing.
   */
  async next (type, { onWaiting, signal, maxAttempts = Infinity } = {}) {
    let attempt = 0; let emptyRounds = 0; let told = false;
    while (this.buffers[type].length === 0) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      attempt++;
      try {
        const added = await this._fetchBatch(type);
        if (added === 0) {
          emptyRounds++;
          if (emptyRounds >= 4) throw new NoQuestionsError(type);
        }
      } catch (err) {
        if (err instanceof NoQuestionsError) throw err;
        this.log('feed: fetch failed', { type, attempt, error: String(err && err.message || err) });
        if (attempt >= maxAttempts) throw err;
        if (!told && onWaiting) { told = true; onWaiting(err); }
        await sleep(Math.min(8000, 800 * 2 ** Math.min(attempt - 1, 4)));
      }
    }
    const q = this.buffers[type].shift();
    this._markSeen(q._id);
    this._persist();
    this.prefetch(type);
    return q;
  }
}
