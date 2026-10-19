"""Offline comparison of read-only JSON snapshots; no database access."""
import json,re,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
before=json.loads((HERE/'production-before.json').read_text())
after=json.loads(Path(sys.argv[1]).read_text())
new={'odin_claim_knowledge_progress_v1','odin_guard_knowledge_progress_dispatch_v1'}
assert {f['name'] for f in after['functions']}=={f['name'] for f in before['functions']}|new
assert [f for f in after['functions'] if f['name'] not in new]==before['functions']
source=(HERE.parents[2]/'docs/designs/knowledge-progress-safety-v1/progress-safety-v1.sql.draft').read_text()
for f in after['functions']:
 if f['name'] in new:
  body=re.search(r'create function public\.'+f['name']+r'\s*\(.*?\bas \$\$(.*?)\$\$',source,re.I|re.S).group(1)
  assert f['body']==body and not f['definer'] and not f['anon'] and not f['authenticated'] and f['service_role']
  assert "SET search_path TO 'pg_catalog', 'public'" in f['definition']
for k in ['tables','columns','constraints','indexes','policies','booking','counts']:
 assert after[k]==before[k],k+' changed'
old=[t for t in after['triggers'] if t['name']!='odin_guard_knowledge_progress_dispatch_v1']
assert old==before['triggers']
t=[t for t in after['triggers'] if t['name']=='odin_guard_knowledge_progress_dispatch_v1']
assert len(t)==1 and t[0]['table']=='odin_outbox' and t[0]['enabled']=='O'
assert t[0]['definition']=='CREATE TRIGGER odin_guard_knowledge_progress_dispatch_v1 BEFORE INSERT OR UPDATE ON public.odin_outbox FOR EACH ROW EXECUTE FUNCTION odin_guard_knowledge_progress_dispatch_v1()'
print('PASS: exact additive functions/trigger; old schema, security, Booking, and empty counts unchanged')
