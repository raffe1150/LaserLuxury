import importlib.util,sys,unittest,hashlib,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
base=load('progress_suite',ROOT/'tests/p2/progress-safety-postgres.py')
builder=load('progress_builder',HERE/'build.py')
class WrappedProgress(base.ProgressSafety):
 @classmethod
 def setUpClass(cls):
  base.m.OrderedTests.setUpClass.__func__(cls)
  cls.old_functions=cls.pg.sql("SELECT jsonb_agg(jsonb_build_array(proname,pg_get_functiondef(oid),proacl) ORDER BY proname) FROM pg_proc WHERE proname IN ('odin_accept_knowledge_turn_v1','odin_accept_knowledge_turn_v2','odin_transition_knowledge_v1','odin_guard_native_order_v2','odin_guard_knowledge_identity_v1','odin_guard_knowledge_ingress_v1');",db='foundation_test')
  cls.pg.sql('CREATE DATABASE pre_progress TEMPLATE foundation_test; CREATE DATABASE reference_progress TEMPLATE foundation_test;')
  cls.payload=(HERE/'progress-safety-v1.sql').read_bytes()
  assert cls.payload==builder.build()
  cls.pg.sql(cls.payload.decode(),db='foundation_test')
  cls.pg.sql("SET odin.approved_knowledge_progress_safety_v1='yes';\n"+builder.SOURCE.read_text(),db='reference_progress')
  def dump(db):
   raw=subprocess.run(['pg_dump','-h',str(cls.pg.socket),'-p','55439','-U','postgres','-d',db,'--schema-only','--schema=public'],env=cls.pg.env,text=True,capture_output=True,check=True).stdout
   return '\n'.join(l for l in raw.splitlines() if not l.startswith(('\\restrict ','\\unrestrict ')))
  assert dump('foundation_test')==dump('reference_progress'),'raw/wrapper schema mismatch'
 def test_wrapper_01_local_setting_and_timeouts_restored(self):
     query="SET odin.approved_knowledge_progress_safety_v1='no'; SET lock_timeout='7s'; SET statement_timeout='45s';\n"
     self.pg.sql('CREATE DATABASE settings_progress TEMPLATE pre_progress;')
     result=self.pg.sql(query+self.payload.decode()+"SELECT current_setting('odin.approved_knowledge_progress_safety_v1')||','||current_setting('lock_timeout')||','||current_setting('statement_timeout');",db='settings_progress')
     self.assertEqual(result,'no,7s,45s')
 def test_wrapper_02_error_before_commit_rolls_back_every_new_object(self):
     self.pg.sql('CREATE DATABASE failure_progress TEMPLATE pre_progress;')
     # Failure injection is a test-only derived payload, never the review file.
     broken=self.payload.decode().replace('commit;','SELECT 1/0;\ncommit;')
     self.assertIn('division by zero',self.pg.sql(broken,db='failure_progress',error=True))
     self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_proc WHERE proname IN ('odin_claim_knowledge_progress_v1','odin_guard_knowledge_progress_dispatch_v1');",db='failure_progress'),'0')
     self.assertEqual(self.pg.sql("SELECT count(*) FROM pg_trigger WHERE tgname='odin_guard_knowledge_progress_dispatch_v1';",db='failure_progress'),'0')
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
 def test_wrapper_05_postcheck_snapshot_and_verifier(self):
  import json
  self.pg.sql('CREATE DATABASE postcheck_progress TEMPLATE pre_progress;')
  self.pg.sql('CREATE TABLE IF NOT EXISTS public.appointments(id bigint);',db='postcheck_progress')
  query=(HERE/'post-installation-snapshot.sql').read_text()
  before=json.loads(self.pg.sql(query,db='postcheck_progress'))
  self.pg.sql(self.payload.decode(),db='postcheck_progress')
  after=json.loads(self.pg.sql(query,db='postcheck_progress'))
  # Execute the exact offline verifier against synthetic snapshots, no live IO.
  code=(HERE/'verify_post_installation.py').read_text()
  prefix=code[:code.index('before=json.loads')]
  checks=code[code.index("new={'odin_claim"):]
  exec(prefix+checks,{'__file__':str(HERE/'verify_post_installation.py'),'before':before,'after':after})
if __name__=='__main__':unittest.main(verbosity=2)
