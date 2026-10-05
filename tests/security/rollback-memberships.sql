-- Restores the inspected baseline without deleting membership rows.
-- SECURITY EXPOSURE: allows orphan memberships and client TRUNCATE again.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.business_memberships DROP CONSTRAINT business_memberships_business_id_fkey;
COMMENT ON COLUMN public.business_memberships.business_id IS 'Business bigint identifier. Deliberately not foreign-keyed so membership cannot block operational business deletion.';
REVOKE ALL ON public.business_memberships FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER ON public.business_memberships TO anon, authenticated;
-- MAINTAIN was present in the inspected PostgreSQL 17 ACL.
DO $$ BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    EXECUTE 'GRANT MAINTAIN ON public.business_memberships TO anon, authenticated';
  END IF;
END $$;
GRANT ALL ON public.business_memberships TO service_role;
COMMIT;
