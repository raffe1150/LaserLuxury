import type { Booking, BookingView } from '../types/dashboard';

export interface BookingGroup {
  key: 'today' | 'tomorrow' | 'this-week' | 'later' | 'earlier';
  label: string;
  items: Booking[];
}

function dateKey(value: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dayDifference(value: string, now: Date, timezone: string): number {
  const target = Date.parse(`${dateKey(value, timezone)}T00:00:00Z`);
  const current = Date.parse(`${dateKey(now, timezone)}T00:00:00Z`);
  return Math.round((target - current) / 86_400_000);
}

export function groupBookingsByDate(
  bookings: Booking[],
  now = new Date(),
  timezone = 'UTC',
): BookingGroup[] {
  const groups = new Map<BookingGroup['key'], Booking[]>();
  for (const booking of bookings) {
    const difference = dayDifference(booking.startsAt, now, timezone);
    const key: BookingGroup['key'] = difference < 0
      ? 'earlier'
      : difference === 0
        ? 'today'
        : difference === 1
          ? 'tomorrow'
          : difference <= 7
            ? 'this-week'
            : 'later';
    const current = groups.get(key) || [];
    current.push(booking);
    groups.set(key, current);
  }

  const labels: Record<BookingGroup['key'], string> = {
    today: 'Today',
    tomorrow: 'Tomorrow',
    'this-week': 'This week',
    later: 'Later',
    earlier: 'Earlier',
  };
  const order: BookingGroup['key'][] = ['today', 'tomorrow', 'this-week', 'later', 'earlier'];
  return order
    .filter((key) => groups.has(key))
    .map((key) => ({ key, label: labels[key], items: groups.get(key)! }));
}

export function mergeBookingPages(current: Booking[], next: Booking[]): Booking[] {
  const merged = new Map(current.map((booking) => [booking.id, booking]));
  for (const booking of next) merged.set(booking.id, booking);
  return [...merged.values()];
}

export function bookingMatchesView(booking: Booking, view: BookingView, now = new Date()): boolean {
  const startsInFuture = new Date(booking.startsAt).getTime() >= now.getTime();
  const active = booking.status === 'confirmed' || booking.status === 'pending';
  if (view === 'upcoming') return active && startsInFuture;
  if (view === 'pending') return booking.status === 'pending';
  if (view === 'cancelled') return booking.status === 'cancelled';
  if (view === 'past') return booking.status === 'completed' || (booking.status === 'confirmed' && !startsInFuture);
  return true;
}

export function sortBookingsStable(bookings: Booking[], ascending: boolean): Booking[] {
  return [...bookings].sort((left, right) => {
    const direction = ascending ? 1 : -1;
    const timeDifference = new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime();
    return direction * timeDifference || left.id.localeCompare(right.id, undefined, { numeric: true });
  });
}

export function bookingStatusLabel(status: Booking['status']): string {
  if (status === 'confirmed') return 'Confirmed';
  if (status === 'pending') return 'Pending';
  if (status === 'completed') return 'Completed';
  if (status === 'cancelled') return 'Cancelled';
  return 'Needs review';
}
