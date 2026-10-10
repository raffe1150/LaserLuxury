import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(
  new URL('./KnowledgePanel.tsx', import.meta.url),
  'utf8',
);

const api = readFileSync(
  new URL('../../services/api.ts', import.meta.url),
  'utf8',
);

const navigation = readFileSync(
  new URL('./dashboard-navigation.ts', import.meta.url),
  'utf8',
);

const dashboard = readFileSync(
  new URL('../../pages/dashboard.tsx', import.meta.url),
  'utf8',
);

assert.match(
  navigation,
  /case 'ai-tone': case 'knowledge': case 'prompt-editor':/,
);

assert.match(
  dashboard,
  /<KnowledgePanel[\s\S]*?businessId=\{selectedBusiness\.id\}[\s\S]*?onSaved=\{handleSaved\}/,
);

assert.match(
  panel,
  /api\.getKnowledgeSources\(businessId\)/,
);

assert.match(
  panel,
  /api\.createKnowledgeSource\(\s*businessId,[\s\S]*?title:\s*normalizedTitle,[\s\S]*?content:\s*normalizedContent/,
);

assert.match(
  panel,
  /api\.deleteKnowledgeSource\(businessId,\s*source\.id\)/,
);

assert.match(
  panel,
  /setSources\(\(current\)\s*=>\s*\[created,\s*\.\.\.current\]\)/,
);

assert.match(
  panel,
  /current\.filter\(\(item\)\s*=>\s*item\.id\s*!==\s*source\.id\)/,
);

assert.match(
  api,
  /getKnowledgeSources:[\s\S]*?\/api\/businesses\/\$\{encodeURIComponent\(businessId\)\}\/knowledge/,
);

assert.match(
  api,
  /createKnowledgeSource:[\s\S]*?method:\s*'POST'/,
);

assert.match(
  api,
  /deleteKnowledgeSource:[\s\S]*?method:\s*'DELETE'/,
);

assert.match(panel,/Business answers/);
assert.match(panel,/Add information OdinLink can use when answering customer questions/);
assert.match(panel,/window\.confirm/);
assert.match(panel,/if \(active\) setSources\(result\)/);
assert.doesNotMatch(panel,/systemPrompt|updateBusiness/);
assert.match(dashboard,/businessAnswers=\{<KnowledgePanel/);
console.log('Knowledge dashboard wiring tests passed.');

assert.match(panel, /t\('Delete "\{title\}" from Knowledge\?'\)\.replace\('\{title\}', \(\) => source\.title\)/, 'native confirmation translates only UI; source title remains verbatim');
assert.doesNotMatch(panel, /`Delete "\$\{source\.title\}" from Knowledge\?`/, 'confirmation is no longer a hardcoded English template');
