-- PREPARED ONLY: requires a separate approved rollout; do not apply in this task.
-- Preserve the legacy row/key, UUID schema and protected service-backed APIs.
-- No RLS enablement, mapping, conversion, deletion or table removal here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls) then
    raise exception 'salons_backend_role_not_privileged';
  end if;
  -- Refuse unexpected access foundations rather than silently leaving a bypass.
  if exists (select 1 from pg_attribute
      where attrelid = 'public.salons'::regclass and attacl is not null)
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname in ('anon', 'authenticated')) then
    raise exception 'salons_client_grants_require_review';
  end if;
end $$;

revoke all on table public.salons from public, anon, authenticated;
-- CRUD supports existing endpoints and privileged operational maintenance.
revoke all on table public.salons from service_role;
grant select, insert, update, delete on table public.salons to service_role;
commit;
