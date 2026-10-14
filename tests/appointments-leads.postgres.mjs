// Synthetic, disposable PostgreSQL only. Never accepts a connection URL or credentials.
// Run with local initdb/pg_ctl/psql on PATH; no TCP listener or Supabase access.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migration = readFileSync(resolve(root, 'supabase/migrations/20261014193039_restrict_appointments_leads_to_backend_access.sql'), 'utf8');
const body = migration.replace(/^begin;$/m, '').replace(/^commit;$/m, '');
const bookingMigration = readFileSync(resolve(root, 'supabase/migrations/20260921120000_add_booking_slot_reservations_and_result_outbox.sql'), 'utf8')
  .replace(/^begin;$/m, '').replace(/^commit;$/m, '');
const scratch = mkdtempSync(resolve(tmpdir(), 'odin-lead-'));
const data = resolve(scratch, 'data');
const socket = resolve(scratch, 'socket');
mkdirSync(socket);
const env = { PATH: process.env.PATH, LC_ALL: 'C', LANG: 'C' };
let started = false;
function command(binary, args, input) {
  return spawnSync(binary, args, { input, encoding: 'utf8', env, timeout: 30_000, maxBuffer: 1024 * 1024 });
}
function successful(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function sql(input, succeeds = true) {
  const result = command('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', 'fixture_admin', '-d', 'postgres'], '\\set VERBOSITY verbose\n' + input);
  return succeeds ? successful(result) : result;
}
function denied(role, statement) {
  const result = sql(`begin; set local role ${role}; ${statement}; rollback;`, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /42501: permission denied/u);
}
function driftRejected(setup, message) {
  const result = sql(`begin; ${setup}; ${body} rollback;`, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(message));
  assert.equal(sql("select has_any_column_privilege('anon','public.appointments_leads','SELECT') or has_table_privilege('authenticated','public.appointments_leads','UPDATE');"), 'f');
}
const claim = 'cancelop_synthetic';
const platform = 'idempotency:telegram';
const snapshot = () => sql(`select json_agg(t order by id)::text from public.appointments_leads t;`);
const functionSnapshot = () => sql("select md5(pg_get_functiondef('public.finalize_booking_result_outbox(text,text,text,text,bigint,text,text,text,text,text,text,timestamptz,timestamptz,jsonb,text)'::regprocedure));");

before(() => {
  successful(command('initdb', ['-D', data, '--auth=trust', '--username=fixture_admin']));
  successful(command('pg_ctl', ['-D', data, '-l', resolve(scratch, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']));
  started = true;
  sql(`begin;
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    create table public.businesses (id bigint primary key);
    insert into public.businesses values (1101),(1102);
    create table public.appointments_leads (
      id bigint generated always as identity primary key, user_id text not null,
      customer_name text, phone_number text, appointment_date date, appointment_time time,
      raw_feedback text, ai_summary text, platform text default 'telegram',
      created_at timestamptz not null default timezone('utc', now()), business_id bigint);
    create unique index appointments_leads_idempotency_user_id_uidx
      on public.appointments_leads(user_id) where platform like 'idempotency:%';
    alter table public.appointments_leads enable row level security;
    create policy allow_all on public.appointments_leads for all to public using(true) with check(true);
    grant all on public.appointments_leads to anon, authenticated, service_role;
    grant all on sequence public.appointments_leads_id_seq to anon, authenticated, service_role;
    insert into public.appointments_leads(user_id,platform,business_id,ai_summary) values
      ('${claim}','${platform}',1101,'{"type":"cancellation_operation_claim","status":"processing","attempts":1}'),
      ('lead-b','whatsapp',1102,'{"type":"pending_booking"}');
    ${bookingMigration}
    commit;`);
});
after(() => {
  try { if (started) successful(command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'])); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('before: recorded allow_all grants let anonymous callers read and tamper with backend claims', () => {
  assert.equal(sql(`begin; set local role anon;
    select count(*) from public.appointments_leads;
    update public.appointments_leads set ai_summary='{"status":"failed"}' where user_id='${claim}';
    select ai_summary from public.appointments_leads where user_id='${claim}'; rollback;`), '2\n{"status":"failed"}');
});
test('draft closes table/sequence access, preserves rows/index/RPC, and safely reapplies', () => {
  const rows = snapshot(), rpc = functionSnapshot();
  // Also test PUBLIC privilege inheritance, beyond the observed explicit grants.
  sql('grant all on public.appointments_leads to public; grant all on sequence public.appointments_leads_id_seq to public;');
  sql(migration); sql(migration);
  assert.equal(snapshot(), rows); assert.equal(functionSnapshot(), rpc);
  assert.equal(sql("select relrowsecurity and not exists(select 1 from pg_policy where polrelid=c.oid) from pg_class c where c.oid='public.appointments_leads'::regclass;"), 't');
  assert.equal(sql("select count(*) from pg_indexes where schemaname='public' and indexname='appointments_leads_idempotency_user_id_uidx';"), '1');
});
for (const role of ['anon', 'authenticated']) {
  for (const [name, statement] of [
    ['read claims, recovery and ordinary leads', 'select * from public.appointments_leads'],
    ['insert a forged claim', "insert into public.appointments_leads(user_id,platform,ai_summary) values('forged','idempotency:whatsapp','{}')"],
    ['overwrite an existing claim', `update public.appointments_leads set ai_summary='{}' where user_id='${claim}'`],
    ['delete an existing claim', `delete from public.appointments_leads where user_id='${claim}'`],
    ['read claim payload through a column grant', 'select ai_summary from public.appointments_leads'],
    ['truncate backend state', 'truncate public.appointments_leads'],
    ['advance the identity sequence', "select nextval('public.appointments_leads_id_seq')"],
    ['rewind the identity sequence', "select setval('public.appointments_leads_id_seq',1,false)"],
    ['invoke the claim-writing booking RPC', "select * from public.finalize_booking_result_outbox('x','y','{}','op',1101,'telegram','c','s','b','e','cal',now(),now()+interval '1 hour','{}','Done')"],
  ]) test(`${role}: cannot ${name}`, () => denied(role, statement));
}
for (const channel of ['telegram', 'whatsapp', 'instagram', 'messenger']) {
  test(`service_role/${channel}: ordinary lead capture, CRM read/update and removal retain generated IDs`, () => {
    assert.equal(sql(`begin; set local role service_role;
      insert into public.appointments_leads(user_id,platform,business_id,customer_name,phone_number)
        values('customer-${channel}','${channel}',1101,'Synthetic Customer','0000000');
      update public.appointments_leads set raw_feedback='Synthetic feedback' where user_id='customer-${channel}' and business_id=1101;
      select count(*) from public.appointments_leads where user_id='customer-${channel}' and business_id=1101 and id>0 and raw_feedback='Synthetic feedback';
      delete from public.appointments_leads where user_id='customer-${channel}' and business_id=1101;
      rollback;`), '1');
  });
  test(`service_role/${channel}: pending-booking checkpoint restores and clears with tenant/owner predicates`, () => {
    assert.equal(sql(`begin; set local role service_role;
      insert into public.appointments_leads(user_id,platform,business_id,ai_summary)
        values('pending-${channel}','${channel}',1101,'{"type":"pending_booking","business_id":"1101"}');
      select count(*) from public.appointments_leads where user_id='pending-${channel}' and platform='${channel}' and business_id=1101;
      update public.appointments_leads set ai_summary=null where user_id='pending-${channel}' and platform='${channel}' and business_id=1101;
      select count(*) from public.appointments_leads where user_id='pending-${channel}' and business_id=1101 and ai_summary is null;
      rollback;`), '1\n1');
  });
}
test('service_role: durable manual-resolution payload retains exact identity and old attempt cannot settle it', () => {
  assert.equal(sql(`begin; set local role service_role;
    update public.appointments_leads set ai_summary='{"status":"manual_resolution","cancellation":{"calendarId":"synthetic-calendar","eventId":"synthetic-event","feeAmount":250}}'
      where user_id='${claim}' and platform='${platform}' and ai_summary='{"type":"cancellation_operation_claim","status":"processing","attempts":1}';
    with old_attempt as (update public.appointments_leads set ai_summary='{"status":"failed"}' where user_id='${claim}' and platform='${platform}'
      and ai_summary='{"type":"cancellation_operation_claim","status":"processing","attempts":1}' returning *) select count(*) from old_attempt;
    select (ai_summary::jsonb->>'status') from public.appointments_leads where user_id='${claim}' and platform='${platform}';
    rollback;`), '0\nmanual_resolution');
});
test('service_role: idempotency uniqueness rejects duplicated backend operation identities', () => {
  const result = sql(`begin; set local role service_role; insert into public.appointments_leads(user_id,platform) values('${claim}','${platform}'); rollback;`, false);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /23505: duplicate key/u);
});
test('service_role: unchanged booking-finalization RPC atomically settles claim, reservation and outbox', () => {
  assert.equal(sql(`begin; set local role service_role;
    select count(*) from public.claim_booking_slot_reservation(1101,'synthetic-calendar','2027-01-01T18:00:00Z','2027-01-01T18:45:00Z','synthetic-op','synthetic-customer',now()+interval '5 minutes');
    select count(*) from public.finalize_booking_result_outbox('${claim}','${platform}','{"status":"completed"}','synthetic-op',1101,'telegram','synthetic-customer','synthetic-session','synthetic-booking','synthetic-event','synthetic-calendar','2027-01-01T18:00:00Z','2027-01-01T18:45:00Z','{"verified":true}','Synthetic verified booking');
    select ai_summary::jsonb->>'status' from public.appointments_leads where user_id='${claim}';
    select status from public.booking_slot_reservations where operation_id='synthetic-op';
    select status from public.booking_result_outbox where operation_id='synthetic-op'; rollback;`), '1\n1\ncompleted\nsettled\npending');
});
test('existing Instagram completed-result upsert lacks a matching unique constraint (unchanged limitation)', () => {
  const result = sql(`begin; set local role service_role;
    insert into public.appointments_leads(user_id,platform,business_id,ai_summary)
      values('cancelresult_synthetic','operation:instagram',1101,'{"operationType":"cancel"}')
      on conflict(user_id) do update set ai_summary=excluded.ai_summary; rollback;`, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /42P10: there is no unique or exclusion constraint/u);
});
test('default-deny RLS still blocks clients if table grants are accidentally reintroduced', () => {
  assert.equal(sql(`begin; grant select,insert,update,delete on public.appointments_leads to anon;
    set local role anon; select count(*) from public.appointments_leads; rollback;`), '0');
  const result = sql(`begin; grant insert on public.appointments_leads to authenticated;
    set local role authenticated; insert into public.appointments_leads(user_id) values('blocked'); rollback;`, false);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /42501: new row violates row-level security/u);
});
test('unexpected column grants abort the entire correction instead of leaving client access', () =>
  driftRejected('grant select(ai_summary) on public.appointments_leads to anon', 'appointments_leads_client_access_foundation_changed'));
test('unexpected inherited client grants abort the correction', () =>
  driftRejected('create role inherited_access; grant inherited_access to authenticated', 'appointments_leads_client_access_foundation_changed'));
test('unexpected client policy aborts the correction', () =>
  driftRejected('create policy unexpected_access on public.appointments_leads for select to authenticated using(true)', 'appointments_leads_client_access_foundation_changed'));
test('missing privileged backend role aborts the correction', () =>
  driftRejected('alter role service_role nobypassrls', 'appointments_leads_backend_roles_require_review'));
test('unexpected identity sequence aborts the correction', () =>
  driftRejected('alter sequence public.appointments_leads_id_seq rename to unexpected_lead_sequence', 'appointments_leads_identity_sequence_changed'));
