import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groupNotificationsByRecency,
  healthConditionKey,
  projectBookingFailureNotifications,
  projectHealthNotifications,
  resolvedHealthConditionKeys,
} from './model';
import type { IntegrationHealth, NotificationItem } from '../types/dashboard';

const disconnected: IntegrationHealth = {
  key: 'instagram',
  label: 'Instagram',
  status: 'disconnected',
  detail: 'Authorization is invalid or has expired.',
  lastCheckedAt: '2026-08-24T09:00:00.000Z',
  reasonCode: 'authorization_invalid',
  action: 'reconnect',
};

const healthNotifications = projectHealthNotifications([disconnected, { ...disconnected }]);
assert.equal(healthNotifications.length, 2);
assert.equal(healthNotifications[0].conditionKey, healthNotifications[1].conditionKey, 'identical checks use one deterministic persistence identity');
assert.equal(healthNotifications[0].conditionKey, healthConditionKey('instagram'));
assert.equal(healthNotifications[0].actionTarget, '#health');
assert.equal(projectHealthNotifications([{ ...disconnected, status: 'degraded', reasonCode: 'timeout' }]).length, 0, 'temporary timeouts stay low-noise');
assert.deepEqual(resolvedHealthConditionKeys([{ ...disconnected, status: 'connected', reasonCode: 'verified' }]), [healthConditionKey('instagram')]);

const bookingRows = [
  { id: 'failure-a', event_name: 'booking_failed', occurred_at: '2026-08-24T08:00:00.000Z', conversation_id: 'conversation-a', reason_code: 'database_verification_failed' },
  { id: 'failure-b', event_name: 'booking_failed', occurred_at: '2026-08-24T08:05:00.000Z', conversation_id: 'conversation-b', reason_code: 'no_availability' },
  { id: 'success-a', event_name: 'booking_completed', occurred_at: '2026-08-24T08:10:00.000Z', conversation_id: 'conversation-a', reason_code: null },
  { id: 'conversation', event_name: 'conversation_started', occurred_at: '2026-08-24T08:15:00.000Z', conversation_id: 'conversation-c', reason_code: null },
];
const bookingNotifications = projectBookingFailureNotifications(bookingRows);
assert.equal(bookingNotifications.length, 1, 'ordinary availability misses, successes, and conversation starts do not notify');
assert.equal(bookingNotifications[0].conditionKey, 'booking_failure:failure-a');
assert.equal(bookingNotifications[0].resolvedAt, '2026-08-24T08:10:00.000Z', 'later authoritative completion resolves the failure');
assert.equal(bookingNotifications[0].actionTarget, '#activity');
assert.doesNotMatch(JSON.stringify(bookingNotifications), /conversation-a|customer|token|credential/i, 'presentation does not copy source identifiers or secrets');

const grouped = groupNotificationsByRecency([
  { id: 'today', category: 'booking', severity: 'attention', title: 'A', description: 'A', firstObservedAt: '2026-08-24T08:00:00Z', lastObservedAt: '2026-08-24T08:00:00Z', read: false, active: true },
  { id: 'earlier', category: 'integration', severity: 'critical', title: 'B', description: 'B', firstObservedAt: '2026-08-22T08:00:00Z', lastObservedAt: '2026-08-22T08:00:00Z', read: true, active: true },
] satisfies NotificationItem[], new Date('2026-08-24T12:00:00Z'), 'UTC');
assert.deepEqual(grouped.map((group) => group.label), ['Today', 'Earlier']);

const migration = readFileSync(new URL('../../supabase/migrations/20260824120000_create_business_notifications.sql', import.meta.url), 'utf8');
assert.match(migration, /business_id bigint not null references public\.businesses/);
assert.match(migration, /unique \(business_id, condition_key\)/);
assert.match(migration, /read_at timestamptz/);
assert.match(migration, /resolved_at timestamptz/);
assert.match(migration, /enable row level security/);

const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(server, /requireBusinessPermission\('business\.read'\)/);
assert.match(server, /\.eq\('business_id', businessId\)/);
assert.match(server, /\.is\('resolved_at', null\)/);
assert.match(server, /\.is\('read_at', null\)/);
assert.match(server, /\.limit\(500\)/);
assert.doesNotMatch(server.match(/async function syncBusinessNotifications[\s\S]*?\n\}/)?.[0] || '', /recordRuntimeAnalyticsEvent|insertAppointment|sendMessage/);

const component = readFileSync(new URL('../components/dashboard/NotificationCenter.tsx', import.meta.url), 'utf8');
assert.match(component, /onUnreadCountChange\?\.\(0\)/, 'business/filter reload clears the badge immediately');
assert.match(component, /requestId !== requestGeneration\.current/, 'stale notification responses are ignored');
assert.match(component, /Your operational workflows are unaffected/);
assert.match(component, /You're all caught up/);
assert.match(component, /No issues need your attention right now/);

console.log('Actionable notification model tests passed.');
