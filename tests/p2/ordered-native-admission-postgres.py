#!/usr/bin/env python3
"""Real PostgreSQL v2 tests + unchanged v1/Booking foundation regression tests.
Private disposable cluster only. Native payloads are synthetic, not live captures.
"""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import uuid
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ordered_foundation_harness', HERE/'knowledge-foundation-postgres.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
DRAFT = base.ROOT/'docs/designs/ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft'

class OrderedTests(base.FoundationTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.v1_before = cls.pg.sql("SELECT pg_get_functiondef(oid)||coalesce(proacl::text,'') FROM pg_proc WHERE proname='odin_accept_knowledge_turn_v1';", db='foundation_test')
        cls.pg.sql("SET odin.approved_ordered_knowledge_v2='yes';\n"+DRAFT.read_text(), db='foundation_test')
        cls.at = int(time.time())*1000-300000

    def native_scope(self, channel='whatsapp', business=77, account='acct'):
        cid = str(uuid.uuid4()); key = channel+':'+account+':'+cid
        self.sql(f'INSERT INTO public.odin_conversations(id,business_id,conversation_key) VALUES({base.literal(cid)},{business},{base.literal(key)});')
        return (cid, channel, business, account, key)

    def order(self, scope, offset=0, seq=102):
        return {'atMs': self.at+offset, 'sequence':seq if scope[1]=='telegram' else None}

    def ordered_sql(self, scope, event, order, input_=base.INPUT, ms=120000, runs=3, models=4):
        cid, channel, business, account, key = scope
        args = [str(business),base.literal(cid),base.literal(channel),base.literal(account),base.literal(event),base.literal(key),
                'NULL' if order is None else base.jb(order), 'NULL' if input_ is None else base.jb(input_),str(ms),str(runs),str(models)]
        return 'SELECT public.odin_accept_knowledge_turn_v2('+','.join(args)+');'

    def ordered(self, scope, event, order, **kw):
        return json.loads(self.sql(self.ordered_sql(scope,event,order,**kw)))

    def native_command(self, scope, task, command, args=None):
        cid,ch,business,account,_ = scope
        return json.loads(self.sql('SELECT public.odin_transition_knowledge_v1('+','.join([str(business),base.literal(cid),base.literal(task),base.literal(ch),base.literal(account),base.literal(command),base.jb(args or {})])+');') or 'null')

    def watermark(self, scope):
        return json.loads(self.sql('SELECT aggregate_meta->\'knowledge_native_order_v2\' FROM public.odin_conversations WHERE id='+base.literal(scope[0])+';') or 'null')

    def test_v2_01_exact_delayed_older_pattern_four_channels(self):
        for channel in ['whatsapp','telegram','instagram','messenger']:
            with self.subTest(channel=channel):
                s=self.native_scope(channel); event_new=str(uuid.uuid4()); event_old=str(uuid.uuid4())
                newer=self.ordered(s,event_new,self.order(s,2000,102)); tid=newer['task']['id']
                self.assertIsNotNone(self.native_command(s,tid,'claim',{'owner':'worker','leaseMs':15000}))
                before=self.watermark(s)
                older=self.ordered(s,event_old,self.order(s,1000,101),input_=None)
                self.assertEqual(older['disposition'],'STALE'); self.assertIsNone(older['inbox']); self.assertIsNone(older['task'])
                self.assertEqual(self.watermark(s),before)
                self.assertEqual(self.ordered(s,event_old,self.order(s,1000,101))['disposition'],'STALE')
                duplicate=self.ordered(s,event_new,self.order(s,2000,102))
                self.assertEqual(duplicate['inbox']['knowledge_turn_id'],newer['inbox']['knowledge_turn_id'])
                self.assertEqual(duplicate['inbox']['knowledge_expires_at'],newer['inbox']['knowledge_expires_at'])
                self.assertTrue(duplicate['mayAttach'])
                self.assertEqual(self.sql('SELECT knowledge_state FROM public.odin_tasks WHERE id='+base.literal(tid)+';'),'RUNNING')

    def test_v2_02_competing_workers_and_duplicate_identities(self):
        for channel in ['whatsapp','telegram','instagram','messenger']:
            s=self.native_scope(channel); event=str(uuid.uuid4())
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                values=list(pool.map(lambda _:self.ordered(s,event,self.order(s)),range(2)))
            self.assertEqual(sum(v['inserted'] for v in values),1)
            self.assertEqual(values[0]['task']['id'],values[1]['task']['id'])
            for _ in range(3):
                s=self.native_scope(channel)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    a=pool.submit(self.ordered,s,str(uuid.uuid4()),self.order(s,1000,101))
                    b=pool.submit(self.ordered,s,str(uuid.uuid4()),self.order(s,2000,102))
                    values=[a.result(),b.result()]
                self.assertEqual(self.watermark(s)['atMs'],self.at+2000)
                self.assertEqual(values[1]['disposition'],'ACCEPTED')
                self.assertIn(values[0]['disposition'],['STALE','ACCEPTED'])

    def test_v2_03_original_external_precheck_race_corrected(self):
        s=self.native_scope('telegram'); checked=threading.Event(); committed=threading.Event()
        def late_worker():
            self.assertIsNone(self.watermark(s)); checked.set()
            self.assertTrue(committed.wait(10))
            return self.ordered(s,'opaque-older',self.order(s,1000,101),input_=None)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            pending=pool.submit(late_worker);self.assertTrue(checked.wait(10))
            try: newer=self.ordered(s,'opaque-newer',self.order(s,2000,102))
            finally: committed.set()
            self.assertEqual(pending.result(timeout=15)['disposition'],'STALE')
        self.assertIsNotNone(self.native_command(s,newer['task']['id'],'claim',{'owner':'worker','leaseMs':15000}))

    def test_v2_04_restart_and_lease_takeover_never_restore_older_authority(self):
        s=self.native_scope('telegram');a=self.ordered(s,'newer',self.order(s,2000,102),runs=2,models=2)
        t=self.native_command(s,a['task']['id'],'claim',{'owner':'a','leaseMs':15000})
        self.assertTrue(self.native_command(s,t['id'],'model_attempt',{'owner':'a','fence':t['knowledge_fence']}))
        self.pg.restart()
        self.sql('UPDATE public.odin_tasks SET knowledge_lease_until=clock_timestamp()-interval \'1 second\' WHERE id='+base.literal(t['id'])+';')
        u=self.native_command(s,t['id'],'claim',{'owner':'b','leaseMs':15000})
        self.assertGreater(u['knowledge_fence'],t['knowledge_fence']);self.assertEqual(u['knowledge_model_attempts'],1)
        self.assertEqual(u['knowledge_expires_at'],t['knowledge_expires_at'])
        self.assertEqual(self.ordered(s,'older',self.order(s,1000,101))['disposition'],'STALE')
        self.assertIsNone(self.native_command(s,t['id'],'verified',{'owner':'a','fence':t['knowledge_fence'],'result':base.RESULT}))
        self.assertTrue(self.native_command(s,t['id'],'renew',{'owner':'b','fence':u['knowledge_fence'],'leaseMs':15000}))

    def test_v2_05_equal_meta_timestamps_fence_instead_of_sorting_ids(self):
        for ch in ['whatsapp','instagram','messenger']:
            s=self.native_scope(ch);first=self.ordered(s,'zz-opaque',self.order(s))
            tie=self.ordered(s,'aa-opaque',self.order(s))
            self.assertEqual(tie['disposition'],'AMBIGUOUS');self.assertIsNone(tie['task']);self.assertFalse(tie['mayAttach'])
            self.assertEqual(self.watermark(s)['state'],'TIED')
            self.assertIsNone(self.native_command(s,first['task']['id'],'claim',{'owner':'a','leaseMs':1000}))
            self.assertFalse(self.ordered(s,'zz-opaque',self.order(s))['mayAttach'])
            self.assertEqual(self.ordered(s,'another-tie',self.order(s))['disposition'],'AMBIGUOUS')
            self.assertEqual(self.ordered(s,'strictly-newer',self.order(s,1000))['disposition'],'ACCEPTED')

    def test_v2_06_telegram_same_second_reset_and_contradiction(self):
        s=self.native_scope('telegram');self.ordered(s,'opaque-a',self.order(s,0,100))
        self.assertEqual(self.ordered(s,'opaque-b',self.order(s,0,102))['disposition'],'ACCEPTED')
        self.assertEqual(self.ordered(s,'opaque-c',self.order(s,0,101))['disposition'],'STALE')
        self.assertEqual(self.ordered(s,'opaque-d',self.order(s,0,102))['disposition'],'AMBIGUOUS')
        self.assertEqual(self.ordered(s,'opaque-e',self.order(s,0,103))['disposition'],'AMBIGUOUS')
        self.assertEqual(self.ordered(s,'opaque-f',self.order(s,1000,104))['disposition'],'ACCEPTED')
        self.assertEqual(self.ordered(s,'contradiction',self.order(s,2000,50))['disposition'],'AMBIGUOUS')
        self.assertEqual(self.watermark(s)['state'],'BLOCKED')
        contradiction=self.native_scope('telegram');self.ordered(contradiction,'a',self.order(contradiction,1000,100))
        self.assertEqual(self.ordered(contradiction,'b',self.order(contradiction,0,101))['disposition'],'AMBIGUOUS')
        self.assertEqual(self.watermark(contradiction)['state'],'BLOCKED')
        q=self.native_scope('telegram');self.ordered(q,'epoch1',{'atMs':self.at-604800000,'sequence':900})
        self.assertEqual(self.ordered(q,'epoch2',self.order(q,0,10))['disposition'],'ACCEPTED')

    def test_v2_07_missing_future_order_latches_and_cannot_attach(self):
        for ch in ['whatsapp','telegram','instagram','messenger']:
            s=self.native_scope(ch);a=self.ordered(s,'current',self.order(s))
            unknown=self.ordered(s,'unknown',None)
            self.assertEqual(unknown['disposition'],'AMBIGUOUS');self.assertIsNone(unknown['task'])
            self.assertEqual(self.watermark(s)['state'],'BLOCKED')
            self.assertIsNone(self.native_command(s,a['task']['id'],'claim',{'owner':'a','leaseMs':1000}))
            self.assertEqual(self.ordered(s,'later',self.order(s,1000))['disposition'],'BLOCKED')
            d=self.ordered(s,'unknown',None,ms=30000)
            self.assertEqual(d['inbox']['knowledge_turn_id'],unknown['inbox']['knowledge_turn_id']);self.assertFalse(d['mayAttach'])
        s=self.native_scope();future=self.order(s);future['atMs']=int(time.time())*1000+60000
        self.assertEqual(self.ordered(s,'future',future)['disposition'],'AMBIGUOUS')
        self.assertEqual(self.watermark(s)['state'],'BLOCKED')

    def test_v2_08_stale_attachment_expiry_limits_and_input_rollback(self):
        s=self.native_scope();a=self.ordered(s,'first',self.order(s),input_=None,runs=2,models=2,ms=30000)
        attached=self.ordered(s,'first',self.order(s),runs=5,models=8,ms=120000)
        self.assertEqual(attached['task']['knowledge_max_runs'],2);self.assertEqual(attached['task']['knowledge_max_models'],2)
        self.assertEqual(attached['task']['knowledge_expires_at'],a['inbox']['knowledge_expires_at'])
        q=self.native_scope();self.ordered(q,'old',self.order(q),input_=None)
        self.ordered(q,'new',self.order(q,1000))
        stale=self.ordered(q,'old',self.order(q))
        self.assertEqual(stale['disposition'],'DUPLICATE');self.assertFalse(stale['mayAttach']);self.assertIsNone(stale['task'])
        e=self.native_scope();original=self.ordered(e,'expires',self.order(e),input_=None,ms=1000)
        time.sleep(1.05);expired=self.ordered(e,'expires',self.order(e))
        self.assertFalse(expired['mayAttach']);self.assertIsNone(expired['task'])
        self.assertEqual(expired['inbox']['knowledge_expires_at'],original['inbox']['knowledge_expires_at'])
        bad=self.native_scope();self.assertIn('knowledge_input_bounds',self.sql(self.ordered_sql(bad,'bad',self.order(bad),input_={'question':'','language':'en','history':[]}),error=True))
        self.assertIsNone(self.watermark(bad))

    def test_v2_09_scope_keys_tenants_accounts_and_service_only(self):
        s=self.native_scope();event=str(uuid.uuid4());self.ordered(s,event,self.order(s))
        for changed in [(s[0],s[1],88,s[3],s[4]),(s[0],s[1],s[2],'other',s[4]),(s[0],'messenger',s[2],s[3],s[4]),(*s[:4],'wrong-key')]:
            self.assertIn('scope',self.sql(self.ordered_sql(changed,str(uuid.uuid4()),self.order(changed)),error=True))
        for business,account in [(77,'other'),(88,'acct')]:
            q=self.native_scope(business=business,account=account)
            self.assertEqual(self.ordered(q,event,self.order(q))['disposition'],'ACCEPTED')
        q=self.native_scope();self.assertIn('existing_event_requires_review',self.sql(self.ordered_sql(q,event,self.order(q)),error=True))
        for role in ['anon','authenticated']:
            self.assertIn('permission denied',self.sql(self.ordered_sql(s,'x',self.order(s)),role=role,error=True))
        self.assertEqual(self.sql("SELECT count(*) FROM pg_policies WHERE tablename IN ('odin_inbox','odin_tasks','odin_conversations','odin_outbox');"),'0')

    def test_v2_10_v1_cannot_bypass_ordered_fence_or_attach_ambiguous_input(self):
        s=self.native_scope();self.ordered(s,'ordered',self.order(s))
        self.assertIn('ordered_fence_required',self.sql("SELECT public.odin_accept_knowledge_turn_v1(77,"+base.literal(s[0])+",'whatsapp','acct','legacy');",error=True))
        self.ordered(s,'tie',self.order(s))
        self.assertIn('ordered_task_not_authorized',self.sql("SELECT public.odin_accept_knowledge_turn_v1(77,"+base.literal(s[0])+",'whatsapp','acct','tie',"+base.jb(base.INPUT)+');',error=True))
        self.assertIn('ordered_immutable_ingress',self.sql('UPDATE public.odin_inbox SET payload=\'{}\' WHERE conversation_id='+base.literal(s[0])+';',error=True))
        self.assertEqual(self.pg.sql("SELECT pg_get_functiondef(oid)||coalesce(proacl::text,'') FROM pg_proc WHERE proname='odin_accept_knowledge_turn_v1';",db='foundation_test'),self.v1_before)
        self.assertEqual(self.booking_fingerprint(),self.booking_before)

    def test_v2_11_transaction_rollback_and_migration_guards(self):
        s=self.native_scope()
        self.sql("CREATE FUNCTION public.test_ordered_abort() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected ordered failure'; END$$; CREATE TRIGGER test_ordered_abort BEFORE INSERT ON public.odin_inbox FOR EACH ROW EXECUTE FUNCTION public.test_ordered_abort();",role='postgres')
        try:self.assertIn('injected ordered failure',self.sql(self.ordered_sql(s,'fail',self.order(s)),error=True))
        finally:self.sql('DROP TRIGGER test_ordered_abort ON public.odin_inbox; DROP FUNCTION public.test_ordered_abort();',role='postgres')
        self.assertIsNone(self.watermark(s));self.assertEqual(self.sql('SELECT count(*) FROM public.odin_inbox WHERE conversation_id='+base.literal(s[0])+';'),'0')
        self.assertEqual(self.sql('SELECT count(*) FROM public.odin_tasks WHERE conversation_id='+base.literal(s[0])+';'),'0')
        self.assertIn('separate_approval_required',self.sql(DRAFT.read_text(),role='postgres',error=True))
        self.assertIn('prerequisites',self.sql("SET odin.approved_ordered_knowledge_v2='yes';\n"+DRAFT.read_text(),role='postgres',error=True))

    def test_v2_12_verified_finalization_keeps_fencing_and_bookings_untouched(self):
        s=self.native_scope();a=self.ordered(s,'publication-current',self.order(s))
        t=self.native_command(s,a['task']['id'],'claim',{'owner':'a','leaseMs':15000})
        v=self.native_command(s,t['id'],'verified',{'owner':'a','fence':t['knowledge_fence'],'result':base.RESULT})
        receipt=self.receipt(s[0],v)
        out=self.native_command(s,t['id'],'finalize',{'owner':'a','fence':t['knowledge_fence'],'authority':receipt})
        self.assertIsNotNone(out);self.assertEqual(out['knowledge_kind'],'final')
        # A strictly newer authoritative order invalidates pending publication.
        self.ordered(s,'publication-next',self.order(s,1000))
        self.assertIsNone(self.native_command(s,t['id'],'claim_delivery',{'owner':'sender','leaseMs':15000,'deliveryId':out['id'],'authority':self.receipt(s[0],v,'send')}))
        self.assertEqual(self.sql('SELECT knowledge_state FROM public.odin_outbox WHERE id='+base.literal(out['id'])+';'),'SUPERSEDED')
        self.assertEqual(self.booking_fingerprint(),self.booking_before)

    def test_v2_13_legacy_enrollment_invalid_order_and_metadata_protection(self):
        cid=self.conversation();self.accept(cid,input_=None)
        s=(cid,'whatsapp',77,'acct','whatsapp:acct:'+cid)
        self.assertIn('legacy_conversation_requires_drain',self.sql(self.ordered_sql(s,'legacy-new-attempt',self.order(s)),error=True))
        for order in [{'atMs':self.at,'sequence':1},{'atMs':0,'sequence':None},{'atMs':self.at+0.5,'sequence':None},
                      {'atMs':self.at,'sequence':None,'unsafe':'field'}]:
            q=self.native_scope();self.assertIn('invalid_native_order',self.sql(self.ordered_sql(q,'bad',order),error=True));self.assertIsNone(self.watermark(q))
        q=self.native_scope();self.ordered(q,'known',self.order(q))
        self.assertIn('ordered_fence_required',self.sql("UPDATE public.odin_conversations SET aggregate_meta='{}' WHERE id="+base.literal(q[0])+';',error=True))
        # Normal unrelated metadata updates may preserve the reserved namespace.
        self.sql("UPDATE public.odin_conversations SET aggregate_meta=aggregate_meta||'{\"unrelated\":true}'::jsonb WHERE id="+base.literal(q[0])+';')
        self.assertEqual(self.watermark(q)['state'],'ACTIVE')

    def test_v2_14_concurrent_ties_and_cross_conversation_duplicate_rollback(self):
        for channel in ['whatsapp','instagram','messenger']:
            s=self.native_scope(channel)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                values=list(pool.map(lambda event:self.ordered(s,event,self.order(s)),['tie-'+str(uuid.uuid4()),'tie-'+str(uuid.uuid4())]))
            self.assertEqual(sorted(v['disposition'] for v in values),['ACCEPTED','AMBIGUOUS'])
            self.assertEqual(self.watermark(s)['state'],'TIED')
            executable=next(v['task'] for v in values if v['task'] is not None)
            self.assertIsNone(self.native_command(s,executable['id'],'claim',{'owner':'worker','leaseMs':1000}))
        scopes=[self.native_scope(),self.native_scope()];event=str(uuid.uuid4())
        def attempt(scope):
            try:return self.ordered(scope,event,self.order(scope))
            except AssertionError as error:
                self.assertTrue('duplicate key' in str(error) or 'existing_event_requires_review' in str(error))
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:values=list(pool.map(attempt,scopes))
        self.assertEqual(sum(v is not None for v in values),1)
        loser=scopes[values.index(None)]
        self.assertIsNone(self.watermark(loser))

if __name__=='__main__':unittest.main(verbosity=2)
