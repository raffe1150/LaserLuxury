/** Citation repair changes whitespace only, never letters, punctuation or values.
 * Offsets are UTF-16 positions into the immutable raw chunk. */
export type CitationSubtype = 'EVIDENCE_ID'|'QUOTE_NOT_FOUND'|'AMBIGUOUS_QUOTE'|'TOKEN_BOUNDARY'|'WHITESPACE_MAPPED';
export function resolveEvidenceQuote(text: string, quote: string): { quote?: string; start?: number; end?: number; subtype?: CitationSubtype; typographyHint?: boolean } {
  if(!quote.trim()||quote.length>2400||text.length>9000)return {subtype:'QUOTE_NOT_FOUND'};
  const token = /[\p{L}\p{M}\p{N}_-]/u;
  const boundary = (start:number,end:number) => !(token.test(text[start]) && start > 0 && token.test(text[start-1])) &&
    !(token.test(text[end-1]) && end < text.length && token.test(text[end]));
  const exact = text.indexOf(quote);
  if (exact >= 0) {
    if (text.indexOf(quote,exact+1)>=0) return {subtype:'AMBIGUOUS_QUOTE'};
    return boundary(exact,exact+quote.length) ? {quote,start:exact,end:exact+quote.length} : {subtype:'TOKEN_BOUNDARY'};
  }
  const canonical = (raw:string) => {
    let value=''; const starts:number[]=[], ends:number[]=[];
    for(let i=0;i<raw.length;) {
      const start=i;
      if(/\s/u.test(raw[i])) {
        while(i<raw.length&&/\s/u.test(raw[i]))i++;
        // PDF text runs commonly leave a space before punctuation. No other
        // character is removed, including spaces between address/name tokens.
        if(!value||i===raw.length||(/[.,;:!?]/u.test(raw[i]) && (i+1===raw.length || /\s/u.test(raw[i+1]))))continue;
        value+=' ';starts.push(start);ends.push(i);
      } else {value+=raw[i];starts.push(i);ends.push(++i);}
    }
    return {value,starts,ends};
  };
  const source=canonical(text), candidate=canonical(quote).value;
  const at=candidate ? source.value.indexOf(candidate) : -1;
  if(at<0)return {subtype:'QUOTE_NOT_FOUND',typographyHint:/[\ufb00-\ufb06\u00ad]/u.test(text+quote)||text.replace(/\s/gu,'').includes(quote.replace(/\s/gu,''))};
  if(source.value.indexOf(candidate,at+1)>=0)return {subtype:'AMBIGUOUS_QUOTE'};
  const start=source.starts[at], end=source.ends[at+candidate.length-1];
  if(end-start>2400)return {subtype:'QUOTE_NOT_FOUND'};
  if(!boundary(start,end))return {subtype:'TOKEN_BOUNDARY'};
  return {quote:text.slice(start,end),start,end,subtype:'WHITESPACE_MAPPED'};
}

type LiteralEvidence = Readonly<{id:string;businessId:number;sourceId:string;chunkId:string;version:string;text:string}>;
export type LiteralEvidenceSnapshot = Readonly<{businessId:number;spans:readonly Readonly<LiteralEvidence & {start:0;end:number}>[]}>;
const literalSnapshots=new WeakSet<LiteralEvidenceSnapshot>();
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const identity=(e:LiteralEvidence)=>JSON.stringify([e.id,e.businessId,e.sourceId,e.chunkId,e.version,e.text]);
function validateLiteralInventory(businessId:number,items:readonly LiteralEvidence[]) {
  if(!Number.isSafeInteger(businessId)||businessId<=0)throw Error('literal_evidence_tenant_invalid');
  const ids=new Set<string>(),chunks=new Set<string>();
  for(const e of items){
    if(e.businessId!==businessId||[e.id,e.sourceId,e.chunkId,e.version,e.text].some(v=>typeof v!=='string'||!v.trim())||
      ids.has(e.id)||chunks.has(JSON.stringify([e.sourceId,e.chunkId])))throw Error('literal_evidence_snapshot_invalid');
    ids.add(e.id);chunks.add(JSON.stringify([e.sourceId,e.chunkId]));
  }
}
/** Backend-only, request-local literal spans. Null means choose v2 BEFORE dispatch;
 * invalid identity is an error, never a reason to fall back to a weaker binding. */
export function captureLiteralEvidence(businessId:number,items:readonly LiteralEvidence[]):LiteralEvidenceSnapshot|null {
  validateLiteralInventory(businessId,items);
  if(!items.length||items.some(e=>e.text.length>2400))return null;
  const snapshot=Object.freeze({businessId,spans:Object.freeze(items.map(e=>Object.freeze({
    id:e.id,businessId:e.businessId,sourceId:e.sourceId,chunkId:e.chunkId,version:e.version,text:e.text,start:0 as const,end:e.text.length,
  })))});
  literalSnapshots.add(snapshot);return snapshot;
}
/** Hydrate documentary refs only; catalog proposals are appended afterwards.
 * Invalid units keep their position/count and receive no usable citation. The
 * existing parser and parse-loss veto, not this helper, decide publication. */
export function hydrateLiteralEvidenceReferences(raw:unknown,snapshot:LiteralEvidenceSnapshot,current:readonly LiteralEvidence[]):unknown {
  if(!literalSnapshots.has(snapshot))throw Error('literal_evidence_snapshot_unowned');
  validateLiteralInventory(snapshot.businessId,current);
  if(!record(raw)||!Array.isArray(raw.units))return raw;
  const spans=new Map(snapshot.spans.map(e=>[e.id,e])),fresh=new Map(current.map(e=>[e.id,e]));
  return {...raw,units:raw.units.map(unit=>{
    if(!record(unit)||!Array.isArray(unit.evidenceRefs))return unit;
    const ids=new Set<string>(),refs=[];
    for(const ref of unit.evidenceRefs){
      if(!record(ref)||Object.keys(ref).length!==1||typeof ref.evidenceId!=='string'||ids.has(ref.evidenceId))return {...unit,evidenceRefs:[]};
      const span=spans.get(ref.evidenceId),now=fresh.get(ref.evidenceId);
      if(!span||!now||identity(span)!==identity(now))return {...unit,evidenceRefs:[]};
      ids.add(ref.evidenceId);
      refs.push({evidenceId:span.id,exactQuote:span.text.slice(span.start,span.end)});
    }
    return {...unit,evidenceRefs:refs};
  })};
}
