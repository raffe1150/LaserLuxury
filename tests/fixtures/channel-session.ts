import { createHash } from 'node:crypto';

type EngineBoundary = typeof import('../../server')['priority1hUnifiedEngineTestBoundary'];
type Channel = Parameters<EngineBoundary['turn']>[0]['platformName'];
type BusinessFixture = { id: string | number; telegramToken?: string };

// The production Meta/WhatsApp session helper intentionally excludes Telegram.
// Engine fixtures supply Telegram's tenant/bot/chat context directly, matching
// the claimed Telegram handler's tg:<business>:<token fingerprint>:<chat> key.
export function fixtureChannelSessionId(
  boundary: Pick<EngineBoundary, 'channelSessionId'>,
  channel: Channel,
  userId: string,
  business: BusinessFixture,
): string {
  if (channel !== 'telegram') return boundary.channelSessionId(channel, userId, business);
  const token = String(business.telegramToken || '').replace(/[\r\n]/g, '').trim();
  const fingerprint = token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'missing';
  return `tg:${business.id}:${fingerprint}:${userId}`;
}
