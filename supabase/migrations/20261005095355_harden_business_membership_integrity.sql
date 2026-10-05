-- PREPARED ONLY. Do not apply as part of the RLS prerequisite audit.
-- Recheck orphan count before approval. No owner assignment or tenant-table RLS.
alter table public.business_memberships
  add constraint business_memberships_business_id_fkey
  foreign key (business_id) references public.businesses(id)
  on delete cascade
  not valid;

-- Existing unique/business-status indexes already lead with business_id.
-- Validation preserves all rows and checks the existing relationship.
alter table public.business_memberships
  validate constraint business_memberships_business_id_fkey;

comment on column public.business_memberships.business_id is
  'Authoritative business identifier; FK cascade preserves operational business deletion.';

-- RLS does not protect TRUNCATE. Remove surplus client/default privileges.
revoke all on table public.business_memberships from public, anon, authenticated;
grant select on table public.business_memberships to authenticated;
grant select, insert, update, delete on table public.business_memberships to service_role;
