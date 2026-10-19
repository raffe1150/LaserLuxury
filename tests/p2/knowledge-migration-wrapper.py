#!/usr/bin/env python3
"""Build INACTIVE review payloads. No database/network access or execution.
Pinned source bytes are embedded unchanged, including their BEGIN and COMMIT.
"""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
SOURCES={
 'foundation':('docs/designs/p2-knowledge-foundation/20261019084642_minimal_p2_knowledge_foundation.sql.draft',
               'a2f25ecc98bb273e3e9d7eaa3449dfc890201e31f45d932503a3b0bc78e2f525','odin.approved_p2_knowledge_foundation'),
 'extension':('docs/designs/async-knowledge-slice1/20261019081511_async_knowledge_lifecycle_slice1.sql.draft',
              '564f6f88e87db9f4577b9bff174c0087dcc348ee72c06c86a2e52dd4d4c2f1fb','odin.approved_knowledge_slice1'),
}

def build(name, source=None):
    path,pin,guard=SOURCES[name]
    original=(ROOT/path).read_bytes() if source is None else source
    if hashlib.sha256(original).hexdigest()!=pin:
        raise ValueError('pinned_migration_hash_mismatch:'+name)
    prefix=('BEGIN;\nSET LOCAL '+guard+" = 'yes';\n").encode('ascii')
    payload=prefix+original
    assert payload[len(prefix):]==original
    return payload,{'source':path,'source_sha256':pin,'source_offset_bytes':len(prefix),
                    'source_length_bytes':len(original),'payload_sha256':hashlib.sha256(payload).hexdigest(),
                    'guard':guard,'production_approved':False}

if __name__=='__main__':
    output=ROOT/'docs/designs/knowledge-migration-wrappers'
    built={name:build(name) for name in SOURCES}  # Validate BOTH pins before writing any artifact.
    output.mkdir(exist_ok=True)
    manifest={}
    for name in SOURCES:
        payload,entry=built[name]
        file=output/(name+'.sql.payload')
        file.write_bytes(payload)
        manifest[name]={**entry,'payload_file':str(file.relative_to(ROOT))}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
