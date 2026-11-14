/** Offline manifest generator. Writes only the chosen new artifact. */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateSemantics } from '../src/ai/brain/phase5/semantic-eval';
import { INTERPRETATION_INSTRUCTION } from '../src/ai/brain/semantic/model-adapter';
import { HELD_OUT } from '../src/ai/brain/phase4/held-out';

const path = process.argv[2];
if (!path) throw new Error('NEW_OUTPUT_PATH_REQUIRED');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const { rows } = await evaluateSemantics();
const manifest = {
  version: 1, model: 'gpt-6.1-sol', inputLimit: 16000, outputLimit: 1600,
  requestCount: 18, instructionSha256: sha(INTERPRETATION_INSTRUCTION),
  turns: rows.map(row => {
    const item = HELD_OUT.find(s => s.language === row.language)?.turns[row.turn - 1];
    const turn = { id: row.language + ':' + row.turn, language: row.language, turn: row.turn,
      text: row.text, switchTo: item && 'switchTo' in item ? item.switchTo : null, expected: row.expected };
    return { ...turn, sha256: sha(JSON.stringify(turn)) };
  }),
};
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
