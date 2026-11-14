/**
 * Offline baseline runner. Usage (no network, no provider, no database):
 *   NODE_ENV=test node --require ./tests/pre-p2-routing/offline-network.cjs --import tsx \
 *     src/ai/brain/evaluation/run-baseline.ts <output.json>
 * NODE_ENV=test enables the server-side language boundary; without it the
 * language metric is reported NOT_EVALUATED. Writes only the given output path
 * and refuses to overwrite an existing file.
 */
import { writeFileSync } from 'node:fs';
import { runBaseline } from './baseline';

const out = process.argv[2];
if (!out) { console.error('usage: run-baseline.ts <output.json>'); process.exit(2); }
const muted = ['log', 'info', 'warn', 'debug'] as const, saved = muted.map(k => console[k]);
for (const k of muted) console[k] = () => {};
try {
  const report = await runBaseline();
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n', { flag: 'wx', mode: 0o644 });
} finally { muted.forEach((k, i) => { console[k] = saved[i]; }); }
console.log(`wrote ${out}`);
