#!/usr/bin/env python3
"""Local wrapper validation, reusing all 22 real foundation SQL scenarios.
No network, hosted API, external database URL or migration execution tool calls.
History tests are labelled MODELS; they do not establish hosted API internals.
"""
import hashlib
import ctypes
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

base=load('foundation_harness',HERE/'knowledge-foundation-postgres.py')
wrapper=load('wrapper_builder',HERE/'knowledge-migration-wrapper.py')
ROOT=base.ROOT


class WrappedFoundationTests(base.FoundationTests):
    @classmethod
    def setUpClass(cls):
        cls.pg=base.LocalCluster(); cls.addClassCleanup(cls.pg.close)
        cls.pg.sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE DATABASE foundation_test; CREATE DATABASE reference_test;')
        for db in ['foundation_test','reference_test']:
            cls.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY); INSERT INTO public.businesses VALUES(77),(88); '
                       'CREATE TABLE public.appointments_leads(user_id text,platform text,ai_summary text);',db=db)
            cls.pg.sql((ROOT/'supabase/migrations/20260921120000_add_booking_slot_reservations_and_result_outbox.sql').read_text(),db=db)
            cls.pg.sql('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;',db=db)
        cls.booking_before=cls.booking_fingerprint()
        cls.payloads={name:wrapper.build(name)[0].decode() for name in wrapper.SOURCES}
        # Actual wrapped execution; Foundation completes and read-only checks
        # pass before the extension is submitted in a separate transaction.
        cls.pg.sql(cls.payloads['foundation'],db='foundation_test')
        cls.pg.sql("DO $$BEGIN IF (SELECT count(*) FROM pg_class WHERE relname IN ('odin_conversations','odin_inbox','odin_tasks','odin_outbox') AND relrowsecurity)<>4 THEN RAISE EXCEPTION 'foundation_not_verified'; END IF; END$$;",db='foundation_test')
        if cls.booking_fingerprint()!=cls.booking_before: raise AssertionError('Booking fingerprint changed')
        cls.pg.sql(cls.payloads['extension'],db='foundation_test')
        cls.pg.sql("SET odin.approved_p2_knowledge_foundation='yes';\n"+base.FOUNDATION.read_text(),db='reference_test')
        cls.pg.sql("SET odin.approved_knowledge_slice1='yes';\n"+base.EXTENSION.read_text(),db='reference_test')
        def dump(db):
            raw=subprocess.run(['pg_dump','-h',str(cls.pg.socket),'-p','55439','-U','postgres','-d',db,
                                '--schema-only','--schema=public'],env=cls.pg.env,text=True,capture_output=True,check=True).stdout
            # PostgreSQL 17.11 emits random psql restriction tokens, not schema.
            return '\n'.join(line for line in raw.splitlines() if not line.startswith(('\\restrict ','\\unrestrict ')))
        actual,reference=dump('foundation_test'),dump('reference_test')
        if actual!=reference: raise AssertionError('Wrapped schema/ACL/function dump differs from original execution')
        cls.schema_sha256=hashlib.sha256(actual.encode()).hexdigest()
        cls.version=cls.pg.sql('SHOW server_version;')
        print('PostgreSQL '+cls.version+'; wrapper/reference schema+grants+RLS+functions match: '+cls.schema_sha256,flush=True)

    def new_database(self,name):
        self.pg.sql('CREATE DATABASE '+name+';')
        self.pg.sql('CREATE TABLE public.businesses(id bigint PRIMARY KEY);',db=name)

    def test_23_exact_embedding_pins_and_mutation_rejection(self):
        for name,(path,pin,guard) in wrapper.SOURCES.items():
            original=(ROOT/path).read_bytes(); payload,manifest=wrapper.build(name)
            self.assertEqual(hashlib.sha256(original).hexdigest(),pin)
            self.assertEqual(payload[manifest['source_offset_bytes']:],original)
            self.assertEqual(hashlib.sha256(payload).hexdigest(),manifest['payload_sha256'])
            for changed in [original+b'\n',original.replace(b'begin;',b'BEGIN;',1)]:
                with self.assertRaisesRegex(ValueError,'hash_mismatch'): wrapper.build(name,changed)

    def test_24_local_settings_restore_prior_values_on_commit(self):
        self.new_database('context_test')
        setup="SET lock_timeout='13s'; SET statement_timeout='41s'; SET odin.approved_p2_knowledge_foundation='prior';\n"
        check="SELECT jsonb_build_array(current_setting('lock_timeout'),current_setting('statement_timeout'),current_setting('odin.approved_p2_knowledge_foundation',true));"
        result=self.pg.sql(setup+self.payloads['foundation']+'\n'+check,db='context_test')
        self.assertEqual(json.loads(result),['13s','41s','prior'])

    def test_25_standalone_stop_on_error_and_no_partial_extension(self):
        self.new_database('failure_wrapper_test')
        error=self.pg.sql(self.payloads['extension'],db='failure_wrapper_test',error=True)
        self.assertIn('missing_P2_table',error)
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_class WHERE relname LIKE 'odin_%';",db='failure_wrapper_test'),'0')
        guard=wrapper.SOURCES['extension'][2]
        self.assertNotEqual(self.pg.sql("SELECT coalesce(current_setting("+base.literal(guard)+",true),'');",db='failure_wrapper_test'),'yes')

    def test_26_rerun_fails_without_schema_or_booking_changes(self):
        fingerprint=self.booking_fingerprint()
        self.assertIn('existing_relation_requires_review',self.pg.sql(self.payloads['foundation'],db='foundation_test',error=True))
        self.assertEqual(self.booking_fingerprint(),fingerprint)
        # Existing columns/functions are not replaced or silently skipped.
        self.assertIn('already exists',self.pg.sql(self.payloads['extension'],db='foundation_test',error=True))
        self.assertEqual(self.booking_fingerprint(),fingerprint)

    def test_27_history_model_can_record_full_payload_truthfully(self):
        self.new_database('history_model')
        self.pg.sql('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);',db='history_model')
        for order,name in enumerate(['foundation','extension'],1):
            payload=self.payloads[name]
            # Explicit local model of a manager storing the EXACT payload before
            # execution under the same transaction, NOT a claim about hosted API.
            record="INSERT INTO supabase_migrations.schema_migrations VALUES("+base.literal(str(order))+','+base.literal(name+'_wrapped_v1')+',ARRAY['+base.literal(payload)+']);\n'
            self.pg.sql('BEGIN;\n'+record+payload,db='history_model')
            returned=self.pg.sql('SELECT to_json(statements[1]) FROM supabase_migrations.schema_migrations WHERE version='+base.literal(str(order))+';',db='history_model')
            self.assertEqual(json.loads(returned).encode(),payload.encode())
        self.assertEqual(self.pg.sql("SELECT string_agg(name,',' ORDER BY version) FROM supabase_migrations.schema_migrations;",db='history_model'),
                         'foundation_wrapped_v1,extension_wrapped_v1')

    def test_28_outer_transaction_does_not_protect_late_history_failure(self):
        self.new_database('unsafe_envelope_model')
        self.pg.sql('CREATE TABLE public.test_history(version text PRIMARY KEY);',db='unsafe_envelope_model')
        # Counterexample: manager begins a transaction, executes the supplied
        # SQL, then writes history. Original COMMIT has already ended that tx.
        query='BEGIN;\n'+self.payloads['foundation']+"\nINSERT INTO public.test_history VALUES(NULL);"
        self.assertIn('null value',self.pg.sql(query,db='unsafe_envelope_model',error=True))
        self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_class WHERE relname IN ('odin_conversations','odin_inbox','odin_tasks','odin_outbox');",db='unsafe_envelope_model'),'4')
        self.assertEqual(self.pg.sql('SELECT count(*) FROM public.test_history;',db='unsafe_envelope_model'),'0')
        print('CONFIRMED COUNTEREXAMPLE: late history error leaves committed schema; hosted manager ordering must be established.',flush=True)

    def test_29_same_backend_rollback_restores_settings_and_history_model(self):
        self.new_database('same_backend_rollback')
        self.pg.sql('CREATE TABLE public.test_history(payload text);',db='same_backend_rollback')
        # Use the already installed PostgreSQL libpq, not a new Python package.
        # PQexec submits the full body in one message on one persistent backend.
        libdir=Path(subprocess.check_output(['pg_config','--libdir'],text=True).strip())
        library=next((libdir/name for name in ['libpq.dylib','libpq.so'] if (libdir/name).exists()),None)
        if library is None: self.fail('Installed PostgreSQL libpq not available for same-backend proof')
        pq=ctypes.CDLL(str(library)); ptr=ctypes.c_void_p; char=ctypes.c_char_p
        for name,args,ret in [
            ('PQconnectdbParams',[ctypes.POINTER(char),ctypes.POINTER(char),ctypes.c_int],ptr),
            ('PQstatus',[ptr],ctypes.c_int),('PQexec',[ptr,char],ptr),('PQresultStatus',[ptr],ctypes.c_int),
            ('PQntuples',[ptr],ctypes.c_int),('PQgetvalue',[ptr,ctypes.c_int,ctypes.c_int],char),
            ('PQresultErrorMessage',[ptr],char),('PQclear',[ptr],None),('PQfinish',[ptr],None),
            ('PQtransactionStatus',[ptr],ctypes.c_int)]:
            function=getattr(pq,name); function.argtypes=args; function.restype=ret
        keys=(char*6)(b'host',b'port',b'user',b'dbname',b'connect_timeout',None)
        values=(char*6)(str(self.pg.socket).encode(),b'55439',b'postgres',b'same_backend_rollback',b'5',None)
        connection=pq.PQconnectdbParams(keys,values,0)
        self.assertEqual(pq.PQstatus(connection),0)
        def execute(sql):
            result=pq.PQexec(connection,sql.encode())
            try:
                status=pq.PQresultStatus(result)
                value=pq.PQgetvalue(result,0,0).decode() if pq.PQntuples(result) else None
                return status,value,pq.PQresultErrorMessage(result).decode()
            finally: pq.PQclear(result)
        try:
            self.assertEqual(execute("SET lock_timeout='13s'; SET statement_timeout='41s'; SET odin.approved_knowledge_slice1='prior';")[0],1)
            payload=self.payloads['extension']
            record='INSERT INTO public.test_history VALUES('+base.literal(payload)+');\n'
            status,_,error=execute('BEGIN;\n'+record+payload)
            self.assertEqual(status,7); self.assertIn('missing_P2_table',error)
            self.assertEqual(pq.PQtransactionStatus(connection),3,'backend must be in aborted transaction')
            self.assertEqual(execute('ROLLBACK;')[0],1)
            self.assertEqual(pq.PQtransactionStatus(connection),0)
            _,value,_=execute("SELECT jsonb_build_array(current_setting('lock_timeout'),current_setting('statement_timeout'),current_setting('odin.approved_knowledge_slice1',true),(SELECT count(*) FROM public.test_history));")
            self.assertEqual(json.loads(value),['13s','41s','prior',0])
            self.assertEqual(execute("SELECT count(*) FROM pg_class WHERE relname LIKE 'odin_%';")[1],'0')
        finally: pq.PQfinish(connection)


if __name__=='__main__': unittest.main(verbosity=2)
