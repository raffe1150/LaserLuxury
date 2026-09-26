import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chunkKnowledgeContent,
  InMemoryKnowledgeStorage,
  KnowledgeService,
  SupabaseKnowledgeStorage,
  type KnowledgeStorage,
} from './knowledge';

test('knowledge search is strictly tenant scoped and only returns ready sources', async () => {
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage, storage);

  await service.addSource({
    businessId: 1,
    type: 'text',
    title: 'Business A laser',
    content: 'Laser treatment takes 45 minutes.',
    status: 'ready',
  });

  await service.addSource({
    businessId: 2,
    type: 'text',
    title: 'Business B laser',
    content: 'Laser treatment takes 90 minutes.',
    status: 'ready',
  });

  await service.addSource({
    businessId: 1,
    type: 'text',
    title: 'Pending source',
    content: 'Laser treatment takes 10 minutes.',
    status: 'pending',
  });

  await service.addSource({
    businessId: 1,
    type: 'text',
    title: 'Disabled source',
    content: 'Laser treatment takes 20 minutes.',
    status: 'disabled',
  });

  const matches = await service.search(1, 'laser treatment');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].businessId, 1);
  assert.match(matches[0].text || '', /45 minutes/);
  assert.doesNotMatch(matches[0].text || '', /90|10|20 minutes/);
});

test('multilingual in-memory retrieval works across OdinLink languages', async () => {
  const storage = new InMemoryKnowledgeStorage();
  const service = new KnowledgeService(storage, storage);

  const cases = [
    ['en', 'Laser hair removal costs 990 SEK', 'laser hair'],
    ['sv', 'Laserhårborttagning kostar 990 kronor', 'laserhårborttagning'],
    ['de', 'Laser Haarentfernung kostet 990 Euro', 'haarentfernung'],
    ['es', 'La depilación láser cuesta 990 coronas', 'depilación láser'],
    ['fa', 'لیزر موهای زائد ۹۹۰ کرون هزینه دارد', 'لیزر موهای زائد'],
    ['ar', 'إزالة الشعر بالليزر تكلف 990 كرونة', 'إزالة الشعر بالليزر'],
  ] as const;

  let index = 0;

  for (const [language, content] of cases) {
    index += 1;
    await service.addSource({
      businessId: 10,
      type: 'text',
      title: `knowledge-${language}-${index}`,
      content,
      status: 'ready',
      metadata: { language },
    });
  }

  for (const [language, , query] of cases) {
    const matches = await service.search(10, query);
    assert.ok(matches.length > 0, `${language} should return a match`);
    assert.equal(matches[0].businessId, 10);
  }
});

test('invalid business id fails closed without calling storage search', async () => {
  let searchCalls = 0;

  const storage: KnowledgeStorage = {
    async initialize() {},
    async list() { return []; },
    async create(source) { return source; },
    async delete() { return false; },
    async search() {
      searchCalls += 1;
      return [];
    },
  };

  const service = new KnowledgeService(storage, storage);

  assert.deepEqual(await service.search(0, 'laser'), []);
  assert.deepEqual(await service.search(-1, 'laser'), []);
  assert.deepEqual(await service.search(Number.NaN, 'laser'), []);
  assert.deepEqual(await service.search(1, '   '), []);

  assert.equal(searchCalls, 0);
});

test('Supabase search sends tenant id and clamps limit to ten', async () => {
  const rpcCalls: Array<{ name: string; args: any }> = [];

  const client = {
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });

      return {
        data: [{
          source_id: '11111111-1111-1111-1111-111111111111',
          business_id: 42,
          chunk_index: 0,
          content: 'Laser treatment takes 45 minutes.',
          metadata: { language: 'en' },
          score: 0.75,
        }],
        error: null,
      };
    },
  };

  const storage = new SupabaseKnowledgeStorage(client);
  const matches = await storage.search(42, 'laser duration', 999);

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'search_knowledge_chunks');
  assert.deepEqual(rpcCalls[0].args, {
    p_business_id: 42,
    p_query: 'laser duration',
    p_limit: 10,
  });

  assert.deepEqual(matches, [{
    sourceId: '11111111-1111-1111-1111-111111111111',
    businessId: 42,
    score: 0.75,
    text: 'Laser treatment takes 45 minutes.',
    metadata: { language: 'en' },
  }]);
});

test('Supabase search rejects invalid tenant id before RPC', async () => {
  let rpcCalls = 0;

  const client = {
    rpc: async () => {
      rpcCalls += 1;
      return { data: [], error: null };
    },
  };

  const storage = new SupabaseKnowledgeStorage(client);

  assert.deepEqual(await storage.search(0, 'laser'), []);
  assert.deepEqual(await storage.search(-10, 'laser'), []);
  assert.deepEqual(await storage.search(Number.NaN, 'laser'), []);

  assert.equal(rpcCalls, 0);
});

test('chunkKnowledgeContent is deterministic and preserves bounded chunk order', () => {
  const input = [
    'A'.repeat(260),
    'B'.repeat(260),
    'C'.repeat(260),
  ].join('\n\n');

  const first = chunkKnowledgeContent(input, 500);
  const second = chunkKnowledgeContent(input, 500);

  assert.deepEqual(first, second);
  assert.equal(first.length, 3);

  for (let index = 0; index < first.length; index += 1) {
    assert.equal(first[index].chunkIndex, index);
    assert.ok(first[index].content.length > 0);
    assert.ok(first[index].content.length <= 500);
  }
});

test('in-memory replaceChunks rejects cross-tenant source ownership', async () => {
  const storage = new InMemoryKnowledgeStorage();
  await storage.initialize();

  const now = new Date().toISOString();

  const source = {
    id: crypto.randomUUID(),
    businessId: 100,
    type: 'text' as const,
    title: 'Tenant 100 source',
    status: 'ready' as const,
    content: 'Tenant-safe content',
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };

  await storage.create(source);

  await assert.rejects(
    () =>
      storage.replaceChunks(
        200,
        source.id,
        [{
          chunkIndex: 0,
          content: 'This must never cross tenant scope.',
          metadata: {},
        }],
      ),
    /does not belong to this business/i,
  );
});

test('Supabase replaceChunks uses one atomic RPC with scoped normalized payload', async () => {
  const rpcCalls: any[] = [];

  const client = {
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
  };

  const storage = new SupabaseKnowledgeStorage(client);

  const sourceId = crypto.randomUUID();

  await storage.replaceChunks(
    77,
    sourceId,
    [
      {
        chunkIndex: 0,
        content: '  First chunk  ',
        metadata: { origin: 'manual' },
      },
      {
        chunkIndex: 1,
        content: 'Second chunk',
      },
    ],
  );

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'replace_knowledge_chunks');
  assert.deepEqual(rpcCalls[0].args, {
    p_business_id: 77,
    p_source_id: sourceId,
    p_chunks: [
      {
        chunk_index: 0,
        content: 'First chunk',
        metadata: { origin: 'manual' },
      },
      {
        chunk_index: 1,
        content: 'Second chunk',
        metadata: {},
      },
    ],
  });
});

test('addSource removes the source if chunk persistence fails', async () => {
  let deleted: { businessId: number; id: string } | null = null;

  const storage: KnowledgeStorage = {
    initialize: async () => {},
    list: async () => [],
    create: async (source) => source,
    replaceChunks: async () => {
      throw new Error('chunk write failed');
    },
    delete: async (businessId, id) => {
      deleted = { businessId, id };
      return true;
    },
    search: async () => [],
  };

  const service = new KnowledgeService(storage, storage);

  await assert.rejects(
    () =>
      service.addSource({
        businessId: 55,
        type: 'text',
        title: 'Cleanup test',
        content: 'Content that should be indexed.',
        status: 'ready',
      }),
    /chunk write failed/,
  );

  assert.ok(deleted);
  assert.equal(deleted.businessId, 55);
  assert.ok(deleted.id);
});
