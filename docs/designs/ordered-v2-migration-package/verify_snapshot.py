"""Offline comparison of read-only post-install snapshot. Never connects to a DB.
Usage: python3 verify_snapshot.py /path/to/exported-post-snapshot.json
Input is {"catalog": <snapshot>} or the snapshot object itself.
"""
import hashlib,json,re,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
BASE=HERE.parents[2]/'docs/validation/ordered-v2-migration-readiness-2026-10-19/production-evidence.json'
def normalized(value):
    if isinstance(value,list):return sorted([normalized(x) for x in value],key=lambda x:json.dumps(x,sort_keys=True))
    if isinstance(value,dict):return {k:normalized(v) for k,v in value.items()}
    return value
def verify(after):
    before=json.loads(BASE.read_text())['catalog'];after=after.get('catalog',after);checks={}
    for key in ['tables','columns','constraints','indexes','policies','booking','counts']:
        checks[key+'Unchanged']=normalized(before[key])==normalized(after[key])
    checks['allP2Empty']=all(v==0 for v in after['counts'].values())
    old={f['name']:f for f in before['functions']};new={f['name']:f for f in after['functions']}
    checks['v1FunctionsExactlyUnchanged']=all(new.get(k)==v for k,v in old.items())
    checks['exactFunctionInventory']=set(new)==set(old)|{'odin_accept_knowledge_turn_v2','odin_guard_native_order_v2'}
    source=(HERE.parents[2]/'docs/designs/ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft').read_text()
    expected={m.group(1):m.group(2) for m in re.finditer(r'create function public\.(\w+)\(.*? as \$\$(.*?)\$\$;',source,re.S)}
    checks['v2BodiesExact']=all(k in new and new[k]['body']==body for k,body in expected.items()) and len(expected)==2
    signatures={'odin_accept_knowledge_turn_v2':'p_business bigint, p_conversation uuid, p_channel text, p_account text, p_event text, p_key text, p_order jsonb, p_input jsonb, p_execution_ms integer, p_max_runs integer, p_max_models integer', 'odin_guard_native_order_v2':''}
    checks['v2SignaturesSearchPath']=all(k in new and new[k]['signature']==sig and "SET search_path TO 'pg_catalog', 'public'" in new[k]['definition'] for k,sig in signatures.items())
    checks['v2ServiceOnlyInvoker']=all(k in new and not new[k]['definer'] and not new[k]['anon'] and not new[k]['authenticated'] and new[k]['service_role']
        and new[k]['owner']=='postgres' and set(new[k]['acl'] or [])=={'postgres=X/postgres','service_role=X/postgres'} for k in expected)
    old_triggers={x['name']:x for x in before['triggers']};new_triggers={x['name']:x for x in after['triggers']}
    checks['v1TriggersUnchanged']=all(new_triggers.get(k)==v for k,v in old_triggers.items())
    extra={
      'odin_guard_native_order_conversation_v2':('odin_conversations','UPDATE'),
      'odin_guard_native_order_ingress_v2':('odin_inbox','UPDATE'),
      'odin_guard_native_order_task_v2':('odin_tasks','INSERT')}
    checks['exactTriggerInventory']=set(new_triggers)==set(old_triggers)|set(extra)
    checks['v2TriggerDefinitions']=all(k in new_triggers and new_triggers[k]['table']==table and new_triggers[k]['enabled']=='O' and
      new_triggers[k]['definition']==f'CREATE TRIGGER {k} BEFORE {operation} ON public.{table} FOR EACH ROW EXECUTE FUNCTION odin_guard_native_order_v2()'
      for k,(table,operation) in extra.items())
    return checks
if __name__=='__main__':
    checks=verify(json.loads(Path(sys.argv[1]).read_text()));print(json.dumps(checks,indent=2))
    sys.exit(0 if all(checks.values()) else 1)
