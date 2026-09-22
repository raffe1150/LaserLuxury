import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260921120000_add_booking_slot_reservations_and_result_outbox.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /^begin;[\s\S]*commit;\s*$/);
assert.match(migration, /create table public\.booking_slot_reservations[\s\S]*primary key \(business_id, calendar_identity, start_time, end_time\)/);
assert.match(migration, /on conflict \(business_id, calendar_identity, start_time, end_time\)[\s\S]*reservation\.status = 'released'[\s\S]*reservation\.status = 'reserved'[\s\S]*reservation\.operation_id = excluded\.operation_id[\s\S]*reservation\.expires_at <= now\(\)/);
assert.doesNotMatch(migration, /reservation\.operation_id = excluded\.operation_id\s+or\s+reservation\.status = 'released'/);
assert.match(migration, /create table public\.booking_result_outbox[\s\S]*operation_id text not null unique/);
assert.match(migration, /create or replace function public\.finalize_booking_result_outbox[\s\S]*for update;[\s\S]*status = 'settled'[\s\S]*insert into public\.booking_result_outbox[\s\S]*update public\.appointments_leads/);
assert.match(migration, /create or replace function public\.claim_booking_result_outbox_delivery[\s\S]*status = 'delivering'[\s\S]*attempts = attempts \+ 1[\s\S]*lease_expires_at <= now\(\)/);
assert.match(migration, /create or replace function public\.complete_booking_result_outbox_delivery[\s\S]*if changed = 1 then[\s\S]*return true;[\s\S]*return p_delivered and exists[\s\S]*delivery_token = p_delivery_token[\s\S]*status = 'delivered'/);
assert.match(migration, /alter table public\.booking_slot_reservations enable row level security/);
assert.match(migration, /alter table public\.booking_result_outbox enable row level security/);
assert.equal((migration.match(/security invoker/g) || []).length, 6);
assert.doesNotMatch(migration, /security definer/i);
assert.match(migration, /revoke all on function public\.claim_booking_slot_reservation[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.claim_booking_slot_reservation[\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i);

console.log("Launch-critical migration contract tests passed");
