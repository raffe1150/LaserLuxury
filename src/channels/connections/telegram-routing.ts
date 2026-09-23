export function selectTelegramOutboundToken(
  businessConfig: any,
  legacyConfig: any,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const businessToken = String(businessConfig?.telegramToken || '').trim();
  const selfServiceConnection = Boolean(
    businessConfig?.channelConnectionSource === 'self_service' ||
    businessConfig?.telegramBusinessConnectionId,
  );
  if (selfServiceConnection) return businessToken;
  return businessToken || String(
    legacyConfig?.telegramToken || environment.TELEGRAM_TOKEN || environment.TELEGRAM_BOT_TOKEN || '',
  ).trim();
}
