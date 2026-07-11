import type { IntegrationKey } from '../../types/dashboard';

export function ChannelIcon({ channel }: { channel: IntegrationKey }) {
  const label = channel.replace('_', ' ');
  return (
    <span className={`channel-mark ${channel}`} aria-label={label} title={label}>
      {channel === 'instagram' && '◎'}
      {channel === 'telegram' && '✦'}
      {channel === 'messenger' && 'f'}
      {channel === 'whatsapp' && '☎'}
      {channel === 'google_calendar' && 'G'}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const tone = status === 'connected' || status === 'synced' || status === 'confirmed' ? 'ok' : status;
  return <span className={`status-dot ${tone}`} />;
}

