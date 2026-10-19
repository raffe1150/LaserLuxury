#!/usr/bin/env python3
"""Real SQL contract tests. Creates/stops its OWN initdb cluster, Unix socket only.
Never reads project env, accepts a DB URL or connects to any existing database.
Python stdlib + installed PostgreSQL CLI only. No remote Supabase/Booking calls.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
FOUNDATION = ROOT / 'docs/designs/p2-knowledge-foundation/20261019084642_minimal_p2_knowledge_foundation.sql.draft'
EXTENSION = ROOT / 'docs/designs/async-knowledge-slice1/20261019081511_async_knowledge_lifecycle_slice1.sql.draft'
INPUT = {'question': 'Where can I park?', 'language': 'en', 'history': []}
RESULT = {'protocol': 'evidence-first-v2', 'independentlyVerified': True, 'completeRequiredFacts': True,
          'text': 'Use the paid car park.', 'sources': [{'id': 'doc-1', 'revision': 'v1'}]}


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def jb(value):
    return literal(json.dumps(value, ensure_ascii=False)) + '::jsonb'


class LocalCluster:
    def __init__(self):
        for binary in ['initdb', 'pg_ctl', 'psql']:
            if not shutil.which(binary):
                raise RuntimeError('Disposable PostgreSQL unavailable: missing ' + binary)
        self.temp = tempfile.TemporaryDirectory(prefix='odin-p2-')
        self.path = Path(self.temp.name)
        self.data = self.path / 'data'
        self.socket = self.path / 'socket'
        self.socket.mkdir(mode=0o700)
        # Do not inherit PGHOST/PGSERVICE/PGOPTIONS or any production URL.
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        self.env['LC_ALL'] = 'C'
        subprocess.run(['initdb', '-D', str(self.data), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8'],
                       env=self.env, check=True, capture_output=True)
        subprocess.run(['pg_ctl', '-D', str(self.data), '-l', str(self.path / 'postgres.log'), '-o',
                        "-h '' -k " + str(self.socket) + ' -p 55439', '-w', 'start'], env=self.env, check=True, capture_output=True)
        self.started = True

    def sql(self, query, db='postgres', role='postgres', error=False):
        proc = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.socket), '-p', '55439', '-U', 'postgres', '-d', db],
                              input=('SET ROLE ' + role + ';\n' + query), text=True, env=self.env, capture_output=True, timeout=25)
        if error:
            if proc.returncode == 0:
                raise AssertionError('Expected SQL rejection: ' + query[:100])
            return proc.stderr
        if proc.returncode:
            raise AssertionError(proc.stderr + '\nSQL: ' + query[:250])
        return proc.stdout.strip()

    def close(self):
        if getattr(self, 'started', False):
            subprocess.run(['pg_ctl', '-D', str(self.data), '-m', 'immediate', '-w', 'stop'], env=self.env, capture_output=True, check=True)
            self.started = False
        self.temp.cleanup()

    def restart(self):
        subprocess.run(['pg_ctl','-D',str(self.data),'-l',str(self.path/'postgres.log'),'-m','fast',
                        '-o',"-h '' -k "+str(self.socket)+' -p 55439','-w','restart'],
                       env=self.env,check=True,capture_output=True)


class FoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = LocalCluster()
        cls.addClassCleanup(cls.pg.close)
        cls.pg.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE DATABASE foundation_test;")
        # Synthetic existing tenant + real repository Booking DDL/RPCs. This is
        # a clean local fixture, NOT a dump or copy of any customer data.
        cls.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY); INSERT INTO public.businesses VALUES(77),(88); '
                   'CREATE TABLE public.appointments_leads(user_id text,platform text,ai_summary text);', db='foundation_test')
        cls.pg.sql((ROOT / 'supabase/migrations/20260921120000_add_booking_slot_reservations_and_result_outbox.sql').read_text(), db='foundation_test')
        cls.booking_before = cls.booking_fingerprint()
        # Simulate hosted implicit client defaults; migrations must revoke them.
        cls.pg.sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;', db='foundation_test')
        cls.pg.sql("SET odin.approved_p2_knowledge_foundation='yes';\n" + FOUNDATION.read_text(), db='foundation_test')
        cls.pg.sql("SET odin.approved_knowledge_slice1='yes';\n" + EXTENSION.read_text(), db='foundation_test')
        cls.version = cls.pg.sql('SHOW server_version;')
        print('Disposable PostgreSQL '+cls.version+'; private Unix socket, TCP disabled; migrations applied locally only.',flush=True)

    @classmethod
    def tearDownClass(cls):
        cls.pg.close()

    @classmethod
    def booking_fingerprint(cls):
        q = """SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb)::text FROM (
          SELECT jsonb_build_object('table',c.relname,'acl',c.relacl,'rls',c.relrowsecurity,'columns',
            (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) x
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('booking_result_outbox','booking_slot_reservations','appointments_leads')
          UNION ALL SELECT jsonb_build_object('function',p.proname,'ddl',pg_get_functiondef(p.oid),'acl',p.proacl) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prokind='f' AND p.proname LIKE '%booking%'
          UNION ALL SELECT jsonb_build_object('constraint',conname,'ddl',pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid IN ('public.booking_result_outbox'::regclass,'public.booking_slot_reservations'::regclass)
          UNION ALL SELECT jsonb_build_object('index',indexname,'ddl',indexdef) FROM pg_indexes WHERE tablename IN ('booking_result_outbox','booking_slot_reservations')
          UNION ALL SELECT jsonb_build_object('rows',jsonb_agg(to_jsonb(b))) FROM public.booking_result_outbox b
          UNION ALL SELECT jsonb_build_object('rows',jsonb_agg(to_jsonb(b))) FROM public.booking_slot_reservations b
        ) s;"""
        return hashlib.sha256(cls.pg.sql(q, db='foundation_test').encode()).hexdigest()

    def sql(self, query, role='service_role', error=False):
        return self.pg.sql(query, db='foundation_test', role=role, error=error)

    def conversation(self, business=77):
        cid = str(uuid.uuid4())
        self.sql(f"INSERT INTO public.odin_conversations(id,business_id,conversation_key) VALUES({literal(cid)},{business},{literal('whatsapp:acct:'+cid)});")
        return cid

    def accept(self, cid, event=None, business=77, account='acct', input_=INPUT, ms=40000):
        args = [str(business), literal(cid), "'whatsapp'", literal(account), literal(event or str(uuid.uuid4())), jb(input_) if input_ is not None else 'NULL', str(ms)]
        return json.loads(self.sql('SELECT public.odin_accept_knowledge_turn_v1(' + ','.join(args) + ');'))

    def command_sql(self, cid, task, command, args=None, business=77, account='acct'):
        return 'SELECT public.odin_transition_knowledge_v1(' + ','.join([str(business), literal(cid), literal(task), "'whatsapp'", literal(account), literal(command), jb(args or {})]) + ');'

    def command(self, cid, task, command, args=None, **kw):
        raw = self.sql(self.command_sql(cid, task, command, args, **kw))
        return json.loads(raw) if raw else None

    def running(self, lease=5000, ms=40000):
        cid = self.conversation(); a = self.accept(cid, ms=ms); tid = a['task']['id']
        task = self.command(cid, tid, 'claim', {'owner': 'worker-a', 'leaseMs': lease})
        return cid, tid, task

    def receipt(self, cid, task, phase='finalize', allowed=True):
        # The live source/verifier bridge is deliberately not implemented here.
        # This local service-only fixture supplies an attestation to test DB gates.
        now = self.sql('SELECT clock_timestamp();')
        return {'allowed': allowed, 'businessId': 77, 'channel': 'whatsapp', 'account': 'acct', 'conversationId': cid,
                'taskId': task['id'], 'turnId': task['knowledge_turn_id'], 'sequence': task['knowledge_sequence'],
                'resultDigest': task['knowledge_result_digest'], 'phase': phase, 'checkedAt': now}

    def verified(self):
        cid, tid, t = self.running()
        args = {'owner': 'worker-a', 'fence': t['knowledge_fence'], 'result': RESULT}
        v = self.command(cid, tid, 'verified', args)
        return cid, tid, v

    def final(self):
        cid, tid, t = self.verified()
        d = self.command(cid, tid, 'finalize', {'owner': 'worker-a', 'fence': t['knowledge_fence'], 'authority': self.receipt(cid, t)})
        return cid, tid, t, d

    def test_01_foundation_and_extension_applied_with_no_client_exposure(self):
        self.assertEqual(self.sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('odin_inbox','odin_tasks','odin_conversations','odin_outbox') AND c.relrowsecurity;"), '4')
        for role in ['anon', 'authenticated']:
            for table in ['odin_inbox', 'odin_tasks', 'odin_conversations', 'odin_outbox']:
                self.assertIn('permission denied', self.sql(f'SELECT * FROM public.{table};', role=role, error=True))
                self.assertIn('permission denied', self.sql(f'DELETE FROM public.{table};', role=role, error=True))
                self.assertIn('permission denied', self.sql(f'INSERT INTO public.{table} DEFAULT VALUES;', role=role, error=True))
                self.assertIn('permission denied', self.sql(f'UPDATE public.{table} SET business_id=88;', role=role, error=True))
            cid = str(uuid.uuid4())
            self.assertIn('permission denied', self.sql(f"SELECT public.odin_accept_knowledge_turn_v1(77,{literal(cid)},'whatsapp','acct','event');", role=role, error=True))
            self.assertIn('permission denied', self.sql(self.command_sql(cid, str(uuid.uuid4()), 'claim'), role=role, error=True))
        self.assertEqual(self.sql("SELECT count(*) FROM pg_policies WHERE tablename IN ('odin_inbox','odin_tasks','odin_conversations','odin_outbox');"), '0')

    def test_02_concurrent_duplicate_acceptance_and_claims(self):
        cid = self.conversation(); event = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            values = list(pool.map(lambda _: self.accept(cid, event), range(2)))
        self.assertEqual(sum(v['inserted'] for v in values), 1)
        self.assertEqual(values[0]['task']['id'], values[1]['task']['id'])
        tid = values[0]['task']['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            claims = list(pool.map(lambda owner: self.command(cid, tid, 'claim', {'owner': owner, 'leaseMs': 5000}), ['a','b']))
        self.assertEqual(sum(v is not None for v in claims), 1)
        self.assertEqual(self.sql(f"SELECT knowledge_sequence FROM public.odin_conversations WHERE id={literal(cid)};"), '1')

    def test_03_lease_takeover_rejects_stale_worker_and_preserves_expiry(self):
        cid, tid, a = self.running(lease=80)
        time.sleep(.1)
        b = self.command(cid, tid, 'claim', {'owner': 'worker-b', 'leaseMs': 5000})
        self.assertGreater(b['knowledge_fence'], a['knowledge_fence'])
        self.assertEqual(a['knowledge_expires_at'], b['knowledge_expires_at'])
        self.assertIsNone(self.command(cid, tid, 'verified', {'owner':'worker-a','fence':a['knowledge_fence'],'result':RESULT}))
        self.assertIsNone(self.command(cid, tid, 'finalize', {'owner':'worker-a','fence':a['knowledge_fence']}))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)};"), '0')

    def test_04_atomic_finalization_and_separate_progress(self):
        cid, tid, t = self.verified()
        p1 = self.command(cid, tid, 'progress', {'text':'Checking the details.'})
        p2 = self.command(cid, tid, 'progress', {'text':'Different acknowledgement.'})
        self.assertEqual(p1['id'],p2['id'])
        d = self.command(cid, tid, 'finalize', {'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)})
        self.assertNotEqual(p1['delivery_key'],d['delivery_key'])
        self.assertEqual(self.sql(f"SELECT knowledge_state FROM public.odin_tasks WHERE id={literal(tid)};"), 'FINALIZED')
        self.assertEqual(self.sql(f"SELECT knowledge_state FROM public.odin_outbox WHERE id={literal(p1['id'])};"), 'SUPERSEDED')
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)}))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)} AND knowledge_kind='final';"),'1')

    def test_05_rollback_after_tentative_outbox_insert(self):
        cid, tid, t = self.verified()
        # Force failure after outbox insertion, on the task state update. Local
        # trigger only; the tested migration is not patched to manufacture success.
        self.sql("CREATE FUNCTION public.test_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.knowledge_state='FINALIZED' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER test_fail_finalize BEFORE UPDATE ON public.odin_tasks FOR EACH ROW EXECUTE FUNCTION public.test_fail_finalize();", role='postgres')
        try:
            error = self.sql(self.command_sql(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)}),error=True)
            self.assertIn('injected commit failure',error)
            self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)};"),'0')
            self.assertEqual(self.sql(f"SELECT knowledge_state FROM public.odin_tasks WHERE id={literal(tid)};"),'VERIFIED')
        finally:
            self.sql('DROP TRIGGER test_fail_finalize ON public.odin_tasks; DROP FUNCTION public.test_fail_finalize();',role='postgres')

    def test_06_newer_inbound_and_wrong_scope_cannot_publish(self):
        cid, tid, t = self.verified()
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)},business=88))
        self.assertIsNone(self.command(cid,tid,'claim',{'owner':'b','leaseMs':1000},account='other'))
        self.accept(cid,input_=None)
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)}))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)};"),'0')
        self.assertIn('scope_mismatch',self.sql(f"SELECT public.odin_accept_knowledge_turn_v1(77,{literal(cid)},'whatsapp','other','event');",error=True))

    def test_07_ambiguous_and_expired_delivery_leases_never_reclaim(self):
        for ambiguous in [True,False]:
            cid,tid,t,d=self.final()
            claim=self.command(cid,tid,'claim_delivery',{'deliveryId':d['id'],'owner':'sender','leaseMs':100 if not ambiguous else 3000,'authority':self.receipt(cid,t,'send')})
            self.assertIsNotNone(claim)
            if ambiguous:
                self.command(cid,tid,'settle_delivery',{'deliveryId':d['id'],'owner':'sender','fence':claim['knowledge_fence'],'outcome':'AMBIGUOUS'})
            else:
                time.sleep(.12)
            self.assertIsNone(self.command(cid,tid,'claim_delivery',{'deliveryId':d['id'],'owner':'next','leaseMs':1000,'authority':self.receipt(cid,t,'send')}))
            self.assertIsNone(self.command(cid,tid,'settle_delivery',{'deliveryId':d['id'],'owner':'sender','fence':claim['knowledge_fence'],'outcome':'API_ACCEPTED','providerMessageId':'wamid.abc=='}))
            self.assertEqual(self.sql(f"SELECT knowledge_state FROM public.odin_outbox WHERE id={literal(d['id'])};"),'UNCERTAIN')

    def test_08_denied_or_old_authority_cannot_finalize(self):
        cid,tid,t=self.verified()
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t,allowed=False)}))
        receipt=self.receipt(cid,t); receipt['checkedAt']='2000-01-01T00:00:00Z'
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':receipt}))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)};"),'0')

    def test_09_cross_tenant_foreign_keys_and_event_uniqueness(self):
        cid=self.conversation(88)
        error=self.sql(f"INSERT INTO public.odin_tasks(business_id,conversation_id,task_type) VALUES(77,{literal(cid)},'knowledge_async_v1');",error=True)
        self.assertIn('foreign key',error)
        c77=self.conversation(); a=self.accept(c77,event='scope-event'); c88=self.conversation(88)
        b=self.accept(c88,event='scope-event',business=88)
        self.assertNotEqual(a['task']['id'],b['task']['id'])

    def test_10_foundation_and_extension_fail_closed_without_approval(self):
        self.pg.sql('CREATE DATABASE failure_test;')
        self.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY);',db='failure_test')
        self.assertIn('separate_approval_required',self.pg.sql(FOUNDATION.read_text(),db='failure_test',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_class WHERE relname='odin_tasks';",db='failure_test'),'0')
        self.assertIn('missing_P2_table',self.pg.sql("SET odin.approved_knowledge_slice1='yes';\n"+EXTENSION.read_text(),db='failure_test',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_class WHERE relname LIKE 'odin_%';",db='failure_test'),'0')
        self.assertIn('existing_relation_requires_review',self.sql("SET odin.approved_p2_knowledge_foundation='yes';\n"+FOUNDATION.read_text(),role='postgres',error=True))

    def test_11_booking_schema_functions_grants_and_rows_unchanged(self):
        self.assertEqual(self.booking_fingerprint(),self.booking_before)

    def test_12_concurrent_finalization_and_delivery_claims(self):
        cid,tid,t=self.verified()
        args={'owner':'worker-a','fence':t['knowledge_fence'],'authority':self.receipt(cid,t)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            finals=list(pool.map(lambda _: self.command(cid,tid,'finalize',args),range(2)))
        self.assertEqual(sum(v is not None for v in finals),1)
        d=next(v for v in finals if v is not None)
        receipt=self.receipt(cid,t,'send')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            claims=list(pool.map(lambda owner:self.command(cid,tid,'claim_delivery',{
                'owner':owner,'leaseMs':5000,'deliveryId':d['id'],'authority':receipt}),['sender-a','sender-b']))
        self.assertEqual(sum(v is not None for v in claims),1)
        self.assertEqual(self.sql(f"SELECT attempt_count FROM public.odin_outbox WHERE id={literal(d['id'])};"),'1')

    def test_13_tenant_and_conversation_scoped_task_and_outbox_links(self):
        cid,tid,t=self.verified(); other=self.conversation(88)
        # Direct backend writes must not bypass composite tenant/conversation FKs.
        error=self.sql(f"INSERT INTO public.odin_outbox(business_id,conversation_id,channel,recipient_key,delivery_key,knowledge_task_id,knowledge_kind,knowledge_state) VALUES(88,{literal(other)},'whatsapp','scoped-ref','cross-tenant',{literal(tid)},'final','PENDING');",error=True)
        self.assertIn('foreign key',error)
        another=self.conversation()
        error=self.sql(f"INSERT INTO public.odin_outbox(business_id,conversation_id,channel,recipient_key,delivery_key,knowledge_task_id,knowledge_kind,knowledge_state) VALUES(77,{literal(another)},'whatsapp','scoped-ref','cross-conversation',{literal(tid)},'final','PENDING');",error=True)
        self.assertIn('foreign key',error)
        error=self.sql(f"INSERT INTO public.odin_tasks(business_id,conversation_id,task_type,knowledge_inbox_id) VALUES(88,{literal(other)},'test',{literal(t['knowledge_inbox_id'])});",error=True)
        self.assertIn('foreign key',error)

    def test_14_mid_migration_failure_rolls_back_every_new_object(self):
        self.pg.sql('CREATE DATABASE rollback_test;')
        self.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY);',db='rollback_test')
        broken=FOUNDATION.read_text().replace('\ncommit;', '\nSELECT 1/0;\ncommit;')
        self.assertIn('division by zero',self.pg.sql("SET odin.approved_p2_knowledge_foundation='yes';\n"+broken,db='rollback_test',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_class WHERE relname LIKE 'odin_%';",db='rollback_test'),'0')
        self.pg.sql("SET odin.approved_p2_knowledge_foundation='yes';\n"+FOUNDATION.read_text(),db='rollback_test')
        broken=EXTENSION.read_text().replace('\ncommit;', '\nSELECT 1/0;\ncommit;')
        self.assertIn('division by zero',self.pg.sql("SET odin.approved_knowledge_slice1='yes';\n"+broken,db='rollback_test',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM information_schema.columns WHERE table_name='odin_tasks' AND column_name LIKE 'knowledge_%';",db='rollback_test'),'0')
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_proc WHERE proname IN ('odin_accept_knowledge_turn_v1','odin_transition_knowledge_v1');",db='rollback_test'),'0')

    def test_15_event_and_provider_id_bounds_include_256_characters(self):
        cid=self.conversation(); a=self.accept(cid,event='x'*256)
        self.assertEqual(a['inbox']['provider_event_id'],'x'*256)
        self.assertIn('invalid_knowledge_acceptance',self.sql(f"SELECT public.odin_accept_knowledge_turn_v1(77,{literal(cid)},'whatsapp','acct',{literal('x'*257)});",error=True))
        cid,tid,t,d=self.final()
        claim=self.command(cid,tid,'claim_delivery',{'deliveryId':d['id'],'owner':'sender','leaseMs':5000,'authority':self.receipt(cid,t,'send')})
        settled=self.command(cid,tid,'settle_delivery',{'deliveryId':d['id'],'owner':'sender','fence':claim['knowledge_fence'],'outcome':'API_ACCEPTED','providerMessageId':'x'*256})
        self.assertEqual(settled['knowledge_state'],'SENT')

    def test_16_bounded_unsent_retries_and_renewal_do_not_reset_expiry(self):
        cid,tid,t,d=self.final()
        for attempt in range(3):
            claim=self.command(cid,tid,'claim_delivery',{'deliveryId':d['id'],'owner':'sender','leaseMs':5000,'authority':self.receipt(cid,t,'send')})
            self.assertEqual(claim['attempt_count'],attempt+1)
            failed=self.command(cid,tid,'settle_delivery',{'deliveryId':d['id'],'owner':'sender','fence':claim['knowledge_fence'],'outcome':'DEFINITIVELY_UNSENT','retryable':True})
            self.assertEqual(failed['knowledge_state'],'FAILED')
        self.assertIsNone(self.command(cid,tid,'claim_delivery',{'deliveryId':d['id'],'owner':'sender','leaseMs':5000,'authority':self.receipt(cid,t,'send')}))
        cid,tid,t=self.running()
        renewed=self.command(cid,tid,'renew',{'owner':'worker-a','fence':t['knowledge_fence'],'leaseMs':10000})
        self.assertEqual(renewed['knowledge_expires_at'],t['knowledge_expires_at'])

    def test_17_foreground_handoff_and_attempts_keep_original_ingress_limits(self):
        for duration in [30000,35000,40000]:
            cid=self.conversation(); event=str(uuid.uuid4())
            a=self.accept(cid,event,input_=None,ms=duration)
            b=self.accept(cid,event,input_=INPUT,ms=120000)
            self.assertEqual(b['task']['knowledge_expires_at'],a['inbox']['knowledge_expires_at'])
            self.assertEqual(b['task']['knowledge_accepted_at'],a['inbox']['knowledge_accepted_at'])
            self.assertEqual(self.accept(cid,event)['task']['id'],b['task']['id'])
        cid,tid,t=self.running()
        for _ in range(4):
            self.assertIsNotNone(self.command(cid,tid,'model_attempt',{'owner':'worker-a','fence':t['knowledge_fence']}))
        self.assertIsNone(self.command(cid,tid,'model_attempt',{'owner':'worker-a','fence':t['knowledge_fence']}))
        self.assertEqual(self.sql(f"SELECT knowledge_model_attempts FROM public.odin_tasks WHERE id={literal(tid)};"),'4')

    def test_18_booking_sql_path_still_works_and_rolls_back(self):
        # Real local Booking functions, with no external calendars or messages.
        raw=self.sql("""BEGIN;
          INSERT INTO public.booking_result_outbox(operation_id,business_id,channel,customer_id,session_id,booking_id,provider_booking_id,terminal_result,response_text)
          VALUES('synthetic-booking-smoke',77,'whatsapp','synthetic-customer','synthetic-session','booking-1','calendar-1','{}','Confirmed');
          SELECT status FROM public.claim_booking_result_outbox_delivery('synthetic-booking-smoke','00000000-0000-0000-0000-000000000001',60);
          SELECT public.complete_booking_result_outbox_delivery('synthetic-booking-smoke','00000000-0000-0000-0000-000000000001',true,NULL);
          SELECT status FROM public.booking_result_outbox WHERE operation_id='synthetic-booking-smoke';
          ROLLBACK;""")
        self.assertEqual(raw.splitlines(),['delivering','t','delivered'])
        self.assertEqual(self.booking_fingerprint(),self.booking_before)

    def test_19_postgres_restart_retains_attempts_checkpoints_and_absolute_expiry(self):
        cid,tid,t=self.running(lease=120)
        self.command(cid,tid,'model_attempt',{'owner':'worker-a','fence':t['knowledge_fence']})
        self.command(cid,tid,'checkpoint',{'owner':'worker-a','fence':t['knowledge_fence'],'checkpoint':'extraction'})
        self.pg.restart(); time.sleep(.13)
        b=self.command(cid,tid,'claim',{'owner':'worker-b','leaseMs':5000})
        self.assertEqual(b['knowledge_model_attempts'],1)
        self.assertEqual(b['knowledge_run_attempts'],2)
        self.assertEqual(b['knowledge_checkpoint'],'extraction')
        self.assertEqual(b['knowledge_expires_at'],t['knowledge_expires_at'])
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence']}))

    def test_20_absolute_expiry_stops_processing_and_foreground_attachment(self):
        cid=self.conversation(); event=str(uuid.uuid4()); a=self.accept(cid,event,ms=1000)
        cid2=self.conversation(); other_event=str(uuid.uuid4()); self.accept(cid2,other_event,input_=None,ms=1000)
        time.sleep(1.05)
        self.assertIsNone(self.command(cid,a['task']['id'],'claim',{'owner':'worker-a','leaseMs':1000}))
        self.assertEqual(self.sql(f"SELECT knowledge_state FROM public.odin_tasks WHERE id={literal(a['task']['id'])};"),'EXPIRED')
        self.assertIsNone(self.accept(cid2,other_event,ms=120000)['task'])

    def test_21_partial_non_lifecycle_rows_are_not_dispatchable(self):
        cid=self.conversation(); tid=str(uuid.uuid4())
        self.sql(f"INSERT INTO public.odin_tasks(id,business_id,conversation_id,task_type,knowledge_channel,knowledge_account) VALUES({literal(tid)},77,{literal(cid)},'knowledge_async_v1','whatsapp','acct');")
        self.assertIsNone(self.command(cid,tid,'claim',{'owner':'worker-a','leaseMs':1000}))

    def test_22_independent_complete_verification_flags_and_digest_binding(self):
        cid,tid,t=self.running()
        for field in ['independentlyVerified','completeRequiredFacts']:
            bad={**RESULT,field:False}
            self.assertIn('knowledge_unverified_result',self.sql(self.command_sql(cid,tid,'verified',{
                'owner':'worker-a','fence':t['knowledge_fence'],'result':bad}),error=True))
        result={**RESULT,'text':'پارکینگ پولی است.'}
        v=self.command(cid,tid,'verified',{'owner':'worker-a','fence':t['knowledge_fence'],'result':result})
        frame='evidence-first-v2\n'+str(len(result['text'].encode()))+':'+result['text']+'\n1\n5:doc-12:v1'
        self.assertEqual(v['knowledge_result_digest'],hashlib.sha256(frame.encode()).hexdigest())
        receipt=self.receipt(cid,v); receipt['resultDigest']='wrong-digest'
        self.assertIsNone(self.command(cid,tid,'finalize',{'owner':'worker-a','fence':t['knowledge_fence'],'authority':receipt}))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id={literal(tid)};"),'0')


if __name__=='__main__':
    unittest.main(verbosity=2)
