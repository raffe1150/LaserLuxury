"""Deterministic local-only byte-preserving wrapper. No database/network access."""
from pathlib import Path
import hashlib
import json
ROOT=Path(__file__).resolve().parents[3]
SOURCE=ROOT/'docs/designs/ordered-native-admission/20261019120000_ordered_knowledge_admission_v2.sql.draft'
PIN='0a4c40d4092f74d0b87f2f331657dca69cf05f5f2065477d6fc097409efe1197'
PREFIX=b"BEGIN;\nSET LOCAL odin.approved_ordered_knowledge_v2 = 'yes';\n"
def build():
    body=SOURCE.read_bytes()
    if hashlib.sha256(body).hexdigest()!=PIN: raise ValueError('V2 source hash mismatch; no output written')
    return PREFIX+body
if __name__=='__main__':
    payload=build(); target=Path(__file__).with_name('ordered-admission-v2.sql')
    manifest={'source':str(SOURCE.relative_to(ROOT)),'sourceSha256':PIN,'sourceBytes':SOURCE.stat().st_size,
              'payload':target.name,'payloadSha256':hashlib.sha256(payload).hexdigest(),'payloadBytes':len(payload),
              'sourceOffset':len(PREFIX),'productionApplied':False,'automaticMigrationDiscovery':False}
    target.write_bytes(payload)
    target.with_name('manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))
