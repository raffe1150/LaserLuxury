import { writeFileSync } from 'node:fs';
import { phase4Report } from './report';

const output = process.argv[2];
if (!output) throw new Error('usage: run-report.ts <new-output.json>');
const result = await phase4Report();
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
