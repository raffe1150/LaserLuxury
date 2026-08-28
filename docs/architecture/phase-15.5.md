# Phase 15.5 — OdinLink Telegram Capabilities Endpoint

This phase adds a local, non-secret endpoint to OdinLink:

```text
GET /api/test/telegram-capabilities
```

Example response:

```json
{
  "telegramConfigured": true,
  "webhookManagedByOdinLink": true,
  "liveEnabled": true,
  "webhookRegistered": false,
  "webhookUrl": null
}
```

AI BlackBox reads this endpoint to determine whether Telegram is configured
inside OdinLink without receiving the bot token.

The response never contains Telegram tokens or Supabase secrets.
