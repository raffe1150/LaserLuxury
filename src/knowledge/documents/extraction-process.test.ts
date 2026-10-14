import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtractionChild } from './extraction-process';

test('isolated extractor kills hung and memory-exhausting children and strips credentials',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-'));
  try {
    const hung=join(folder,'hung.cjs');writeFileSync(hung,"process.once('message',()=>setInterval(()=>{},1000));");
    await assert.rejects(runExtractionChild(hung,Buffer.from('Policy'),'x.txt','text/plain',400),/document_timeout/u);
    const memory=join(folder,'memory.cjs');writeFileSync(memory,"process.once('message',()=>{const retained=[];setInterval(()=>retained.push(Buffer.alloc(32*1024*1024,1)),5);});");
    await assert.rejects(runExtractionChild(memory,Buffer.from('Policy'),'x.txt','text/plain'),/document_memory/u);
    const env=join(folder,'env.cjs');writeFileSync(env,"process.once('message',()=>{process.send({sections:[{text:JSON.stringify(Object.keys(process.env))}]});});");
    const sections=await runExtractionChild(env,Buffer.from('Policy'),'x.txt','text/plain');
    assert.doesNotMatch(sections[0].text,/SUPABASE|KEY|TOKEN|SECRET|DATABASE/u);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('normal completion confirms extractor exit, preserves heap and strips credentials',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-reap-'));
  try {
    const path=join(folder,'normal.cjs');
    writeFileSync(path,`process.once('message',()=>{process.send({sections:[{text:JSON.stringify({pid:process.pid,heap:require('node:v8').getHeapStatistics().heap_size_limit,env:Object.keys(process.env)})}]});setInterval(()=>{},1000);});`);
    const sections=await runExtractionChild(path,Buffer.from('Policy'),'x.txt','text/plain');
    const info=JSON.parse(sections[0].text);
    assert.equal(info.heap,256*1024*1024);
    assert.doesNotMatch(info.env.join(','),/SUPABASE|KEY|TOKEN|SECRET|DATABASE/u);
    assert.throws(()=>process.kill(info.pid,0),(error:any)=>error.code==='ESRCH');
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('synchronously blocked extraction times out and crashed extraction is reaped',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-exit-'));
  try {
    const blocked=join(folder,'blocked.cjs');writeFileSync(blocked,"process.once('message',()=>{while(true){}});");
    await assert.rejects(runExtractionChild(blocked,Buffer.from('Policy'),'x.txt','text/plain',500),/document_timeout/u);
    const crashed=join(folder,'crashed.cjs');writeFileSync(crashed,"process.once('message',()=>process.exit(1));");
    await assert.rejects(runExtractionChild(crashed,Buffer.from('Policy'),'x.txt','text/plain'),/document_memory/u);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

// Independent parent-death/deadline tests use small blocked fixtures, not memory stress.
test('supervisor stops blocked extraction after server death and permits a fresh runtime',async()=>{
  const {fork,execFileSync}=await import('node:child_process');
  const {existsSync,readFileSync}=await import('node:fs');
  const {pathToFileURL}=await import('node:url');
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-orphan-'));
  let server: ReturnType<typeof fork>|undefined;let extractorPid:number|undefined;let supervisorPid:number|undefined;
  const waitFor=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('lifecycle wait timed out');await new Promise(r=>setTimeout(r,25));}};
  const running=(pid:number)=>{try{const state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();return !!state&&!state.startsWith('Z');}catch{return false;}};
  try {
    const marker=join(folder,'pid');const blocked=join(folder,'blocked.cjs');
    writeFileSync(blocked,`process.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,supervisor:process.ppid}));while(true){}});`);
    const entry=join(folder,'server.cjs');
    writeFileSync(entry,`import(${JSON.stringify(pathToFileURL(join(process.cwd(),'src/knowledge/documents/extraction-process.ts')).href)}).then(({runExtractionChild})=>runExtractionChild(${JSON.stringify(blocked)},Buffer.from('Policy'),'x.txt','text/plain').catch(()=>{}));`);
    server=fork(entry,[],{execArgv:['--import','tsx'],stdio:'ignore',env:{PATH:process.env.PATH,NODE_ENV:'test'}});
    await waitFor(()=>existsSync(marker));const info=JSON.parse(readFileSync(marker,'utf8'));extractorPid=info.pid;supervisorPid=info.supervisor;
    const exit=new Promise<void>(r=>server!.once('close',()=>r()));server.kill('SIGKILL');await exit;
    await waitFor(()=>!running(extractorPid!)&&!running(supervisorPid!));
    const normal=join(folder,'restart.cjs');writeFileSync(normal,"process.once('message',()=>process.send({sections:[{text:'Fresh runtime'}]}));");
    assert.equal((await runExtractionChild(normal,Buffer.from('Policy'),'x.txt','text/plain'))[0].text,'Fresh runtime');
  } finally {
    server?.kill('SIGKILL');for(const pid of [extractorPid,supervisorPid])if(pid&&running(pid)){try{process.kill(pid,'SIGKILL');}catch{}}
    rmSync(folder,{recursive:true,force:true});
  }
});
test('supervisor deadline holds while the server event loop is suspended',async()=>{
  const {fork,execFileSync}=await import('node:child_process');
  const {existsSync,readFileSync}=await import('node:fs');
  const {pathToFileURL}=await import('node:url');
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-deadline-'));
  let server:ReturnType<typeof fork>|undefined;let extractorPid:number|undefined;
  const waitFor=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('deadline wait timed out');await new Promise(r=>setTimeout(r,25));}};
  const running=(pid:number)=>{try{const state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();return !!state&&!state.startsWith('Z');}catch{return false;}};
  try {
    const marker=join(folder,'pid');const blocked=join(folder,'blocked.cjs');
    writeFileSync(blocked,`process.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));while(true){}});`);
    const entry=join(folder,'server.cjs');
    writeFileSync(entry,`import(${JSON.stringify(pathToFileURL(join(process.cwd(),'src/knowledge/documents/extraction-process.ts')).href)}).then(({runExtractionChild})=>runExtractionChild(${JSON.stringify(blocked)},Buffer.from('Policy'),'x.txt','text/plain',1200).catch(()=>{}));`);
    server=fork(entry,[],{execArgv:['--import','tsx'],stdio:'ignore',env:{PATH:process.env.PATH,NODE_ENV:'test'}});
    await waitFor(()=>existsSync(marker));extractorPid=Number(readFileSync(marker,'utf8'));
    server.kill('SIGSTOP');await waitFor(()=>!running(extractorPid!));server.kill('SIGCONT');
    const exit=new Promise<void>(r=>server!.once('close',()=>r()));await exit;
  } finally {
    server?.kill('SIGCONT');server?.kill('SIGKILL');if(extractorPid&&running(extractorPid)){try{process.kill(extractorPid,'SIGKILL');}catch{}}
    rmSync(folder,{recursive:true,force:true});
  }
});
test('unexpected supervisor crash stops its extractor before releasing the slot',async()=>{
  const {readFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-supervisor-crash-'));
  try {
    const marker=join(folder,'pid');const path=join(folder,'crash.cjs');
    writeFileSync(path,`process.once('message',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);});`);
    await assert.rejects(runExtractionChild(path,Buffer.from('Policy'),'x.txt','text/plain'),/document_unavailable/u);
    const pid=Number(readFileSync(marker,'utf8'));let state='';
    try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();}catch{}
    assert.ok(!state||state.startsWith('Z'),'extractor must be exited');
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('supervisor forwards a maximum-size synthetic upload within its bounded heap',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'odinlink-extractor-payload-'));
  try {
    const path=join(folder,'payload.cjs');
    writeFileSync(path,"process.once('message',job=>process.send({sections:[{text:String(Buffer.from(job.bytes,'base64').length)}]}));");
    assert.equal((await runExtractionChild(path,Buffer.alloc(5*1024*1024,65),'x.txt','text/plain'))[0].text,String(5*1024*1024));
  } finally {rmSync(folder,{recursive:true,force:true});}
});
