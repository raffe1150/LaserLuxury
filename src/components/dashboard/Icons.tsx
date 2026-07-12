import type { IntegrationKey } from '../../types/dashboard';

const CHANNEL_LOGOS: Record<IntegrationKey, string> = {
  instagram: '/logos/instagram.webp',
  messenger: '/logos/messenger.webp',
  telegram: '/logos/telegram.webp',
  whatsapp: '/logos/whatsapp.webp',
  google_calendar: '/logos/google-calendar.webp',
};

export function ChannelIcon({ channel }: { channel: IntegrationKey }) {
  const label = channel.replaceAll('_', ' ');

  return (
    <span
      className={`channel-mark ${channel}`}
      aria-label={label}
      title={label}
      role="img"
    >
      <img
        className="channel-logo"
        src={CHANNEL_LOGOS[channel]}
        alt=""
        aria-hidden="true"
      />
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
