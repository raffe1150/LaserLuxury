create table public.business_memberships (
  id uuid primary key default gen_random_uuid(),
  business_id bigint not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,

  constraint business_memberships_business_user_key unique (business_id, user_id),
  constraint business_memberships_business_id_positive check (business_id > 0),
  constraint business_memberships_role_valid check (
    role = btrim(role)
    and role in ('owner', 'admin', 'manager', 'agent', 'viewer')
  ),
  constraint business_memberships_status_valid check (
    status = btrim(status)
    and status in ('active', 'invited', 'suspended', 'revoked')
  ),
  constraint business_memberships_timestamps_valid check (updated_at >= created_at)
);

comment on table public.business_memberships is
  'Authoritative mapping between Supabase Auth users and OdinLink businesses.';

comment on column public.business_memberships.business_id is
  'Business bigint identifier. Deliberately not foreign-keyed so membership cannot block operational business deletion.';

create index business_memberships_user_status_business_idx
  on public.business_memberships (user_id, status, business_id);

create index business_memberships_business_status_user_idx
  on public.business_memberships (business_id, status, user_id);

create function public.set_business_membership_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at = greatest(now(), new.created_at);
  return new;
end;
$$;

create trigger business_memberships_set_updated_at
before update on public.business_memberships
for each row
execute function public.set_business_membership_updated_at();

alter table public.business_memberships enable row level security;

create policy business_memberships_read_own_active
  on public.business_memberships
  for select
  to authenticated
  using (auth.uid() = user_id and status = 'active');

revoke insert, update, delete on public.business_memberships from anon, authenticated;
grant select on public.business_memberships to authenticated;

create function public.create_business_with_owner(
  p_owner_user_id uuid,
  p_business_name text,
  p_telegram_bot_token text,
  p_google_calendar_id text,
  p_custom_system_prompt text,
  p_instagram_page_id text,
  p_instagram_account_id text,
  p_instagram_access_token text,
  p_instagram_verify_token text,
  p_instagram_enabled boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  created_business public.businesses%rowtype;
begin
  if p_owner_user_id is null then
    raise exception using errcode = '22004', message = 'owner_user_id_required';
  end if;

  if nullif(btrim(p_business_name), '') is null then
    raise exception using errcode = '22023', message = 'business_name_required';
  end if;

  insert into public.businesses (
    business_name,
    telegram_bot_token,
    google_calendar_id,
    custom_system_prompt,
    instagram_page_id,
    instagram_account_id,
    instagram_access_token,
    instagram_verify_token,
    instagram_enabled
  )
  values (
    btrim(p_business_name),
    coalesce(p_telegram_bot_token, ''),
    coalesce(p_google_calendar_id, ''),
    coalesce(p_custom_system_prompt, ''),
    coalesce(p_instagram_page_id, ''),
    coalesce(p_instagram_account_id, ''),
    coalesce(p_instagram_access_token, ''),
    coalesce(p_instagram_verify_token, ''),
    coalesce(p_instagram_enabled, false)
  )
  returning * into created_business;

  insert into public.business_memberships (
    business_id,
    user_id,
    role,
    status,
    created_by
  )
  values (
    created_business.id,
    p_owner_user_id,
    'owner',
    'active',
    p_owner_user_id
  );

  return jsonb_build_object(
    'id', created_business.id,
    'business_name', created_business.business_name,
    'industry', created_business.industry,
    'timezone', created_business.timezone,
    'language', created_business.language,
    'custom_system_prompt', created_business.custom_system_prompt,
    'google_calendar_id', created_business.google_calendar_id,
    'instagram_page_id', created_business.instagram_page_id,
    'instagram_account_id', created_business.instagram_account_id,
    'messenger_page_id', created_business.messenger_page_id,
    'whatsapp_phone_number_id', created_business.whatsapp_phone_number_id,
    'whatsapp_business_account_id', created_business.whatsapp_business_account_id
  );
end;
$$;

create function public.delete_business_with_memberships(p_business_id bigint)
returns boolean
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  deleted_business_count integer;
begin
  if p_business_id is null or p_business_id <= 0 then
    raise exception using errcode = '22023', message = 'invalid_business_id';
  end if;

  perform 1
  from public.businesses
  where id = p_business_id
  for update;

  if not found then
    return false;
  end if;

  delete from public.business_memberships
  where business_id = p_business_id;

  delete from public.businesses
  where id = p_business_id;

  get diagnostics deleted_business_count = row_count;
  if deleted_business_count <> 1 then
    raise exception using errcode = 'P0001', message = 'business_delete_failed';
  end if;

  return true;
end;
$$;

revoke all on function public.set_business_membership_updated_at() from public, anon, authenticated;
revoke all on function public.create_business_with_owner(uuid, text, text, text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.delete_business_with_memberships(bigint) from public, anon, authenticated;

grant execute on function public.create_business_with_owner(uuid, text, text, text, text, text, text, text, text, boolean) to service_role;
grant execute on function public.delete_business_with_memberships(bigint) to service_role;
