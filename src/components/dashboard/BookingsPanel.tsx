import { useMemo, useState } from 'react';
import type { Booking, BookingStatus } from '../../types/dashboard';
import { ChannelIcon, StatusDot } from './Icons';

const filters: Array<'all' | BookingStatus> = ['all', 'pending', 'confirmed', 'completed', 'cancelled'];

interface BookingsPanelProps {
  bookings: Booking[];
}

export default function BookingsPanel({ bookings }: BookingsPanelProps) {
  const [filter, setFilter] = useState<'all' | BookingStatus>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return bookings;
    return bookings.filter((booking) => booking.status === filter);
  }, [bookings, filter]);

  return (
    <section id="bookings" className="card dashboard-section">
      <div className="card-header">
        <div>
          <div className="card-title">Bookings</div>
          <div className="card-desc">Track pending, confirmed, completed and cancelled appointments.</div>
        </div>
        <div className="filter-row">
          {filters.map((item) => (
            <button
              className={filter === item ? 'filter-chip active' : 'filter-chip'}
              key={item}
              type="button"
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="booking-list">
        {filtered.length === 0 && <div className="empty-state">No bookings in this filter.</div>}
        {filtered.map((booking) => (
          <div className="booking-row" key={booking.id}>
            <ChannelIcon channel={booking.channel} />
            <div className="activity-text">
              <div className="activity-title">{booking.customerName}</div>
              <div className="activity-meta">
                {booking.serviceName || 'Service'} · {formatDate(booking.startsAt)}
              </div>
            </div>
            <div className={`status-chip ${booking.status === 'confirmed' || booking.status === 'completed' ? 'connected' : booking.status === 'cancelled' ? 'error' : 'disconnected'}`}>
              <StatusDot status={booking.status} />
              {booking.status}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
