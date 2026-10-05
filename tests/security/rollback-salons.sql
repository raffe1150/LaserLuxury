-- SECURITY EXPOSURE: restores unrestricted client access to legacy salons.
-- Exact baseline ACL only; no row changes and no RLS changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
REVOKE ALL ON public.salons FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.salons TO anon, authenticated, service_role;
COMMIT;
