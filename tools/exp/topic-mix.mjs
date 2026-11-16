// What the quick topics produce when asked of the live QBReader API: the mix of categories that
// comes back, and how many of those questions the app would keep.
// Usage: node tools/exp/topic-mix.mjs philosophy,math,cs [rounds]
import { defaultFilters, QUICK_TOPICS, setTopic, topicOn, buildParams, isValidQuestion, API_BASE } from '../../docs/js/qb.js';

const want = (process.argv[2] || 'philosophy,math,cs').split(',');
const rounds = Number(process.argv[3] || 3);
let f = defaultFilters();
for (const t of QUICK_TOPICS) f = setTopic(f, t, want.includes(t.key));
console.log('topics on:', QUICK_TOPICS.filter(t => topicOn(f, t)).map(t => t.label).join(', '));
console.log('subs:', f.subs.join(', '), '| science alternates:', f.alts.filter(a => ['Math', 'Astronomy', 'Computer Science', 'Earth Science', 'Engineering', 'Misc Science'].includes(a)).join(', '));

for (const kind of ['tossup', 'bonus']) {
  const tally = {}; let got = 0; let kept = 0;
  const params = buildParams(f, 20, kind === 'bonus' ? { threePartBonuses: true } : {});
  if (kind === 'tossup') console.log('query:', decodeURIComponent(params.toString()));
  for (let i = 0; i < rounds; i++) {
    const res = await fetch(`${API_BASE}/random-${kind}?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) { console.log(kind, 'HTTP', res.status); break; }
    const data = await res.json();
    for (const q of (kind === 'tossup' ? data.tossups : data.bonuses) || []) {
      got++;
      const label = q.alternate_subcategory || q.subcategory || q.category;
      tally[label] = (tally[label] || 0) + 1;
      if (isValidQuestion(q, f)) kept++;
    }
  }
  console.log(`${kind}s: ${got} returned, ${kept} kept;`, tally);
}
