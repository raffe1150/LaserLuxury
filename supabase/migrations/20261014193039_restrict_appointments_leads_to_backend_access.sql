-- PREPARED ONLY: production application requires separate human approval.
-- Lead/CRM APIs and channel state use the server service role; clients use Auth
-- and verified business-scoped HTTP APIs, never this mixed backend state table.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.appointments_leads in access exclusive mode;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls)
    or exists (select 1 from pg_roles where rolname in ('anon', 'authenticated')
      and (rolsuper or rolbypassrls)) then
    raise exception 'appointments_leads_backend_roles_require_review';
  end if;
  -- These foundations were inspected in production. Refuse new access paths
  -- rather than silently leaving inherited/column grants or unknown policies.
  if exists (select 1 from pg_attribute
      where attrelid = 'public.appointments_leads'::regclass and attacl is not null)
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname in ('anon', 'authenticated'))
    or exists (select 1 from pg_policy
      where polrelid = 'public.appointments_leads'::regclass and polname <> 'allow_all') then
    raise exception 'appointments_leads_client_access_foundation_changed';
  end if;
  if pg_get_serial_sequence('public.appointments_leads', 'id')
      is distinct from 'public.appointments_leads_id_seq' then
    raise exception 'appointments_leads_identity_sequence_changed';
  end if;
end $$;

revoke all on table public.appointments_leads from public, anon, authenticated;
revoke all on sequence public.appointments_leads_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.appointments_leads to service_role;
grant usage on sequence public.appointments_leads_id_seq to service_role;
alter table public.appointments_leads enable row level security;
drop policy if exists allow_all on public.appointments_leads;
-- No client policies: default-deny RLS and revoked grants protect ordinary leads,
-- pending bookings, operation results, claims, recovery journals and test records.
-- Preserve rows, unique indexes, RPC definitions and existing backend privileges.
commit;
