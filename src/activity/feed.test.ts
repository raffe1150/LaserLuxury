import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import type { ActivityEvent } from '../types/dashboard';
import { compactActivityEvents, groupActivityByDate, mergeActivityPages } from './feed';

const event = (key: string, type: ActivityEvent['type'], occurredAt: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  key,
  type,
  category: type === 'conversation_started' ? 'conversations' : 'bookings',
  title: type.replaceAll('_', ' '),
  occurredAt,
  channel: 'telegram',
  severity: type === 'booking_failed' ? 'error' : 'info',
  ...overrides,
});

const fixtures = [
  event('confirmed', 'booking_confirmed', '2026-08-24T10:30:00.000Z', { detail: 'Alex · Consultation' }),
  event('cancelled', 'booking_cancelled', '2026-08-24T10:00:00.000Z'),
  event('rescheduled', 'booking_rescheduled', '2026-08-23T11:00:00.000Z'),
  event('failed', 'booking_failed', '2026-08-22T09:00:00.000Z'),
  event('conversation-1', 'conversation_started', '2026-08-24T09:00:00.000Z'),
  event('conversation-2', 'conversation_started', '2026-08-24T08:30:00.000Z'),
];

const compacted = compactActivityEvents(fixtures, 'UTC');
assert.equal(compacted.length, 5, 'anonymous conversations on the same day and channel compact safely');
assert.equal(compacted.find((item) => item.type === 'conversation_started')?.title, '2 conversations started');
assert.deepEqual(compacted.slice(0, 3).map((item) => item.key), ['confirmed', 'cancelled', 'conversation-group:2026-08-24:telegram']);
assert.ok(compacted.some((item) => item.type === 'booking_confirmed'));
assert.ok(compacted.some((item) => item.type === 'booking_cancelled'));
assert.ok(compacted.some((item) => item.type === 'booking_rescheduled'));
assert.ok(compacted.some((item) => item.type === 'booking_failed'));

const groups = groupActivityByDate(compacted, new Date('2026-08-24T12:00:00.000Z'), 'UTC');
assert.deepEqual(groups.map((group) => group.label), ['Today', 'Yesterday', 'Earlier']);
assert.deepEqual(groups[0].items.map((item) => item.key), ['confirmed', 'cancelled', 'conversation-group:2026-08-24:telegram']);

const pageOne = fixtures.slice(0, 4);
const pageTwo = [fixtures[3], event('older', 'booking_confirmed', '2026-08-20T09:00:00.000Z')];
const merged = mergeActivityPages(pageOne, pageTwo);
assert.equal(merged.length, 5, 'load-more boundaries never duplicate an event');
assert.equal(merged[0].key, 'confirmed', 'merged pages remain newest first');

const markup = renderToStaticMarkup(createElement(ActivityFeed, { businessId: '7', timezone: 'UTC' }));
assert.match(markup, /Recent activity/);
assert.match(markup, /Filter activity/);
assert.match(markup, /Loading activity/);
assert.doesNotMatch(markup, /idempotency|database id|analytics metadata/i);

const componentSource = readFileSync(new URL('../components/dashboard/ActivityFeed.tsx', import.meta.url), 'utf8');
const dashboardSectionsSource = readFileSync(new URL('../components/dashboard/DashboardSections.tsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../pages/dashboard.tsx', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

assert.match(componentSource, /AbortController/);
assert.match(componentSource, /requestId !== requestGeneration\.current/);
assert.match(componentSource, /setEvents\(\[\]\)/);
assert.match(componentSource, /No recent activity/);
assert.match(componentSource, /Activity unavailable/);
assert.match(componentSource, /activity-skeleton/);
assert.match(componentSource, /category === filter\.id/);
assert.match(dashboardSource, /<ActivityFeed[\s\S]*?key=\{selectedBusiness\.id\}/);
assert.doesNotMatch(dashboardSectionsSource, /Booking \$\{booking\.status\}|Conversation \$\{conversation\.status\}/);

const activityRoute = serverSource.match(/app\.get\('\/api\/businesses\/:businessId\/activity'[\s\S]*?\n\}\);/)?.[0] || '';
assert.match(activityRoute, /requireBusinessPermission\('business\.read'\)/);
assert.match(activityRoute, /\.from\('analytics_events'\)/);
assert.match(activityRoute, /\.eq\('business_id', businessId\)/);
assert.match(activityRoute, /\.order\('occurred_at', \{ ascending: false \}\)/);
assert.match(activityRoute, /\.range\(cursor, cursor \+ limit\)/);
assert.match(activityRoute, /booking_completed/);
assert.match(activityRoute, /booking_cancelled/);
assert.match(activityRoute, /booking_rescheduled/);
assert.match(activityRoute, /conversation_started/);
assert.match(activityRoute, /\.from\('appointments'\)[\s\S]*?\.eq\('business_id', businessId\)/);
assert.doesNotMatch(activityRoute.match(/return res\.status\(200\)\.json\(\{[\s\S]*?\n    \}\);/)?.[0] || '', /idempotency_key|metadata|conversation_id|booking_id/);

console.log('Activity ordering, grouping, lifecycle coverage, isolation, privacy, and UX-state tests passed.');
