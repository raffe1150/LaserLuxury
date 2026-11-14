import { writeFileSync } from 'node:fs';
import { compare } from './compare';

const out = process.argv[2];
if (!out) throw new Error('usage: run-comparison.ts <new-output.json>');
const muted = ['log', 'info', 'warn', 'debug'] as const;
const original = muted.map(k => console[k]);
try {
  for (const k of muted) console[k] = () => {};
  const report = await compare();
  // One line per case/recording for diffing without repeating nested indent.
  const fields = Object.entries(report).map(([key, value]) => {
    const body = Array.isArray(value) ? '[\n' + value.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n ]'
      : JSON.stringify(value, null, 1);
    return ' ' + JSON.stringify(key) + ': ' + body;
  });
  writeFileSync(out, '{\n' + fields.join(',\n') + '\n}\n', { flag: 'wx' });
} finally {
  muted.forEach((k, i) => { console[k] = original[i]; });
}
