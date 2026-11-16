// What the app makes of something said. Usage: node tools/exp/intent-one.mjs "phrase" ["phrase" ...]
import { classifyCommand, classifyBuzz, splitWake, looksLikeQuestion, isCommandLead, ALL_COMMANDS } from '../../docs/js/intent.js';

for (const s of process.argv.slice(2)) {
  const each = ALL_COMMANDS.filter(c => classifyCommand(s, [c]));
  console.log(JSON.stringify(s), '-> command:', classifyCommand(s, ALL_COMMANDS), '| every match:', each.join(',') || '-', '| wake:', JSON.stringify(splitWake(s)), '| question-like:', looksLikeQuestion(s), '| lead:', isCommandLead(s), '| buzz (normal, 0.5 s):', classifyBuzz({ text: s, dur: 0.5 }, 'normal').buzz);
}
