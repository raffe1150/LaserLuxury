/** SCRIPTED producer responses for contract tests; never multilingual quality evidence. */
import {InMemoryKnowledgeStorage,KnowledgeService,type KnowledgeSource} from '../../knowledge';
import {canonicalAdapterContent,canonicalDocument} from '../../src/knowledge/documents/canonical';
import {HierarchicalSearchIndex,InMemorySearchGenerations,type InjectedSearchProducer} from '../../src/knowledge/hierarchical-search';
export const declaration='Alle Angaben sind erfunden und nur für einen Test bestimmt.';
export const policy='Wertgegenstände werden getrennt registriert.';
export const exception='Ausgenommen von dieser Registrierung sind gefährliche Gegenstände.';
export const condition='Vor der Abholung muss der Gegenstand beschrieben werden.';
export async function hierarchicalFixture(count=4,padding=0,format='pdf'){
  const blocks=Array.from({length:count},(_,index)=>({text:(index===0?declaration:index===1?policy:index===Math.floor(count/2)?exception:index===count-1?condition:`Abschnitt ${index}: Allgemeine Hinweise.`)+'x'.repeat(padding),
    page:index+1,kind:('section' as const),heading:`Section ${index}`}));
  const adapted=canonicalAdapterContent({format,adapterVersion:'synthetic-adapter-v1',blocks});
  const source:KnowledgeSource={id:'guide',businessId:77,type:'document',status:'ready',title:'Guide.'+format,...adapted,createdAt:'2026',updatedAt:'1'};
  const storage=new InMemoryKnowledgeStorage();await storage.create(source);
  const repository=new InMemorySearchGenerations();let calls=0;
  const producer:InjectedSearchProducer={mode:'offline-injected',version:'SCRIPTED-contract-v1',
    generate:async input=>{calls++;return{hints:input.chunks.filter(c=>/Wertgegenstände|Värdesaker/u.test(c.text)).flatMap(chunk=>
      (['document','section','chunk'] as const).flatMap(level=>(['fa','es'] as const).map(language=>({level,
        nodeId:level==='document'?input.sourceId:level==='section'?chunk.sectionId:chunk.id,chunkId:chunk.id,quote:chunk.text,
        language,phrases:[language==='fa'?'اشیای باارزش':'objetos de valor']}))))};},
    verify:async input=>{calls++;return{acceptedIds:input.hints.map(h=>h.id),reviewedChunkIds:input.chunks.map(c=>c.id)};}};
  const index=new HierarchicalSearchIndex(id=>storage.list(id),repository,producer,{enabled:true,businessIds:[77],maxRequests:400});
  const service=new KnowledgeService(storage,storage,null,false,index);
  return{source,storage,repository,producer,index,service,document:canonicalDocument(source),calls:()=>calls};
}
