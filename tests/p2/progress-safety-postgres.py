#!/usr/bin/env python3
"""Private disposable PG only. Includes unchanged ordered/Booking/P2 SQL tests."""
import concurrent.futures,importlib.util,json,sys,time,unittest,uuid
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('ordered',ROOT/'tests/p2/ordered-native-admission-postgres.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
DRAFT=ROOT/'docs/designs/knowledge-progress-safety-v1/progress-safety-v1.sql.draft'
class ProgressSafety(m.OrderedTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.old_functions=cls.pg.sql("SELECT jsonb_agg(jsonb_build_array(proname,pg_get_functiondef(oid),proacl) ORDER BY proname) FROM pg_proc WHERE proname IN ('odin_accept_knowledge_turn_v1','odin_accept_knowledge_turn_v2','odin_transition_knowledge_v1','odin_guard_native_order_v2','odin_guard_knowledge_identity_v1','odin_guard_knowledge_ingress_v1');",db='foundation_test')
        cls.pg.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+DRAFT.read_text(),db='foundation_test')
    def fixture(self,lease=15000,ms=40000):
        s=self.native_scope();a=self.ordered(s,str(uuid.uuid4()),self.order(s),ms=ms);tid=a['task']['id']
        self.sql("UPDATE public.odin_conversations SET aggregate_meta=jsonb_set(aggregate_meta,'{knowledge_native_recipient_v1}',"+m.base.jb({'mac':'a'*64})+") WHERE id="+m.base.literal(s[0])+';')
        t=self.native_command(s,tid,'claim',{'owner':'worker-a','leaseMs':lease})
        t=self.native_command(s,tid,'checkpoint',{'owner':'worker-a','fence':t['knowledge_fence'],'checkpoint':'planning'})
        return s,tid,t
    def authority(self,s,t):
        return {'purpose':'knowledge-progress-v1','businessId':s[2],'conversationId':s[0],'taskId':t['id'],'turnId':t['knowledge_turn_id'],
          'channel':s[1],'account':s[3],'key':s[4],'sequence':t['knowledge_sequence'],'owner':t['knowledge_owner'],
          'fence':t['knowledge_fence'],'checkpoint':t['knowledge_checkpoint'],'bindingMac':'a'*64,'checkedAt':self.sql('SELECT clock_timestamp();')}
    def progress_sql(self,s,t,receipt=None,lease=3000,owner=None,fence=None):
        return 'SELECT public.odin_claim_knowledge_progress_v1('+','.join([str(s[2]),m.base.literal(s[0]),m.base.literal(t['id']),m.base.literal(s[1]),m.base.literal(s[3]),m.base.literal(s[4]),
          m.base.literal(owner or t['knowledge_owner']),str(fence or t['knowledge_fence']),m.base.literal('Checking the information for your question.'),m.base.jb(receipt or self.authority(s,t)),str(lease)])+');'
    def progress(self,s,t,**kw):return json.loads(self.sql(self.progress_sql(s,t,**kw)) or 'null')
    def finish(self,s,t):
        v=self.native_command(s,t['id'],'verified',{'owner':t['knowledge_owner'],'fence':t['knowledge_fence'],'result':m.base.RESULT})
        d=self.native_command(s,t['id'],'finalize',{'owner':t['knowledge_owner'],'fence':t['knowledge_fence'],'authority':self.receipt(s[0],v)})
        self.assertIsNotNone(d);return v,d
    def settle(self,s,t,d,outcome='DEFINITIVELY_UNSENT',retryable=True):
        return self.native_command(s,t['id'],'settle_delivery',{'deliveryId':d['id'],'owner':d['knowledge_owner'],'fence':d['knowledge_fence'],'outcome':outcome,
          **({'providerMessageId':'wamid.synthetic'} if outcome=='API_ACCEPTED' else {'retryable':retryable} if outcome=='DEFINITIVELY_UNSENT' else {})})
    def test_progress_01_original_retry_race_rejected_new_and_old_paths(self):
        s,tid,t=self.fixture();d=self.progress(s,t);self.assertIsNotNone(d);v,final=self.finish(s,t)
        self.assertIsNotNone(self.settle(s,t,d));self.assertIsNone(self.progress(s,t))
        legacy=self.command_sql(s[0],tid,'claim_delivery',{'deliveryId':d['id'],'owner':'late-sender','leaseMs':1000,'authority':self.receipt(s[0],v,'send')})
        self.assertIn('knowledge_progress_dispatch_not_authorized',self.sql(legacy,error=True))
        self.assertEqual(self.sql('SELECT knowledge_state FROM public.odin_outbox WHERE id='+m.base.literal(d['id'])+';'),'FAILED')
    def test_progress_02_genuine_inflight_api_acceptance_settles_after_final(self):
        s,tid,t=self.fixture();d=self.progress(s,t);v,final=self.finish(s,t)
        self.assertIsNotNone(self.settle(s,t,d,'API_ACCEPTED'));self.assertIsNone(self.progress(s,t))
        self.assertEqual(self.sql('SELECT knowledge_state FROM public.odin_outbox WHERE id='+m.base.literal(d['id'])+';'),'SENT')
    def test_progress_03_verified_and_failed_tasks_reject_claims(self):
        for state in ['verified','fail']:
            s,tid,t=self.fixture();args={'owner':'worker-a','fence':t['knowledge_fence']}
            if state=='verified':args['result']=m.base.RESULT
            self.assertIsNotNone(self.native_command(s,tid,state,args));self.assertIsNone(self.progress(s,t))
    def test_progress_04_two_workers_same_identity_only_one_claim(self):
        s,tid,t=self.fixture();query=self.progress_sql(s,t)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            values=list(pool.map(lambda _:json.loads(self.sql(query) or 'null'),range(2)))
        self.assertEqual(sum(x is not None for x in values),1)
        self.assertEqual(self.sql('SELECT count(*) FROM public.odin_outbox WHERE knowledge_task_id='+m.base.literal(tid)+';'),'1')
    def test_progress_05_restart_takeover_does_not_reset_expiry_or_retry_ambiguity(self):
        s,tid,t=self.fixture(lease=80);d=self.progress(s,t,lease=40);self.pg.restart();time.sleep(.1)
        next_t=self.native_command(s,tid,'claim',{'owner':'worker-b','leaseMs':5000});self.assertIsNotNone(next_t)
        self.assertEqual(next_t['knowledge_expires_at'],t['knowledge_expires_at']);self.assertGreater(next_t['knowledge_fence'],t['knowledge_fence'])
        self.assertIsNone(self.progress(s,t));self.assertIsNone(self.progress(s,next_t))
        self.assertEqual(self.sql('SELECT knowledge_state FROM public.odin_outbox WHERE id='+m.base.literal(d['id'])+';'),'UNCERTAIN')
        self.assertIsNone(self.settle(s,t,d,'API_ACCEPTED'))
    def test_progress_06_ambiguous_outcome_has_no_retry(self):
        s,tid,t=self.fixture();d=self.progress(s,t);self.assertIsNotNone(self.settle(s,t,d,'AMBIGUOUS'));self.assertIsNone(self.progress(s,t))
    def test_progress_07_recipient_receipt_revocation_and_scope_denied(self):
        s,tid,t=self.fixture()
        for patch in [{'bindingMac':'b'*64},{'purpose':'finalize'},{'account':'other'},{'businessId':88},{'fence':999},{'checkedAt':'2000-01-01T00:00:00Z'}]:
            self.assertIsNone(self.progress(s,t,receipt={**self.authority(s,t),**patch}))
        self.assertIsNone(self.progress(s,t,owner='other'));self.assertIsNone(self.progress(s,t,fence=999))
        receipt=self.authority(s,t)
        self.sql("UPDATE public.odin_conversations SET aggregate_meta=jsonb_set(aggregate_meta,'{knowledge_native_recipient_v1,mac}',"+m.base.jb('b'*64)+") WHERE id="+m.base.literal(s[0])+';')
        self.assertIsNone(self.progress(s,t,receipt=receipt))
    def test_progress_08_supersession_and_expiry_prevent_new_claim(self):
        s,tid,t=self.fixture();self.ordered(s,str(uuid.uuid4()),self.order(s,offset=1000));self.assertIsNone(self.progress(s,t))
        s,tid,t=self.fixture(ms=1000);time.sleep(1.05);self.assertIsNone(self.progress(s,t))
    def test_progress_09_finalization_does_not_wait_for_progress_lease(self):
        s,tid,t=self.fixture();d=self.progress(s,t,lease=5000);start=time.monotonic();v,final=self.finish(s,t)
        self.assertLess(time.monotonic()-start,2,'no waiting for the five-second external progress lease')
        self.assertNotEqual(d['delivery_key'],final['delivery_key']);self.assertEqual(d['knowledge_kind'],'progress')
    def test_progress_10_finalization_race_serializes_without_new_late_claim(self):
        for _ in range(5):
            s,tid,t=self.fixture();query=self.progress_sql(s,t)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                claim=pool.submit(lambda:json.loads(self.sql(query) or 'null'));final=pool.submit(self.finish,s,t)
                claim.result();self.assertIsNotNone(final.result()[1])
            self.assertIsNone(self.progress(s,t))
    def test_progress_11_attempt_limits_survive_restart(self):
        s,tid,t=self.fixture()
        for _ in range(3):
            d=self.progress(s,t);self.assertIsNotNone(d);self.assertIsNotNone(self.settle(s,t,d))
        self.pg.restart();self.assertIsNone(self.progress(s,t))
        self.assertEqual(self.sql('SELECT attempt_count FROM public.odin_outbox WHERE knowledge_task_id='+m.base.literal(tid)+';'),'3')
    def test_progress_12_privileges_and_old_definitions_unchanged(self):
        for role in ['anon','authenticated']:
            s,tid,t=self.fixture()
            self.assertIn('permission denied',self.sql(self.progress_sql(s,t),role=role,error=True))
        actual=self.pg.sql("SELECT jsonb_agg(jsonb_build_array(proname,pg_get_functiondef(oid),proacl) ORDER BY proname) FROM pg_proc WHERE proname IN ('odin_accept_knowledge_turn_v1','odin_accept_knowledge_turn_v2','odin_transition_knowledge_v1','odin_guard_native_order_v2','odin_guard_knowledge_identity_v1','odin_guard_knowledge_ingress_v1');",db='foundation_test')
        self.assertEqual(actual,self.old_functions);self.assertEqual(self.booking_fingerprint(),self.booking_before)
    def test_progress_13_progress_receipt_cannot_authorize_final(self):
        s,tid,t=self.fixture();progress_receipt=self.authority(s,t)
        v=self.native_command(s,tid,'verified',{'owner':'worker-a','fence':t['knowledge_fence'],'result':m.base.RESULT})
        self.assertIsNone(self.native_command(s,tid,'finalize',{'owner':'worker-a','fence':v['knowledge_fence'],'authority':progress_receipt}))
    def test_progress_14_migration_guards_and_rollback(self):
        self.assertIn('separate_approval_required',self.sql(DRAFT.read_text(),role='postgres',error=True))
        self.assertIn('prerequisites_or_conflict',self.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+DRAFT.read_text(),role='postgres',error=True))
    def test_progress_15_new_execution_fence_rejects_legacy_replay(self):
        s,tid,t=self.fixture(lease=80);d=self.progress(s,t,lease=40);self.assertIsNotNone(self.settle(s,t,d))
        time.sleep(.1);new_t=self.native_command(s,tid,'claim',{'owner':'worker-b','leaseMs':5000});self.assertIsNotNone(new_t)
        self.assertIsNone(self.progress(s,t))
        legacy=self.command_sql(s[0],tid,'claim_delivery',{'deliveryId':d['id'],'owner':'worker-b','leaseMs':1000,'authority':self.receipt(s[0],new_t,'send')})
        self.assertIn('knowledge_progress_dispatch_not_authorized',self.sql(legacy,error=True))
        next_claim=self.progress(s,new_t);self.assertIsNotNone(next_claim);self.assertEqual(next_claim['id'],d['id'])
        self.assertEqual(next_claim['attempt_count'],2)
    def test_progress_16_transaction_failure_leaves_no_partial_install(self):
        self.pg.sql('CREATE DATABASE progress_rollback;')
        # Minimal clean prerequisites only in a private synthetic database.
        self.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY);',db='progress_rollback')
        self.pg.sql("SET odin.approved_p2_knowledge_foundation='yes';\n"+m.base.FOUNDATION.read_text(),db='progress_rollback')
        self.pg.sql("SET odin.approved_knowledge_slice1='yes';\n"+m.base.EXTENSION.read_text(),db='progress_rollback')
        self.pg.sql("SET odin.approved_ordered_knowledge_v2='yes';\n"+m.DRAFT.read_text(),db='progress_rollback')
        broken=DRAFT.read_text().replace('commit;','SELECT 1/0;\ncommit;')
        self.assertIn('division by zero',self.pg.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+broken,db='progress_rollback',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_proc WHERE proname IN ('odin_claim_knowledge_progress_v1','odin_guard_knowledge_progress_dispatch_v1');",db='progress_rollback'),'0')
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_trigger WHERE tgname='odin_guard_knowledge_progress_dispatch_v1';",db='progress_rollback'),'0')
if __name__=='__main__':unittest.main(verbosity=2)
