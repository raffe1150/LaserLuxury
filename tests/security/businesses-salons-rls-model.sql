-- Audit experiment, NOT a migration or a complete production-schema test.
-- Run only in a disposable local database named odinlink_rls_audit.
-- Models backend-only access; real API membership checks have separate tests.
\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'odinlink_rls_audit'
     OR to_regclass('public.businesses') IS NOT NULL
     OR to_regclass('public.salons') IS NOT NULL THEN
    RAISE EXCEPTION 'requires an empty disposable odinlink_rls_audit database';
  END IF;
END $$;

CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.businesses (
  id bigint PRIMARY KEY,
  business_name text NOT NULL,
  telegram_bot_token text
);
CREATE TABLE public.salons (
  id uuid PRIMARY KEY,
  business_id text NOT NULL UNIQUE,
  salon_name text NOT NULL
);
INSERT INTO public.businesses VALUES (1, 'Tenant A', 'synthetic-a'), (2, 'Tenant B', 'synthetic-b');
INSERT INTO public.salons VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '1', 'Salon A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2', 'Salon B');
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salons ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.businesses, public.salons TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses, public.salons TO service_role;

CREATE FUNCTION public.audit_assert(condition boolean, label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END $$;
CREATE FUNCTION public.audit_expect_denied(command text, label text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL: % was allowed', label;
END $$;

-- RLS alone defaults to deny even if old CRUD grants survive.
SET LOCAL ROLE anon;
SELECT public.audit_assert((SELECT count(*) FROM public.businesses) = 0, 'RLS denies anonymous business rows');
SELECT public.audit_assert((SELECT count(*) FROM public.salons) = 0, 'RLS denies anonymous salon rows');
RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.audit_assert((SELECT count(*) FROM public.businesses WHERE id = 2) = 0, 'tenant A cannot read tenant B business');
SELECT public.audit_assert((SELECT count(*) FROM public.salons WHERE business_id = '2') = 0, 'tenant A cannot read tenant B salon');
WITH changed AS (UPDATE public.businesses SET business_name = 'tampered' WHERE id = 2 RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM changed) = 0, 'tenant A cannot update tenant B business');
WITH changed AS (UPDATE public.salons SET salon_name = 'tampered' WHERE business_id = '2' RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM changed) = 0, 'tenant A cannot update tenant B salon');
SET LOCAL request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SELECT public.audit_assert((SELECT count(*) FROM public.businesses WHERE id = 1) = 0, 'tenant B cannot read tenant A business');
SELECT public.audit_assert((SELECT count(*) FROM public.salons WHERE business_id = '1') = 0, 'tenant B cannot read tenant A salon');
RESET ROLE;

-- Final proposed boundary: revoke ALL, including privileges outside RLS.
REVOKE ALL ON public.businesses, public.salons FROM PUBLIC, anon, authenticated;
SET LOCAL ROLE anon;
SELECT public.audit_expect_denied('SELECT telegram_bot_token FROM public.businesses', 'anonymous credential read denied');
SELECT public.audit_expect_denied('SELECT * FROM public.salons', 'anonymous salon read denied');
SELECT public.audit_expect_denied('INSERT INTO public.businesses VALUES (3, ''fake'', ''fake'')', 'anonymous business insert denied');
SELECT public.audit_expect_denied('INSERT INTO public.salons VALUES (''cccccccc-cccc-4ccc-8ccc-cccccccccccc'', ''3'', ''fake'')', 'anonymous salon insert denied');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT public.audit_expect_denied('SELECT telegram_bot_token FROM public.businesses', 'authenticated direct credential read denied');
SELECT public.audit_expect_denied('UPDATE public.businesses SET business_name = ''fake'' WHERE id = 2', 'authenticated business update denied');
SELECT public.audit_expect_denied('UPDATE public.salons SET salon_name = ''fake'' WHERE business_id = ''2''', 'authenticated salon update denied');
SELECT public.audit_expect_denied('DELETE FROM public.businesses WHERE id = 2', 'authenticated business delete denied');
SELECT public.audit_expect_denied('DELETE FROM public.salons WHERE business_id = ''2''', 'authenticated salon delete denied');
SELECT public.audit_expect_denied('TRUNCATE public.businesses', 'business truncate denied independently of RLS');
SELECT public.audit_expect_denied('TRUNCATE public.salons', 'salon truncate denied independently of RLS');
RESET ROLE;

-- A non-superuser service role bypasses RLS with explicit CRUD privileges.
SET LOCAL ROLE service_role;
SELECT public.audit_assert((SELECT count(*) FROM public.businesses) = 2, 'service role reads businesses through RLS');
SELECT public.audit_assert((SELECT count(*) FROM public.salons) = 2, 'service role reads salons through RLS');
WITH inserted AS (INSERT INTO public.businesses VALUES (3, 'Tenant C', 'synthetic-c') RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM inserted) = 1, 'service role inserts business');
WITH inserted AS (INSERT INTO public.salons VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '3', 'Salon C') RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM inserted) = 1, 'service role inserts salon');
WITH changed AS (UPDATE public.businesses SET business_name = 'Tenant C updated' WHERE id = 3 RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM changed) = 1, 'service role updates business');
WITH changed AS (UPDATE public.salons SET salon_name = 'Salon C updated' WHERE business_id = '3' RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM changed) = 1, 'service role updates salon');
WITH removed AS (DELETE FROM public.salons WHERE business_id = '3' RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM removed) = 1, 'service role deletes salon');
WITH removed AS (DELETE FROM public.businesses WHERE id = 3 RETURNING id)
SELECT public.audit_assert((SELECT count(*) FROM removed) = 1, 'service role deletes business');
SELECT public.audit_assert((SELECT business_name FROM public.businesses WHERE id = 2) = 'Tenant B', 'denied mutation preserved other business');
SELECT public.audit_assert((SELECT salon_name FROM public.salons WHERE business_id = '2') = 'Salon B', 'denied mutation preserved other salon');
RESET ROLE;
ROLLBACK;
