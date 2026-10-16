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
