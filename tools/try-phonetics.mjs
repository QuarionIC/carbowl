// Development aid: prints sound-alike scores for (answer, heard) pairs.
// Usage: node tools/try-phonetics.mjs
import { soundKeys, soundSimilarity } from '../docs/js/phonetics.js';

const SHOULD_MATCH = [
  ['Kierkegaard', 'kirk a guard'], ['Kierkegaard', 'kirkegard'], ['Kierkegaard', 'keer kuh gard'], ['Kant', "can't"], ['Kant', 'cant'],
  ['Nietzsche', 'neecha'], ['Nietzsche', 'niche'], ['Nietzsche', 'nee chuh'], ['Wittgenstein', 'vicken stein'], ['Wittgenstein', 'vit gen stine'],
  ['Wittgenstein', 'wit and stein'], ['Hume', 'whom'], ['Hume', 'hume'], ['Locke', 'lock'], ['Rawls', 'rolls'], ['Peirce', 'purse'],
  ['Quine', 'kwine'], ['Quine', 'coin'], ['Kripke', 'crip key'], ['Parfit', 'par fit'], ['Ayer', 'air'], ['Frege', 'fray guh'], ['Frege', 'freya'],
  ['Hegel', 'hey gull'], ['Hegel', 'hagel'], ['Husserl', 'who sell'], ['Husserl', 'hoosier all'], ['Heidegger', 'hi digger'], ['Leibniz', 'libe nits'],
  ['Leibniz', 'lime nits'], ['Spinoza', 'spin oza'], ['Descartes', 'day cart'], ['Descartes', 'de cart'], ['Foucault', 'foo co'], ['Foucault', 'fuko'],
  ['Rousseau', 'roo so'], ['Rousseau', 'russo'], ['Camus', 'ka moo'], ['Camus', 'come moo'], ['Sartre', 'sart'], ['Sartre', 'sartra'], ['Derrida', 'dairy da'],
  ['Beauvoir', 'bo vwar'], ['Beauvoir', 'bove war'], ['Baudrillard', 'boh dree yard'], ['Schopenhauer', 'show pen hour'], ['Schopenhauer', 'shopping hour'],
  ['Epicurus', 'epic cure us'], ['Averroes', 'a vero ease'], ['Avicenna', 'of a senna'], ['Maimonides', 'my monadies'], ['Zhuangzi', 'chuang tzu'],
  ['Zhuangzi', 'jwong zuh'], ['Laozi', 'lao tzu'], ['Mozi', 'mo tzu'], ['Arendt', "aren't"], ['Arendt', 'a rent'], ['Anscombe', 'anns comb'],
  ['Montaigne', 'mon tane'], ['Enquiry', 'inquiry'], ['Tractatus', 'track tatas'], ['Philosophicus', 'philosophic us'], ['Dasein', 'dah zine'],
  ['Dasein', 'design'], ['Leviathan', 'levi athan'], ['Zarathustra', 'zara thustra'], ['Thus Spoke Zarathustra', 'the spoke sarah thustra'],
  ['Being and Nothingness', 'being a nothingness'], ['Being and Time', 'being in time'], ['categorical imperative', 'categorical imperatives'],
  ['Plotinus', 'plot highness'], ['Diogenes', 'die ah jen ease'], ['Heraclitus', 'hair a cly tus'], ['Parmenides', 'par men a dees'],
  ['Thales', 'tay lees'], ['Thales', 'they lease'], ['Xunzi', 'shun zee'], ['Mencius', 'men she us'], ['Nagarjuna', 'naga june a'],
  ['Adorno', 'a door no'], ['Habermas', 'harbor mass'], ['Gadamer', 'gotta mer'], ['Lacan', 'la con'], ['Deleuze', 'the lose'], ['Althusser', 'all two sair'],
  ['Saussure', 'so sir'], ['Levinas', 'levy nas'], ['Merleau-Ponty', 'merlot ponty'], ['Feuerbach', 'foyer bock'], ['Fichte', 'fick tuh'],
  ['Schelling', 'shelling'], ['Carnap', 'car nap'], ['Popper', 'popper'], ['Kuhn', 'coon'], ['Feyerabend', 'fire ah bend'], ['Lakatos', 'lock a tosh'],
  ['Gettier', 'get ear'], ['Gettier', 'getty a'], ['Putnam', 'put numb'], ['Searle', 'surl'], ['Searle', 'sural'], ['Nozick', 'no zick'], ['Singer', 'singer'],
  ['Mill', 'mil'], ['Bentham', 'ben thumb'], ['Hobbes', 'hobs'], ['Berkeley', 'barkley'], ['Aquinas', 'a kwine us'], ['Augustine', 'a gusteen'],
  ['Anselm', 'ann selm'], ['Boethius', 'bow eighth e us'], ['Abelard', 'abba lard'], ['Ockham', 'awk um'], ['Duns Scotus', 'dunce coat us'],
  ['Machiavelli', 'mackie a valley'], ['Montesquieu', 'mon tes cue'], ['Voltaire', 'vol tear'], ['Diderot', 'deed row'], ['Pascal', 'pass cal'],
  ['Ibn Rushd', 'even rushed'], ['al-Ghazali', 'all gazali'], ['Ibn Sina', 'ibn cena'], ['Confucius', 'confucious'], ['utilitarianism', 'utilitarian ism']
];
const SHOULD_NOT_MATCH = [
  ['Kant', 'Comte'], ['Kant', 'Hegel'], ['Hume', 'Hegel'], ['Schopenhauer', 'Spinoza'], ['Locke', 'Lacan'], ['Marx', 'Mach'], ['Mill', 'Marx'],
  ['Hegel', 'Heidegger'], ['Husserl', 'Hegel'], ['Sartre', 'Socrates'], ['Plato', 'Plotinus'], ['Aristotle', 'Aristippus'], ['Hobbes', 'Hume'],
  ['Kierkegaard', 'Kant'], ['Nietzsche', 'Nozick'], ['Descartes', 'Derrida'], ['Leibniz', 'Locke'], ['Rawls', 'Russell'], ['Quine', 'Kant'],
  ['Wittgenstein', 'Weber'], ['Berkeley', 'Bentham'], ['Foucault', 'Fichte'], ['Rousseau', 'Russell'], ['Popper', 'Putnam'], ['Camus', 'Kant'],
  ['Epicurus', 'Epictetus'], ['Zeno', 'Xenophon'], ['Laozi', 'Mozi'], ['Mencius', 'Mozi'], ['Augustine', 'Aquinas'], ['Anselm', 'Abelard'],
  ['Critique of Pure Reason', 'Critique of Judgment'], ['Being and Time', 'Being and Nothingness'], ['utilitarianism', 'existentialism'],
  ['Kant', "i don't know"], ['Hume', 'him'], ['Hume', 'home'], ['Mill', 'will'], ['Locke', 'look'], ['Ayer', 'are'], ['Kuhn', 'can'], ['Kant', 'count'],
  ['Plato', 'play'], ['Marx', 'marks'], ['Rawls', 'rules'], ['Peirce', 'peace'], ['Frege', 'fridge']
];

const TH = Number(process.argv[2]) || 0.8;
let miss = 0; let falseHit = 0;
const row = ([a, b]) => { const r = soundSimilarity(a, b); return `${r.score.toFixed(2)}  ${a} [${soundKeys(a).join('|')}]  ~  ${b} [${soundKeys(b).join('|')}]`; };
console.log(`--- should match (threshold ${TH}) ---`);
for (const p of SHOULD_MATCH) { const s = soundSimilarity(p[0], p[1]).score; if (s < TH) { miss++; console.log('MISS  ' + row(p)); } }
console.log(`misses: ${miss} / ${SHOULD_MATCH.length}`);
console.log('--- should not match ---');
for (const p of SHOULD_NOT_MATCH) { const s = soundSimilarity(p[0], p[1]).score; if (s >= TH) { falseHit++; console.log('FALSE ' + row(p)); } }
console.log(`false matches: ${falseHit} / ${SHOULD_NOT_MATCH.length}`);
if (process.argv.includes('--all')) { console.log('--- all ---'); for (const p of [...SHOULD_MATCH, ...SHOULD_NOT_MATCH]) console.log(row(p)); }
