-- PREPARED ONLY: no execution until the code/consumer/staging gates are approved.
-- Run after the prepared membership FK/grant hardening migration.
-- Clients use verified membership-checked APIs; no client policies are needed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'businesses_backend_role_not_privileged';
  end if;
  if not exists (select 1 from pg_constraint
      where conrelid = 'public.business_memberships'::regclass
        and confrelid = 'public.businesses'::regclass
        and contype = 'f' and convalidated) then
    raise exception 'businesses_membership_fk_not_validated';
  end if;
  if exists (select 1 from public.businesses b where not exists (
      select 1 from public.business_memberships m join auth.users u on u.id = m.user_id
      where m.business_id = b.id and m.status = 'active'
        and m.role in ('owner', 'admin', 'manager', 'agent', 'viewer'))) then
    raise exception 'businesses_active_membership_missing';
  end if;
  if exists (select 1 from public.business_memberships m
      left join public.businesses b on b.id = m.business_id where b.id is null) then
    raise exception 'businesses_orphan_membership';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.businesses'::regclass)
    or exists (select 1 from pg_attribute
      where attrelid = 'public.businesses'::regclass and attacl is not null)
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname in ('anon', 'authenticated')) then
    raise exception 'businesses_client_access_foundation_changed';
  end if;
  if pg_get_serial_sequence('public.businesses', 'id') is distinct from 'public.businesses_id_seq' then
    raise exception 'businesses_identity_sequence_changed';
  end if;
end $$;

revoke all on table public.businesses from public, anon, authenticated;
revoke all on sequence public.businesses_id_seq from public, anon, authenticated;
revoke all on table public.businesses from service_role;
grant select, insert, update, delete on table public.businesses to service_role;
revoke all on sequence public.businesses_id_seq from service_role;
grant usage on sequence public.businesses_id_seq to service_role;
alter table public.businesses enable row level security;
-- No USING(true), client policies, provider-field grants or user-controlled scope.
-- service_role BYPASSRLS plus the explicit grants preserves backend CRUD/RPCs.
commit;
