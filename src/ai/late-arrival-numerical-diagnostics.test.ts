import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,lstatSync,readdirSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRequestedFacets,parseAnswerUnits,buildEvidenceFirstAnswer,InformationBudget,type Evidence} from './business-information-answer-plan';
import {assessNumericalConstraint} from './numerical-constraints';
import {withPrivateLateArrivalNumericalDiagnostics as capture,LATE_ARRIVAL_DIAGNOSTIC_QUESTION as question} from './late-arrival-numerical-diagnostics';
const audited=JSON.parse(readFileSync(new URL('../../tests/fixtures/cancellation-business3-audited-20261101.json',import.meta.url),'utf8'));
const evidence:Evidence[]=audited.sources.map((s:any,i:number)=>({id:`e${i+1}`,sourceId:s.id,chunkId:`c${i}`,version:'fixture-r1',businessId:3,text:s.content}));
const pdf=evidence.find(e=>e.sourceId===audited.sources.find((s:any)=>s.title.endsWith('.pdf')).id)!;
const quote=pdf.text.match(/Vid en försening[^]+?enligt plan\./u)![0];
const scope={businessId:3,question,language:'es'};
const facets=parseRequestedFacets([{subject:'customer request',attribute:question,questionType:'description'}]).facets;
function unit(text='Con más de 16 minutos de retraso el estudio puede necesitar evaluar la visita.'){
 return{facetIds:['f1'],text,subject:'studio',predicate:'assessment',value:'16 minutos',scope:'fictional test visitor policy',
  qualifiers:['Según la información ficticia de prueba.'],modality:'descriptive',negation:false,language:'es',
  evidenceRefs:[{evidenceId:pdf.id,exactQuote:quote}]};
}
function setup(t:any){
 const root=mkdtempSync(join(tmpdir(),'odinlink-private-numeric-'));chmodSync(root,0o700);
 const old={...process.env};Object.assign(process.env,{NODE_ENV:'test',ODINLINK_PRIVATE_NUMERICAL_DIAGNOSTICS:'fixture-v1'});
 t.after(()=>{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);rmSync(root,{recursive:true,force:true});});
 return root;
}
function parse(raw:any,ev:readonly Evidence[]=evidence,context:any=scope){return parseAnswerUnits({units:[raw]},facets,ev,'es',()=>{},'quotation',context);}
function load(result:any){assert.equal(result.capture,'written');return JSON.parse(readFileSync(result.path,'utf8'));}
test('rejected proposal is captured before local loss, with full permitted text, bindings and precise numeric comparison',async t=>{
 const root=setup(t),raw=unit();const events:any[]=[];
 const result=await capture({...scope,directory:root},async()=>parseAnswerUnits({units:[raw]},facets,evidence,'es',e=>events.push(e),'quotation',scope));
 assert.equal(result.value.units.length,0);assert.equal(events[0].reason,'NUMERICAL_CONSTRAINT');
 const record=load(result).records[0];assert.equal(record.unitId,'u1');
 assert.equal(record.claim.text.text,raw.text);assert.equal(record.claim.text.status,'complete');
 assert.equal(record.numerical.safe,false);assert.equal(record.numerical.reason,'SOURCE_VALUE_MISSING');
 assert.deepEqual(record.numerical.checks[0].constraints[0],{seconds:960,bound:'strict_minimum',side:'none',ambiguous:false});
 assert.equal(record.numerical.sources[0].constraints[0].seconds,900);
 const c=record.citations[0];assert.equal(pdf.text.slice(c.startUtf16,c.endUtf16),quote);assert.equal(c.sourceId,pdf.sourceId);
 assert.equal(lstatSync(result.path!).mode&0o777,0o600);assert.equal(lstatSync(result.path!.replace(/\/numerical.json$/u,'')).mode&0o777,0o700);
});
test('genuine replay u2 loss is not reconstructed; a deterministic u2 fixture exercises that precise boundary',async t=>{
 const root=setup(t),valid=unit('Con más de 15 minutos de retraso el estudio puede necesitar evaluar la visita.');
 const result=await capture({...scope,directory:root},async()=>parseAnswerUnits({units:[valid,unit()]},facets,evidence,'es',()=>{},'quotation',scope));
 assert.deepEqual(result.value.units.map(u=>u.id),['u1']);const records=load(result).records;
 assert.equal(records[0].numerical.safe,true);assert.equal(records[1].unitId,'u2');assert.equal(records[1].numerical.safe,false);
});
test('private capture preserves permitted qualifications longer than the old witness limit',async t=>{
 const root=setup(t),raw=unit();raw.qualifiers=['Según la información ficticia de prueba, la visita no se cancela automáticamente; el personal debe evaluar primero la situación. Según la información ficticia de prueba.'];
 assert.ok(raw.qualifiers[0].length>100);
 const result=await capture({...scope,directory:root},async()=>parse(raw));
 const q=load(result).records[0].claim.qualifiers[0];assert.equal(q.status,'complete');assert.equal(q.text,raw.qualifiers[0]);
});
test('numeric decision details distinguish missing values, changed comparisons and ambiguous contextual cancellation numbers',()=>{
 const cases=[
  ['Con más de 16 minutos de retraso el estudio puede necesitar evaluar la visita.','SOURCE_VALUE_MISSING'],
  ['Con al menos 15 minutos de retraso el estudio puede necesitar evaluar la visita.','SOURCE_BOUND_ANCHOR_OR_SCOPE_MISMATCH'],
  ['Si llegas 20 minutos tarde, la cita no se cancela automáticamente.','CLAIM_AMBIGUOUS'],
 ]as const;
 for(const [text,reason]of cases)assert.equal(assessNumericalConstraint(text,text,[quote]).reason,reason);
});
for(const mode of ['flag-off','production','no-capability','tenant','question','language','scope-absent']as const)
test(`private diagnostics fail closed: ${mode}`,async t=>{
 const root=setup(t);if(mode==='flag-off')delete process.env.ODINLINK_PRIVATE_NUMERICAL_DIAGNOSTICS;
 if(mode==='production')process.env.NODE_ENV='production';
 if(mode==='no-capability'){parse(unit());assert.deepEqual(readdirSync(root),[]);return;}
 const context={...scope,...(mode==='tenant'?{businessId:4}:{}),...(mode==='question'?{question:'Other question'}:{}),...(mode==='language'?{language:'en'}:{})};
 const result=await capture({...context,directory:root},async()=>parse(unit(),evidence,mode==='scope-absent'?null:context));
 if(result.capture==='written')assert.deepEqual(load(result).records,[]);else assert.deepEqual(readdirSync(root),[]);
});
for(const mode of ['foreign-tenant','changed-source','changed-content','mixed-revision']as const)
test(`source isolation: ${mode}`,async t=>{
 const root=setup(t),changed=evidence.map(e=>({...e}));
 if(mode==='foreign-tenant')changed[0].businessId=4;
 if(mode==='changed-source')changed[0].sourceId='another-source';
 if(mode==='changed-content')changed[0].text+=' extra';
 if(mode==='mixed-revision')changed.push({...changed[0],id:'e3',text:'extra',version:'other-revision'});
 const result=await capture({...scope,directory:root},async()=>parse(unit(),changed));assert.deepEqual(load(result).records,[]);
});
test('only token-level redactions are retained; unrelated identifiers and long qualifiers never leak',async t=>{
 const root=setup(t),raw=unit();const secret=audited.sources.find((s:any)=>s.title.endsWith('.txt')).content.match(/BLÅ[^\s.]+/u)![0];
 raw.subject='UnrelatedPerson';raw.qualifiers=[`Según la información ficticia de prueba, contacta person@example.com https://secret.invalid +46701234567 sk-secretvalue ${secret}`];
 const result=await capture({...scope,directory:root},async()=>parse(raw)),text=readFileSync(result.path!,'utf8');
 for(const forbidden of ['UnrelatedPerson','person@example.com','secret.invalid','46701234567','sk-secretvalue',secret])assert.ok(!text.includes(forbidden));
 const record=load(result).records[0];assert.equal(record.claim.text.status,'complete');assert.equal(record.claim.subject.status,'redacted');
});
test('unsafe or symlinked capture roots are refused without changing parsing',async t=>{
 const root=setup(t);chmodSync(root,0o755);
 const result=await capture({...scope,directory:root},async()=>parse(unit()));assert.equal(result.capture,'refused');assert.equal(result.value.units.length,0);
 chmodSync(root,0o700);const alias=root+'-alias';symlinkSync(root,alias);t.after(()=>rmSync(alias));
 assert.equal((await capture({...scope,directory:alias},async()=>parse(unit()))).capture,'refused');
});
test('concurrent requests have independent files, keys and a six-record bound',async t=>{
 const root=setup(t),results=await Promise.all([0,1].map(async()=>capture({...scope,directory:root},async()=>{
  for(let i=0;i<9;i++){await Promise.resolve();parse(unit());}return true;
 })));
 assert.notEqual(results[0].path,results[1].path);const a=load(results[0]),b=load(results[1]);
 assert.equal(a.records.length,6);assert.equal(b.records.length,6);
 assert.notEqual(a.records[0].claim.text.fingerprint,b.records[0].claim.text.fingerprint);
});
test('capture is never sent to ordinary logs and preserves the parser decision',async t=>{
 const root=setup(t);for(const method of ['log','info','warn','error']as const)t.mock.method(console,method,()=>assert.fail('private diagnostics logged'));
 const expected=parse(unit());const result=await capture({...scope,directory:root},async()=>parse(unit()));assert.deepEqual(result.value,expected);
});
test('a diagnostic write failure does not change the product decision',async t=>{
 const root=setup(t);const result=await capture({...scope,directory:root},async()=>{const value=parse(unit());rmSync(root,{recursive:true});return value;});
 assert.equal(result.capture,'write_failed');assert.equal(result.value.units.length,0);
});
test('refused capture never retries failed work, and accepted capture flushes before rethrowing',async t=>{
 const root=setup(t),error=new Error('work failed');let calls=0;chmodSync(root,0o755);
 await assert.rejects(capture({...scope,directory:root},async()=>{calls++;throw error;}),e=>e===error);
 assert.equal(calls,1);chmodSync(root,0o700);
 await assert.rejects(capture({...scope,directory:root},async()=>{parse(unit());throw error;}),e=>e===error);
 const directory=join(root,readdirSync(root)[0]);assert.equal(JSON.parse(readFileSync(join(directory,'numerical.json'),'utf8')).records.length,1);
});
test('the native answer core supplies the exact diagnostic scope and cannot publish a rejected unit',async t=>{
 const root=setup(t);let stages=0;
 const result=await capture({...scope,directory:root},async()=>buildEvidenceFirstAnswer({...scope,facets,evidence,foreground:true,
  authoritativeEvidence:'{}',businessTone:{},history:[],budget:new InformationBudget(),current:async()=>true,
  generate:async()=>{stages++;return{text:JSON.stringify({units:[unit()]})};}}));
 assert.equal(stages,1);assert.equal(result.value.units.length,0);assert.equal(load(result).records.length,1);
});
