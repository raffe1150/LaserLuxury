begin;

-- Durable operation claims share appointments_leads with ordinary conversation/lead rows.
-- Global user_id uniqueness is unsafe because customer identifiers are not globally unique.
-- This migration repairs and constrains only rows owned by the idempotency subsystem.

lock table public.appointments_leads in share row exclusive mode;

create temporary table _odinlink_idempotency_claim_rank
on commit drop
as
select
  id,
  user_id,
  created_at,
  false::boolean as valid_state,
  null::text as state_status,
  null::numeric as state_updated_at,
  null::numeric as state_attempts,
  null::numeric as state_claimed_at
from public.appointments_leads
where platform like 'idempotency:%';

-- ai_summary is text in the deployed schema. Parse each claim defensively so one
-- malformed legacy row cannot abort the migration or outrank a valid state.
do $migration$
declare
  claim_row record;
  parsed jsonb;
  parsed_valid boolean;
begin
  for claim_row in
    select id, ai_summary
    from public.appointments_leads
    where platform like 'idempotency:%'
  loop
    parsed := null;
    parsed_valid := false;
    begin
      parsed := claim_row.ai_summary::jsonb;
      parsed_valid :=
        jsonb_typeof(parsed) = 'object' and
        parsed->>'type' in (
          'inbound_message_claim',
          'booking_operation_claim',
          'reschedule_operation_claim',
          'cancellation_operation_claim'
        ) and
        parsed->>'status' in ('processing', 'completed', 'failed');
    exception when others then
      parsed := null;
      parsed_valid := false;
    end;

    update _odinlink_idempotency_claim_rank
    set
      valid_state = parsed_valid,
      state_status = case when parsed_valid then parsed->>'status' end,
      state_updated_at = case
        when parsed_valid and coalesce(parsed->>'updatedAt', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (parsed->>'updatedAt')::numeric
      end,
      state_attempts = case
        when parsed_valid and coalesce(parsed->>'attempts', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (parsed->>'attempts')::numeric
      end,
      state_claimed_at = case
        when parsed_valid and coalesce(parsed->>'claimedAt', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (parsed->>'claimedAt')::numeric
      end
    where id = claim_row.id;
  end loop;
end
$migration$;

-- Canonical-row tie-breaker for each exact durable claim key (user_id):
--   1. valid AtomicClaimState beats malformed state;
--   2. completed beats every non-completed state (terminal success is authoritative);
--   3. greatest updatedAt;
--   4. failed beats processing when timestamps tie;
--   5. greatest attempts, then greatest claimedAt;
--   6. newest database created_at;
--   7. smallest primary key id for a final deterministic tie-break.
with ranked_claims as (
  select
    id,
    row_number() over (
      partition by user_id
      order by
        valid_state desc,
        (state_status = 'completed') desc,
        state_updated_at desc nulls last,
        (state_status = 'failed') desc,
        state_attempts desc nulls last,
        state_claimed_at desc nulls last,
        created_at desc,
        id asc
    ) as claim_rank
  from _odinlink_idempotency_claim_rank
), redundant_claims as (
  select id
  from ranked_claims
  where claim_rank > 1
)
delete from public.appointments_leads as target
using redundant_claims
where
  target.id = redundant_claims.id and
  target.platform like 'idempotency:%';

create unique index appointments_leads_idempotency_user_id_uidx
  on public.appointments_leads (user_id)
  where platform like 'idempotency:%';

comment on index public.appointments_leads_idempotency_user_id_uidx is
  'Cross-instance uniqueness for OdinLink durable operation claims only; ordinary lead rows remain non-unique.';

commit;
