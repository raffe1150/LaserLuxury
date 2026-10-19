"""Deterministic local-only byte-preserving wrapper. No database/network access."""
from pathlib import Path
import hashlib
import json
ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'docs/designs/knowledge-progress-safety-v1/progress-safety-v1.sql.draft'
PIN='d93ee49ec845dcef99abc8e0f5e663b04b32a4338dc83809f85720e394aa8b04'
PREFIX=b"BEGIN;\nSET LOCAL odin.approved_knowledge_progress_safety_v1 = 'yes';\n"
def build():
    body=SOURCE.read_bytes()
    if hashlib.sha256(body).hexdigest()!=PIN: raise ValueError('V2 source hash mismatch; no output written')
    return PREFIX+body
if __name__=='__main__':
    payload=build(); target=Path(__file__).with_name('progress-safety-v1.sql')
    manifest={'source':str(SOURCE.relative_to(ROOT)),'sourceSha256':PIN,'sourceBytes':SOURCE.stat().st_size,
              'payload':target.name,'payloadSha256':hashlib.sha256(payload).hexdigest(),'payloadBytes':len(payload),
              'sourceOffset':len(PREFIX),'productionApplied':False,'automaticMigrationDiscovery':False}
    target.write_bytes(payload)
    target.with_name('manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
