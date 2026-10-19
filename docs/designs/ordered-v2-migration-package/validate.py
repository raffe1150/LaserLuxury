"""Disposable PostgreSQL only; reuse unchanged 36 ordered/Booking/P2 scenarios."""
import importlib.util,sys,time,hashlib,subprocess,unittest
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
builder=load('v2_builder',HERE/'build.py')
ordered=load('ordered_suite',ROOT/'tests/p2/ordered-native-admission-postgres.py')
class WrappedV2(ordered.OrderedTests):
    @classmethod
    def setUpClass(cls):
        ordered.base.FoundationTests.setUpClass.__func__(cls)
        cls.v1_before=cls.pg.sql("SELECT pg_get_functiondef(oid)||coalesce(proacl::text,'') FROM pg_proc WHERE proname='odin_accept_knowledge_turn_v1';",db='foundation_test')
        cls.pg.sql('CREATE DATABASE pre_v2 TEMPLATE foundation_test; CREATE DATABASE reference_v2 TEMPLATE foundation_test;')
        cls.payload=(HERE/'ordered-admission-v2.sql').read_bytes()
        if cls.payload!=builder.build():raise AssertionError('payload bytes differ')
        cls.pg.sql(cls.payload.decode(),db='foundation_test')
        cls.pg.sql("SET odin.approved_ordered_knowledge_v2='yes';\n"+builder.SOURCE.read_text(),db='reference_v2')
        def dump(db):
            raw=subprocess.run(['pg_dump','-h',str(cls.pg.socket),'-p','55439','-U','postgres','-d',db,'--schema-only','--schema=public'],env=cls.pg.env,text=True,capture_output=True,check=True).stdout
            return '\n'.join(l for l in raw.splitlines() if not l.startswith(('\\restrict ','\\unrestrict ')))
        actual,reference=dump('foundation_test'),dump('reference_v2')
        if actual!=reference:raise AssertionError('wrapper/raw schema, ACL, RLS or function mismatch')
        print('Wrapper/reference normalized schema SHA256:',hashlib.sha256(actual.encode()).hexdigest(),flush=True)
        cls.at=int(time.time())*1000-300000
    def test_wrapper_01_local_setting_and_timeouts_restored(self):
        query="SET odin.approved_ordered_knowledge_v2='no'; SET lock_timeout='7s'; SET statement_timeout='45s';\n"
        self.pg.sql('CREATE DATABASE settings_v2 TEMPLATE pre_v2;')
        result=self.pg.sql(query+self.payload.decode()+"SELECT current_setting('odin.approved_ordered_knowledge_v2')||','||current_setting('lock_timeout')||','||current_setting('statement_timeout');",db='settings_v2')
        self.assertEqual(result,'no,7s,45s')
    def test_wrapper_02_error_before_commit_rolls_back_every_new_object(self):
        self.pg.sql('CREATE DATABASE failure_v2 TEMPLATE pre_v2;')
        # Failure injection is a test-only derived payload, never the review file.
        broken=self.payload.decode().replace('commit;','SELECT 1/0;\ncommit;')
        self.assertIn('division by zero',self.pg.sql(broken,db='failure_v2',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_proc WHERE proname IN ('odin_accept_knowledge_turn_v2','odin_guard_native_order_v2');",db='failure_v2'),'0')
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'odin_guard_native_order_%_v2';",db='failure_v2'),'0')
    def test_wrapper_03_rerun_rejected_and_v1_booking_unchanged(self):
        self.assertIn('prerequisites',self.pg.sql(self.payload.decode(),db='foundation_test',error=True))
        self.assertEqual(self.booking_fingerprint(),self.booking_before)
        self.assertEqual(self.pg.sql("SELECT pg_get_functiondef(oid)||coalesce(proacl::text,'') FROM pg_proc WHERE proname='odin_accept_knowledge_turn_v1';",db='foundation_test'),self.v1_before)
    def test_wrapper_04_exact_bytes_and_hash_mismatch_refused(self):
        self.assertEqual(self.payload[len(builder.PREFIX):],builder.SOURCE.read_bytes())
        pin=builder.PIN
        try:
            builder.PIN='0'*64
            with self.assertRaises(ValueError):builder.build()
        finally:builder.PIN=pin
    def test_wrapper_05_readonly_postcheck_query_and_v2_comparator(self):
        import json
        self.pg.sql('CREATE DATABASE postcheck_v2 TEMPLATE foundation_test;')
        self.pg.sql('CREATE TABLE IF NOT EXISTS public.appointments(id bigint);',db='postcheck_v2')
        snapshot=json.loads(self.pg.sql((HERE/'post-application-snapshot.sql').read_text(),db='postcheck_v2'))
        verifier=load('v2_snapshot_verifier',HERE/'verify_snapshot.py')
        checks=verifier.verify(snapshot)
        for key in ['exactFunctionInventory','v2BodiesExact','v2ServiceOnlyInvoker','v2SignaturesSearchPath','v1TriggersUnchanged','exactTriggerInventory','v2TriggerDefinitions']:
            self.assertTrue(checks[key],key)
if __name__=='__main__':unittest.main(verbosity=2)
