import type { IntegrationKey } from '../../types/dashboard';

export function ChannelIcon({ channel }: { channel: IntegrationKey }) {
  const label = channel.replaceAll('_', ' ');

  return (
    <span
      className={`channel-mark ${channel}`}
      aria-label={label}
      title={label}
      role="img"
    >
      {channel === 'instagram' && <InstagramIcon />}
      {channel === 'telegram' && <TelegramIcon />}
      {channel === 'messenger' && <MessengerIcon />}
      {channel === 'whatsapp' && <WhatsAppIcon />}
      {channel === 'google_calendar' && <GoogleCalendarIcon />}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const tone =
    status === 'connected' ||
    status === 'synced' ||
    status === 'confirmed'
      ? 'ok'
      : status;

  return <span className={`status-dot ${tone}`} />;
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="instagram-gradient" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffdc80" />
          <stop offset="28%" stopColor="#fcaf45" />
          <stop offset="50%" stopColor="#f77737" />
          <stop offset="72%" stopColor="#e1306c" />
          <stop offset="100%" stopColor="#833ab4" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#instagram-gradient)" />
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="17.4" cy="6.8" r="1.1" fill="#fff" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path
        d="M17.9 7.1 15.2 18c-.2.8-.8 1-1.5.6l-4.1-3-2 1.9c-.2.2-.4.4-.8.4l.3-4.2 7.7-7c.3-.3-.1-.5-.5-.2l-9.5 6-4.1-1.3c-.9-.3-.9-.9.2-1.3l16-6.2c.7-.3 1.4.2 1.1 1.4Z"
        fill="#fff"
      />
    </svg>
  );
}

function MessengerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="messenger-gradient" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#006AFF" />
          <stop offset="100%" stopColor="#A033FF" />
        </linearGradient>
      </defs>
      <path
        d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.4 3.7 7.1V22l3.4-1.9c.9.2 1.9.3 2.9.3 5.5 0 10-4.1 10-9.2S17.5 2 12 2Z"
        fill="url(#messenger-gradient)"
      />
      <path
        d="m6.8 14.1 3.3-3.5 2.5 1.9 4.6-4.9-3.3 3.5-2.5-1.9-4.6 4.9Z"
        fill="#fff"
      />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#25D366" />
      <path
        d="M7.2 17.2 8 14.4a6 6 0 1 1 2.2 2.1l-3 .7Zm3.2-2.3.2.1a4.4 4.4 0 1 0-1.1-1.1l.1.2-.4 1.4 1.2-.5Zm5.1-2.2c-.2-.1-1.1-.5-1.3-.6-.2-.1-.4-.1-.5.1-.2.2-.5.6-.6.8-.1.1-.2.2-.4.1-.2-.1-.9-.3-1.7-1.1-.6-.5-1-1.2-1.2-1.4-.1-.2 0-.3.1-.4l.4-.5c.1-.1.1-.2.2-.3 0-.1 0-.2-.1-.4l-.6-1.4c-.1-.3-.3-.3-.5-.3h-.4c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.3c.1.2 1.6 2.5 4 3.4.6.2 1 .4 1.3.5.6.2 1.1.2 1.5.1.5-.1 1.1-.5 1.3-1 .2-.5.2-.9.1-1-.1-.1-.2-.2-.4-.3Z"
        fill="#fff"
      />
    </svg>
  );
}

function GoogleCalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" fill="#fff" />
      <path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" fill="#4285F4" />
      <path d="M3 8h18V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2Z" fill="#1A73E8" />
      <path d="M7 2v4M17 2v4" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M8.2 13.4c.2-1.4 1.3-2.3 2.8-2.3 1.8 0 3 1.2 3 2.9 0 2.2-1.7 3.8-4.6 3.8-.8 0-1.6-.1-2.3-.4l.5-1.6c.5.2 1 .3 1.6.3 1.4 0 2.3-.6 2.3-1.6 0-.8-.6-1.3-1.5-1.3-.5 0-.9.1-1.3.4l-.5-1.9Z" fill="#fff" />
    </svg>
  );
}
