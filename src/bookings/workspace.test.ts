import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BookingsPanel from '../components/dashboard/BookingsPanel';
import type { Booking, BookingView } from '../types/dashboard';
import {
  bookingMatchesView,
  bookingStatusLabel,
  groupBookingsByDate,
  mergeBookingPages,
  sortBookingsStable,
} from './workspace';

const now = new Date('2026-08-24T08:00:00.000Z');
const booking = (id: string, startsAt: string, status: Booking['status'], overrides: Partial<Booking> = {}): Booking => ({
  id,
  customerName: `Customer ${id}`,
  serviceName: 'Consultation',
  channel: 'telegram',
  status,
  startsAt,
  endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
  ...overrides,
});

const fixtures = [
  booking('today-confirmed', '2026-08-24T10:00:00.000Z', 'confirmed'),
  booking('today-pending', '2026-08-24T11:00:00.000Z', 'pending'),
  booking('tomorrow', '2026-08-25T09:00:00.000Z', 'confirmed'),
  booking('week', '2026-08-29T09:00:00.000Z', 'confirmed'),
  booking('later', '2026-09-10T09:00:00.000Z', 'confirmed'),
  booking('past-confirmed', '2026-08-23T09:00:00.000Z', 'confirmed'),
  booking('completed', '2026-08-22T09:00:00.000Z', 'completed'),
  booking('cancelled', '2026-08-26T09:00:00.000Z', 'cancelled'),
  booking('unknown', '2026-08-27T09:00:00.000Z', 'unknown'),
];

const matches = (view: BookingView) => fixtures.filter((item) => bookingMatchesView(item, view, now)).map((item) => item.id);
assert.deepEqual(matches('upcoming'), ['today-confirmed', 'today-pending', 'tomorrow', 'week', 'later']);
assert.deepEqual(matches('pending'), ['today-pending']);
assert.deepEqual(matches('cancelled'), ['cancelled']);
assert.deepEqual(matches('past'), ['past-confirmed', 'completed']);
assert.equal(matches('all').length, fixtures.length);

const groups = groupBookingsByDate(fixtures, now, 'UTC');
assert.deepEqual(groups.map((group) => group.label), ['Today', 'Tomorrow', 'This week', 'Later', 'Earlier']);
assert.deepEqual(groups.find((group) => group.key === 'today')?.items.map((item) => item.id), ['today-confirmed', 'today-pending']);

const unstable = [
  booking('10', '2026-08-25T09:00:00.000Z', 'confirmed'),
  booking('2', '2026-08-25T09:00:00.000Z', 'confirmed'),
  booking('1', '2026-08-24T09:00:00.000Z', 'confirmed'),
];
assert.deepEqual(sortBookingsStable(unstable, true).map((item) => item.id), ['1', '2', '10']);
assert.deepEqual(sortBookingsStable(unstable, false).map((item) => item.id), ['2', '10', '1']);

const firstPage = Array.from({ length: 25 }, (_, index) => booking(String(index + 1), `2026-09-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`, 'confirmed'));
const secondPage = [firstPage[24], booking('26', '2026-09-26T09:00:00.000Z', 'confirmed')];
assert.equal(mergeBookingPages(firstPage, secondPage).length, 26, 'load-more boundaries do not duplicate rows');

assert.equal(bookingStatusLabel('confirmed'), 'Confirmed');
assert.equal(bookingStatusLabel('pending'), 'Pending');
assert.equal(bookingStatusLabel('cancelled'), 'Cancelled');
assert.equal(bookingStatusLabel('completed'), 'Completed');
assert.equal(bookingStatusLabel('unknown'), 'Needs review');

const markup = renderToStaticMarkup(createElement(BookingsPanel, { businessId: '7', timezone: 'UTC' }));
assert.match(markup, /Booking summary/);
assert.match(markup, /Search bookings/);
assert.match(markup, /Loading bookings/);
assert.doesNotMatch(markup, /today-confirmed|internal|appointment id/i);

const panelSource = readFileSync(new URL('../components/dashboard/BookingsPanel.tsx', import.meta.url), 'utf8');
const dashboardCss = readFileSync(new URL('../styles/dashboard.css', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
assert.match(panelSource, /useState<BookingView>\('upcoming'\)/);
assert.match(panelSource, /AbortController/);
assert.match(panelSource, /requestId !== requestGeneration\.current/);
assert.match(panelSource, /setBookings\(\[\]\)/);
assert.match(panelSource, /No upcoming bookings/);
assert.match(panelSource, /Bookings unavailable/);
assert.match(panelSource, /booking-skeleton/);
assert.match(panelSource, /bookingStatusLabel\(booking\.status\)/);
assert.match(panelSource, /booking\.serviceName/);
assert.match(panelSource, /ChannelIcon channel=\{booking\.channel\}/);
assert.doesNotMatch(panelSource, /<d[dt]>[^<]*ID|\{selected\.id\}/i);
const desktopWorkspaceRule = dashboardCss.match(/\.booking-workspace-layout\{([\s\S]*?)\}/)?.[1] || '';
const bookingResultsRule = dashboardCss.match(/\.booking-results\{([\s\S]*?)\}/)?.[1] || '';
const mobileBookingsRule = dashboardCss.match(/@media\(max-width:700px\)\{([\s\S]*?)\/\* SPRINT 4B\.4/)?.[1] || '';
assert.match(desktopWorkspaceRule, /grid-template-rows:minmax\(0,1fr\)/, 'desktop grid must allow its row to shrink');
assert.match(desktopWorkspaceRule, /block-size:clamp\(/, 'desktop workspace must establish a definite scrollport size');
assert.match(bookingResultsRule, /min-height:0/);
assert.match(bookingResultsRule, /overflow-y:auto/);
assert.match(mobileBookingsRule, /\.booking-workspace-layout[^}]*block-size:auto/);
assert.match(mobileBookingsRule, /\.booking-results\{[^}]*overflow:visible/);
assert.match(serverSource, /\.from\('appointments'\)[\s\S]*?\.eq\('business_id', businessId\)/);
assert.match(serverSource, /\.limit\(pagedResponseRequested \? 2001 : limit\)/);
assert.match(serverSource, /return 'unknown'/);
assert.match(serverSource, /if \(!pagedResponseRequested\)[\s\S]*?json\(bookings\)/);

console.log('Bookings workspace filtering, grouping, pagination, privacy, and UX-state tests passed.');
