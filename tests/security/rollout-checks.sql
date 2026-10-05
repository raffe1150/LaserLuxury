-- READ ONLY. Run immediately before each approved step and after it.
-- Store output securely; no provider values/customer rows are selected.
SELECT b.id,
 count(m.id) FILTER (WHERE m.status='active' AND u.id IS NOT NULL
   AND m.role IN ('owner','admin','manager','agent','viewer')) AS active_authorized_members,
 count(m.id) FILTER (WHERE m.status='active' AND m.role='owner' AND u.id IS NOT NULL) AS active_owners
FROM public.businesses b LEFT JOIN public.business_memberships m ON m.business_id=b.id
LEFT JOIN auth.users u ON u.id=m.user_id GROUP BY b.id ORDER BY b.id;
SELECT
 (SELECT count(*) FROM public.business_memberships m LEFT JOIN public.businesses b ON b.id=m.business_id WHERE b.id IS NULL) AS orphan_memberships,
 (SELECT count(*) FROM public.business_memberships m LEFT JOIN auth.users u ON u.id=m.user_id WHERE u.id IS NULL) AS missing_auth_users,
 (SELECT count(*) FROM (SELECT business_id,user_id FROM public.business_memberships GROUP BY business_id,user_id HAVING count(*)>1) x) AS duplicate_pairs,
 (SELECT count(*) FROM public.business_memberships WHERE business_id<=0
   OR role NOT IN ('owner','admin','manager','agent','viewer')
   OR status NOT IN ('active','invited','suspended','revoked') OR updated_at<created_at) AS invalid_memberships;
SELECT current_setting('server_version') AS postgres_version,
 pg_get_serial_sequence('public.businesses','id') AS business_sequence;
SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl
FROM pg_class c WHERE c.oid IN ('public.businesses'::regclass,'public.salons'::regclass,
 'public.business_memberships'::regclass,'public.businesses_id_seq'::regclass) ORDER BY c.relname;
SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('businesses','salons','business_memberships') ORDER BY tablename,policyname;
SELECT c.relname,a.attname,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
WHERE c.oid IN ('public.businesses'::regclass,'public.salons'::regclass,'public.business_memberships'::regclass)
 AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL;
SELECT r.rolname,r.rolbypassrls,r.rolsuper FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role');
SELECT member.rolname AS member,parent.rolname AS granted_role FROM pg_auth_members m
JOIN pg_roles member ON member.oid=m.member JOIN pg_roles parent ON parent.oid=m.roleid
WHERE member.rolname IN ('anon','authenticated');
SELECT c.relname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
 a.privilege_type,a.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(
 CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
WHERE c.oid IN ('public.businesses'::regclass,'public.salons'::regclass,
 'public.business_memberships'::regclass,'public.businesses_id_seq'::regclass)
ORDER BY c.relname,grantee,a.privilege_type;
SELECT conrelid::regclass AS referencing_table,conname,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid IN ('public.businesses'::regclass,'public.salons'::regclass,'public.business_memberships'::regclass)
 OR confrelid IN ('public.businesses'::regclass,'public.salons'::regclass) ORDER BY conrelid::regclass::text,conname;
SELECT count(*) AS salon_rows,count(*) FILTER(WHERE salon_name='chichi' AND business_id='chi') AS legacy_row
FROM public.salons;
SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,p.prosecdef,p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
 AND p.prosrc ~* '\m(businesses|salons)\M';
SELECT schemaname,viewname FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema') AND definition ~* '\m(businesses|salons)\M';
SELECT schemaname,matviewname FROM pg_matviews WHERE definition ~* '\m(businesses|salons)\M';
SELECT t.tgrelid::regclass AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.businesses'::regclass,'public.salons'::regclass,'public.business_memberships'::regclass);
SELECT pg_describe_object(d.classid,d.objid,d.objsubid) AS dependent,d.deptype,
 d.refobjid::regclass AS referenced FROM pg_depend d
WHERE d.refobjid IN ('public.businesses'::regclass,'public.salons'::regclass) ORDER BY referenced,dependent;
SELECT schemaname,tablename FROM pg_publication_tables WHERE tablename IN ('businesses','salons');
SELECT version FROM supabase_migrations.schema_migrations WHERE version IN (
 '20261005095355','20261005111021','20261005111029','20261004130125','20261004201036') ORDER BY version;
