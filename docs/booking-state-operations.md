# Booking operation state and clean-state validation

`appointments_leads.ai_summary` remains the only durable pending-booking store. The canonical reader is `normalizePendingBookingState`; state version `2` is stamped on every save. Compatible unversioned state is repaired in memory and written on the next transition. Future, completed, contradictory, cross-owner, or targetless management state is cleared.

## Owner-only pending-state reset

Use the authenticated Supabase SQL editor or an owner service session. Resolve the exact business, channel, and conversation identifier first, then inspect the row before changing it:

```sql
select user_id, platform, business_id, ai_summary
from appointments_leads
where business_id = :business_id
  and platform = :channel
  and user_id = :exact_conversation_id;
```

If and only if that row is the intended test conversation, clear its pending summary:

```sql
update appointments_leads
set ai_summary = null
where business_id = :business_id
  and platform = :channel
  and user_id = :exact_conversation_id;
```

This does not delete or alter `appointments` or Calendar events. Never use a business-wide predicate for live cleanup.

## Live diagnostics

Filter by the privacy-safe correlation ID and inspect: `businessId`, `channel`, `activeOperation`, phase/status before and after, `expectedInput`, `stateVersion`, reset reason/repairs, availability constraint/fingerprint and offer counts, transaction stage/outcome, failure category, duration, and duplicate-event status. Logs intentionally omit raw messages, names, phone numbers, media URLs, credentials, and provider bodies.
