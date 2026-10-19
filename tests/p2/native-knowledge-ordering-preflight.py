#!/usr/bin/env python3
"""Characterize native-ordering prerequisite using exact installed SQL locally.
Passing tests confirm the limitation; they do NOT certify native integration.
No existing database URL, project environment or customer data is accepted.
"""
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import threading
import sys
import unittest
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('foundation_local_harness', HERE / 'knowledge-foundation-postgres.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class NativeOrderingPreflight(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = base.LocalCluster()
        cls.addClassCleanup(cls.pg.close)
        cls.pg.sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; '
                   'CREATE TABLE public.businesses(id bigint PRIMARY KEY); INSERT INTO public.businesses VALUES(77);')
        wrappers = base.ROOT / 'docs/designs/knowledge-migration-wrappers'
        for name, digest in [('foundation', '89472b7d676dfc005ec9345c3810225422f38fa688be47df6d3089e224e29b49'),
                             ('extension', '269dfd172d21840b9f610da4697479a8176052d9faafff45e02d5210b365f038')]:
            payload = (wrappers / (name + '.sql.payload')).read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise AssertionError('Pinned payload mismatch: ' + name)
            cls.pg.sql(payload.decode('utf8'))
        print('Disposable PostgreSQL ' + cls.pg.sql('SHOW server_version;') + '; TCP disabled; exact pinned wrappers.', flush=True)

    def scope(self, channel):
        conversation = str(uuid.uuid4())
        self.pg.sql('INSERT INTO public.odin_conversations(id,business_id,conversation_key) VALUES(' +
                    base.literal(conversation) + ',77,' + base.literal('synthetic-' + conversation) + ');', role='service_role')
        return conversation, channel

    def accept(self, scope, event, knowledge=True):
        conversation, channel = scope
        return json.loads(self.pg.sql('SELECT public.odin_accept_knowledge_turn_v1(77,' + base.literal(conversation) + ',' +
                          base.literal(channel) + ",'synthetic-account'," + base.literal(conversation + ':' + event) + ',' +
                          (base.jb(base.INPUT) if knowledge else 'NULL') + ',120000,3,4);', role='service_role'))

    def claim(self, scope, task):
        conversation, channel = scope
        return json.loads(self.pg.sql('SELECT public.odin_transition_knowledge_v1(77,' + base.literal(conversation) + ',' +
                          base.literal(task) + ',' + base.literal(channel) + ",'synthetic-account','claim'," +
                          base.jb({'owner': 'synthetic-worker', 'leaseMs': 15000}) + ');', role='service_role') or 'null')

    def demonstrate_delayed_event(self, channel, restart=False):
        scope = self.scope(channel)
        newer = self.accept(scope, 'provider-event-102')
        self.assertEqual(newer['inbox']['knowledge_sequence'], 1)
        # Capture a successful current-turn processing claim before delayed ingress.
        self.assertIsNotNone(self.claim(scope, newer['task']['id']))
        if restart:
            self.pg.restart()
        # This distinct event is older at the provider. Its ordering is known by
        # the authenticated adapter, but cannot be conveyed to this RPC.
        older = self.accept(scope, 'provider-event-101', knowledge=False)
        self.assertEqual(older['inbox']['knowledge_sequence'], 2)
        self.assertIsNone(older['inbox']['turn_sequence'])
        self.assertEqual(older['inbox']['payload'], {})
        # Duplicate delivery of the genuinely newer event cannot restore it.
        duplicate = self.accept(scope, 'provider-event-102')
        self.assertEqual(duplicate['inbox']['knowledge_sequence'], 1)
        self.assertFalse(duplicate['inserted'])
        self.assertIsNone(self.claim(scope, newer['task']['id']))
        state = self.pg.sql('SELECT knowledge_state FROM public.odin_tasks WHERE id=' + base.literal(newer['task']['id']) + ';')
        self.assertEqual(state, 'SUPERSEDED')
        attached_older = self.accept(scope, 'provider-event-101')
        self.assertEqual(attached_older['inbox']['knowledge_sequence'], 2)
        self.assertIsNotNone(self.claim(scope, attached_older['task']['id']))
        self.assertEqual(self.pg.sql('SELECT count(*) FROM public.odin_outbox WHERE conversation_id=' + base.literal(scope[0]) + ';'), '0')

    def test_01_delayed_distinct_events_take_ownership_on_each_channel(self):
        for channel in ['whatsapp', 'telegram', 'instagram', 'messenger']:
            with self.subTest(channel=channel):
                self.demonstrate_delayed_event(channel)

    def test_02_ordering_information_is_not_recovered_after_database_restart(self):
        self.demonstrate_delayed_event('telegram', restart=True)

    def test_03_external_precheck_is_not_atomic_with_acceptance(self):
        scope = self.scope('telegram')
        checked, newer_committed = threading.Event(), threading.Event()
        def delayed_older_worker():
            # Even a database precheck can pass before a newer worker commits.
            self.assertEqual(self.pg.sql('SELECT knowledge_sequence FROM public.odin_conversations WHERE id=' + base.literal(scope[0]) + ';'), '0')
            checked.set()
            if not newer_committed.wait(10):
                raise AssertionError('newer worker did not commit')
            return self.accept(scope, 'provider-event-101', knowledge=False)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(delayed_older_worker)
            self.assertTrue(checked.wait(10))
            try:
                newer = self.accept(scope, 'provider-event-102')
            finally:
                newer_committed.set()
            older = pending.result(timeout=15)
        self.assertGreater(older['inbox']['knowledge_sequence'], newer['inbox']['knowledge_sequence'])
        self.assertIsNone(self.claim(scope, newer['task']['id']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
