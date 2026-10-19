import json,re,hashlib
from pathlib import Path
p=Path('docs/designs/progress-safety-migration-package');s=json.loads((p/'production-before.json').read_text()); checks={}
files=[Path('docs/designs/async-knowledge-slice1/20261019081511_async_knowledge_lifecycle_slice1.sql.draft'),Path('docs/designs/ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft')]
for f in s['functions']:
 found=[]
 for src in files:
  text=src.read_text();m=re.search(r'create(?: or replace)? function public\.'+f['name']+r'\s*\(.*?\bas \$\$(.*?)\$\$',text,re.I|re.S)
  if m:found.append(m.group(1)==f['body'])
 checks[f['name']+'BodyExact']=any(found)
 checks[f['name']+'ServiceOnly']=not f['anon'] and not f['authenticated'] and f['service_role'] and not f['definer']
checks['fourTablesEmpty']=all(v==0 for v in s['counts'].values()) and len(s['counts'])==4
checks['noPolicies']=not s['policies']
checks['progressAbsent']=not any('progress' in f['name'] for f in s['functions']) and not any('progress' in t['name'] for t in s['triggers'])
checks['constraintsValid']=all(c['valid'] for c in s['constraints'])
checks['indexesValid']=all(c['valid'] and c['ready'] for c in s['indexes'])
checks['rlsAndGrants']=all(t['rls'] and all((all(not x[k] for k in ['select','insert','update','delete']) if x['role']!='service_role' else all(x[k] for k in ['select','insert','update','delete'])) for x in t['privileges']) for t in s['tables'] if t['name'].startswith('odin_'))
(p/'preflight-checks.json').write_text(json.dumps(checks,indent=2)+'\n');print(checks)
