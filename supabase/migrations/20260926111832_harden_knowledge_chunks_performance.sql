create index knowledge_chunks_source_business_idx
  on public.knowledge_chunks (source_id, business_id);

drop policy if exists knowledge_chunks_read_active_business_member
  on public.knowledge_chunks;

create policy knowledge_chunks_read_active_business_member
  on public.knowledge_chunks
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.business_memberships bm
      where bm.business_id = knowledge_chunks.business_id
        and bm.user_id = (select auth.uid())
        and bm.status = 'active'
    )
  );
