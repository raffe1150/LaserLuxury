import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

const oldPolicy =
  'Your response for each message MUST be concise and strictly limited to a maximum of 60 words.';

const newPolicy =
  'Aim for 20–35 words and 1–2 sentences. Never exceed 45 words unless more words are strictly necessary to communicate required booking, safety, policy, or error information. Ask at most one question. Do not repeat introductions, business descriptions, previous information, or promotional CTAs unless needed.';

assert.equal(
  source.split(oldPolicy).length - 1,
  0,
  'legacy 60-word response policy must be removed'
);

assert.equal(
  source.split(newPolicy).length - 1,
  5,
  'all five Gemini channel paths must use the 45-word response policy'
);

console.log('Response concision policy regressions passed');
