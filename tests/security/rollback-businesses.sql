-- Emergency rollback to the ACL/RLS state inspected on 2026-10-05.
-- SECURITY EXPOSURE: restores unrestricted client access, including credentials.
-- Use only after explicit operator approval and a fresh prior-state comparison.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.businesses DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.businesses FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.businesses TO anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.businesses_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON SEQUENCE public.businesses_id_seq TO anon, authenticated, service_role;
COMMIT;
