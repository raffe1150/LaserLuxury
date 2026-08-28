import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationsPanel from '../components/dashboard/ConversationsPanel';
import {
  buildConversationSummaries,
  collectConversationMatchPage,
  collectConversationSourcePages,
  conversationActivityCutoff,
  mergeConversationPages,
  normalizeConversationActivityRange,
  normalizeConversationChannel,
  normalizeConversationStatusFilter,
  normalizeConversationUserId,
  parseConversationId,
  toConversationMessage,
  type ConversationSourceRow,
} from './inbox';

const businessId = '7';
const rows: ConversationSourceRow[] = Array.from({ length: 31 }, (_, index) => ({
  id: index + 1,
  business_id: businessId,
  user_id: `customer-${index + 1}`,
  platform: index % 2 ? 'telegram-polling' : 'whatsapp',
  sender: 'customer',
  message: `Message ${index + 1}`,
  created_at: new Date(Date.UTC(2026, 7, 23, 10, index)).toISOString(),
  is_read: index % 3 !== 0,
}));

rows.push({
  id: 100,
  business_id: '8',
  user_id: 'customer-1',
  platform: 'whatsapp',
  sender: 'customer',
  message: 'Other tenant private message',
  created_at: '2026-08-23T12:00:00.000Z',
  is_read: false,
});

const summaries = buildConversationSummaries({
  businessId,
  messages: rows,
  leads: [
    { business_id: businessId, user_id: 'customer-1', platform: 'whatsapp', customer_name: 'Tenant Seven' },
    { business_id: '8', user_id: 'customer-1', platform: 'whatsapp', customer_name: 'Tenant Eight' },
    { business_id: null, user_id: 'customer-2', platform: 'telegram', customer_name: 'Unsafe Legacy Name' },
  ],
});

assert.equal(summaries.length, 31, 'representative histories larger than 25 remain available');
assert.equal(summaries[0].id, 'whatsapp:customer-31', 'newest conversation sorts first');
assert.equal(summaries.find((item) => item.id === 'whatsapp:customer-1')?.customerName, 'Tenant Seven');
assert.doesNotMatch(JSON.stringify(summaries), /Other tenant private message|Tenant Eight|Unsafe Legacy Name/);

const firstPage = summaries.slice(0, 25);
const secondPage = summaries.slice(25);
assert.equal(mergeConversationPages(firstPage, [firstPage[24], ...secondPage]).length, 31, 'page merge deduplicates boundaries');
assert.deepEqual(mergeConversationPages(firstPage, secondPage).map((item) => item.id), summaries.map((item) => item.id), 'page merge preserves stable order without loss');

const telegram = buildConversationSummaries({ businessId, messages: rows, channel: 'telegram' });
assert.ok(telegram.length > 0 && telegram.every((item) => item.channel === 'telegram'));
assert.equal(buildConversationSummaries({ businessId, messages: rows, search: 'message 21' }).length, 1);
assert.equal(normalizeConversationChannel('telegram_webhook'), 'telegram');
assert.deepEqual(parseConversationId('telegram:telegram_123'), { channel: 'telegram', userId: '123' });
assert.equal(toConversationMessage({ id: 1, sender: 'human', message: 'reply' }).author, 'human');
const crossTransport = buildConversationSummaries({
  businessId,
  messages: [
    { id: 201, business_id: businessId, user_id: '42', platform: 'telegram-polling', sender: 'customer', message: 'Poll', created_at: '2026-08-23T10:00:00Z' },
    { id: 202, business_id: businessId, user_id: 'telegram_42', platform: 'telegram_webhook', sender: 'ai', message: 'Webhook', created_at: '2026-08-23T10:01:00Z' },
  ],
});
assert.equal(crossTransport.length, 1, 'transport variants remain one canonical conversation');

const statusRows: ConversationSourceRow[] = [
  { id: 211, business_id: businessId, user_id: 'booked', platform: 'telegram', sender: 'customer', message: 'Booked message', created_at: '2026-08-25T10:00:00Z' },
  { id: 212, business_id: businessId, user_id: 'pending', platform: 'whatsapp', sender: 'customer', message: 'Pending message', created_at: '2026-08-24T10:00:00Z' },
  { id: 213, business_id: businessId, user_id: 'open', platform: 'instagram', sender: 'customer', message: 'Open message', created_at: '2026-07-16T10:00:00Z' },
  { id: 214, business_id: '8', user_id: 'booked', platform: 'telegram', sender: 'customer', message: 'Other tenant booking', created_at: '2026-08-25T11:00:00Z' },
];
const statusAppointments = [
  { business_id: businessId, user_id: 'booked', platform: 'telegram', customer_name: 'Booked Customer', status: 'confirmed' },
  { business_id: businessId, user_id: 'pending', platform: 'whatsapp', customer_name: 'Pending Customer', status: 'pending' },
  { business_id: '8', user_id: 'booked', platform: 'telegram', customer_name: 'Other Tenant', status: 'confirmed' },
];
const bookedStatus = buildConversationSummaries({ businessId, messages: statusRows, appointments: statusAppointments, status: 'booked' });
assert.deepEqual(bookedStatus.map((item) => item.id), ['telegram:booked'], 'Booked reuses confirmed/booked appointment classification');
const activeStatus = buildConversationSummaries({ businessId, messages: statusRows, appointments: statusAppointments, status: 'active' });
assert.deepEqual(new Set(activeStatus.map((item) => item.status)), new Set(['open', 'pending']), 'Active reuses open and pending conversation classifications');
assert.equal(buildConversationSummaries({
  businessId,
  messages: statusRows,
  appointments: statusAppointments,
  status: 'active',
  channel: 'whatsapp',
  range: '7d',
  search: 'Pending Customer',
  now: new Date('2026-08-25T12:00:00Z'),
}).length, 1, 'status composes with tenant, channel, range, and search filters');
assert.equal(normalizeConversationStatusFilter('unknown'), 'all');

const rangeNow = new Date('2026-08-25T12:00:00.000Z');
const rangeRows: ConversationSourceRow[] = [
  { id: 301, business_id: businessId, user_id: 'today', platform: 'telegram', sender: 'customer', message: 'Today', created_at: '2026-08-25T10:00:00.000Z' },
  { id: 302, business_id: businessId, user_id: 'within-30', platform: 'whatsapp', sender: 'customer', message: 'Ten days ago', created_at: '2026-08-15T10:00:00.000Z' },
  { id: 303, business_id: businessId, user_id: 'within-3m', platform: 'instagram', sender: 'customer', message: 'Forty days ago', created_at: '2026-07-16T10:00:00.000Z' },
  { id: 304, business_id: businessId, user_id: 'too-old', platform: 'messenger', sender: 'customer', message: 'Too old', created_at: '2026-05-01T10:00:00.000Z' },
  { id: 305, business_id: businessId, user_id: 'revived', platform: 'telegram-polling', sender: 'customer', message: 'Original', created_at: '2026-05-01T09:00:00.000Z' },
  { id: 306, business_id: businessId, user_id: 'telegram_revived', platform: 'telegram_webhook', sender: 'customer', message: 'New activity today', created_at: '2026-08-25T11:00:00.000Z' },
  { id: 307, business_id: '8', user_id: 'today', platform: 'telegram', sender: 'customer', message: 'Other tenant', created_at: '2026-08-25T11:30:00.000Z' },
];
const recentRange = buildConversationSummaries({ businessId, messages: rangeRows, range: 'recent', now: rangeNow });
assert.deepEqual(
  recentRange.map((item) => item.id),
  buildConversationSummaries({ businessId, messages: rangeRows, now: rangeNow }).map((item) => item.id),
  'Recent preserves the existing no-date-cutoff behavior',
);
const sevenDays = buildConversationSummaries({ businessId, messages: rangeRows, range: '7d', now: rangeNow });
assert.deepEqual(sevenDays.map((item) => item.id), ['telegram:revived', 'telegram:today']);
assert.equal(sevenDays.filter((item) => item.id === 'telegram:revived').length, 1, 'old conversation revived today is not duplicated');
assert.equal(buildConversationSummaries({ businessId, messages: rangeRows, range: '7d', search: 'ten days', now: rangeNow }).length, 0);
assert.equal(buildConversationSummaries({ businessId, messages: rangeRows, range: '30d', search: 'ten days', now: rangeNow }).length, 1, 'search composes with range');
const threeMonthsInstagram = buildConversationSummaries({ businessId, messages: rangeRows, range: '3m', channel: 'instagram', now: rangeNow });
assert.deepEqual(threeMonthsInstagram.map((item) => item.id), ['instagram:within-3m'], 'channel composes with range');
assert.equal(buildConversationSummaries({ businessId, messages: rangeRows, range: '30d', now: rangeNow }).some((item) => item.id === 'instagram:within-3m'), false);
assert.equal(buildConversationSummaries({ businessId, messages: rangeRows, range: '3m', now: rangeNow }).some((item) => item.id === 'instagram:within-3m'), true);
assert.equal(buildConversationSummaries({ businessId, messages: rangeRows, range: '3m', now: rangeNow }).some((item) => item.id === 'messenger:too-old'), false);
assert.equal(conversationActivityCutoff('recent', rangeNow), null);
assert.equal(conversationActivityCutoff('7d', rangeNow), '2026-08-18T12:00:00.000Z');
assert.equal(normalizeConversationActivityRange('3months'), '3m');

const highVolumeRows: ConversationSourceRow[] = [
  ...Array.from({ length: 2100 }, (_, index) => ({
    id: 1000 + index,
    business_id: businessId,
    user_id: 'high-volume',
    platform: 'telegram',
    sender: 'customer',
    message: `High volume ${index}`,
    created_at: new Date(Date.UTC(2026, 7, 25, 11, 59, 59) - index * 1000).toISOString(),
  })),
  { id: 4001, business_id: businessId, user_id: 'older-one', platform: 'whatsapp', sender: 'customer', message: 'Older one', created_at: '2026-07-15T10:00:00.000Z' },
  { id: 4002, business_id: businessId, user_id: 'older-two', platform: 'instagram', sender: 'customer', message: 'Older two', created_at: '2026-06-15T10:00:00.000Z' },
  { id: 4003, business_id: '8', user_id: 'other-tenant', platform: 'messenger', sender: 'customer', message: 'Private', created_at: '2026-06-15T10:00:00.000Z' },
];
const collectedRows = await collectConversationSourcePages(
  async (from, to) => highVolumeRows.slice(from, to + 1),
  1000,
);
assert.equal(collectedRows.length, highVolumeRows.length, 'database paging reaches rows beyond the first 2000 messages');
const pagedHistorical = buildConversationSummaries({
  businessId,
  messages: collectedRows,
  range: '3m',
  now: rangeNow,
});
assert.deepEqual(
  new Set(pagedHistorical.map((item) => item.id)),
  new Set(['telegram:high-volume', 'whatsapp:older-one', 'instagram:older-two']),
  'older eligible conversations remain reachable without duplicates or tenant leakage',
);

const historicalThreadRows: ConversationSourceRow[] = [
  ...Array.from({ length: 2100 }, (_, index) => ({
    id: 5000 + index,
    business_id: businessId,
    user_id: 'newer-volume',
    platform: 'telegram',
    sender: 'customer',
    message: `Newer ${index}`,
    created_at: new Date(Date.UTC(2026, 7, 25, 11, 59, 59) - index * 1000).toISOString(),
  })),
  { id: 8001, business_id: businessId, user_id: 'ig_historical', platform: 'instagram', sender: 'customer', message: 'Instagram history', created_at: '2026-06-20T10:00:00Z' },
  { id: 8002, business_id: businessId, user_id: 'ms_historical', platform: 'messenger', sender: 'customer', message: 'Messenger history', created_at: '2026-06-19T10:00:00Z' },
  { id: 8003, business_id: businessId, user_id: 'wa_historical', platform: 'whatsapp', sender: 'customer', message: 'WhatsApp history', created_at: '2026-06-18T10:00:00Z' },
  { id: 8004, business_id: businessId, user_id: 'telegram_historical', platform: 'telegram', sender: 'customer', message: 'Telegram history', created_at: '2026-06-17T10:00:00Z' },
  { id: 8005, business_id: '8', user_id: 'ig_historical', platform: 'instagram', sender: 'customer', message: 'Other tenant history', created_at: '2026-06-16T10:00:00Z' },
];
for (const channel of ['instagram', 'messenger', 'whatsapp', 'telegram']) {
  const page = await collectConversationMatchPage(
    async (from, to) => historicalThreadRows.slice(from, to + 1),
    (row) => String(row.business_id) === businessId &&
      normalizeConversationChannel(row.platform) === channel &&
      normalizeConversationUserId(row.user_id, channel) === 'historical',
    0,
    75,
    1000,
  );
  assert.equal(page.rows.length, 1, `${channel} historical list identity opens its tenant-scoped thread beyond the old source bound`);
  assert.equal(page.rows[0].business_id, businessId);
}
const firstThreadPage = await collectConversationMatchPage(
  async (from, to) => historicalThreadRows.slice(from, to + 1),
  (row) => String(row.business_id) === businessId && row.user_id === 'newer-volume',
  0,
  75,
  1000,
);
const secondThreadPage = await collectConversationMatchPage(
  async (from, to) => historicalThreadRows.slice(from, to + 1),
  (row) => String(row.business_id) === businessId && row.user_id === 'newer-volume',
  75,
  75,
  1000,
);
assert.equal(firstThreadPage.rows.length, 75);
assert.equal(firstThreadPage.hasMore, true);
assert.equal(secondThreadPage.rows.length, 75);
assert.equal(new Set([...firstThreadPage.rows, ...secondThreadPage.rows].map((row) => row.id)).size, 150, 'thread pages remain duplicate-free');

const panelMarkup = renderToStaticMarkup(createElement(ConversationsPanel, { businessId }));
assert.match(panelMarkup, /Search conversations/);
assert.match(panelMarkup, /Filter conversations by channel/);
assert.match(panelMarkup, /Filter conversations by activity range/);
assert.match(panelMarkup, /Filter conversations by status/);
assert.match(panelMarkup, /Recent/);
assert.match(panelMarkup, /7 days/);
assert.match(panelMarkup, /30 days/);
assert.match(panelMarkup, /3 months/);
assert.match(panelMarkup, /Active/);
assert.match(panelMarkup, /Booked/);
assert.match(panelMarkup, /Loading conversations/);
assert.match(panelMarkup, /conversations loaded · Recent/);

const panelSource = readFileSync(new URL('../components/dashboard/ConversationsPanel.tsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8');
assert.doesNotMatch(dashboardSource, /conversations\.slice\(0, 4\)|Full Inbox will be added/);
assert.match(panelSource, /author: 'human'/);
assert.match(panelSource, /AbortController/);
assert.match(panelSource, /requestId !== listRequest\.current/);
assert.match(panelSource, /requestId !== threadRequest\.current/);
assert.match(panelSource, /status: activeStatus/);
assert.match(panelSource, /activeStatus, activeRange/);
assert.match(panelSource, /No conversations found/);
assert.match(panelSource, /conversations loaded · \{activeRangeLabel\}/);
assert.doesNotMatch(panelSource, /\{total\} conversations<\/span>/);
assert.match(panelSource, /Inbox unavailable/);
assert.match(panelSource, /Thread unavailable/);
assert.match(panelSource, /conversation-send-error/);
assert.match(serverSource, /\.from\('appointments_leads'\)[\s\S]*?\.eq\('business_id', businessId\)/);
assert.match(serverSource, /\.from\('chat_history'\)[\s\S]*?\.eq\('business_id', businessId\)[\s\S]*?\.limit\(2000\)/);
assert.doesNotMatch(serverSource, /const matchingRows = \(identityRows \|\| \[\]\)/);
assert.match(serverSource, /collectConversationMatchPage[\s\S]*?\.eq\('business_id', businessId\)[\s\S]*?normalizePlatformUserId\(channel, row\.user_id\)/);
assert.match(serverSource, /collectConversationSourcePages[\s\S]*?\.gte\('created_at', activityCutoff\)[\s\S]*?\.range\(from, to\)/);
assert.match(serverSource, /\.eq\('business_id', businessId\)[\s\S]*?\.eq\('is_read', false\)/);
assert.match(serverSource, /normalizeConversationStatusFilter\(req\.query\.status\)/);
assert.match(serverSource, /conversationMatchesStatusFilter\(conversation\.status, statusFilter\)/);
assert.match(apiSource, /query\.set\('status', options\.status\)/);

console.log('Conversations inbox pagination, tenant isolation, filtering, and UX-state tests passed.');
