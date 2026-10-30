/** Offline repository/entrypoint proof. No remote availability or live Telegram claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import ts from 'typescript';
const evidence='docs/validation/shared-core-2026-10-22/netlify-retirement-controlled-gate-20261029';
const json=(f:string)=>JSON.parse(readFileSync(f,'utf8'));
const sha=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex');
const old=json(evidence+'/preservation-before.json');
function sourceFiles(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(e=>{
 const p=join(root,e.name);return e.isDirectory()?sourceFiles(p):/\.(?:tsx?|m?js|cjs)$/u.test(e.name)&&!e.name.includes('.test.')?[p]:[];
});}
function ast(f:string){return ts.createSourceFile(f,readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true);}
function imports(f:string){const found:string[]=[];const visit=(n:ts.Node)=>{
 if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier))found.push(n.moduleSpecifier.text);
 if(ts.isCallExpression(n)&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0])&&
  (n.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(n.expression)&&n.expression.text==='require'))found.push(n.arguments[0].text);
 ts.forEachChild(n,visit);
 };visit(ast(f));return found;}

test('retired deployable function and instructions are absent; no Netlify auto-discovery config remains',()=>{
 for(const f of ['netlify','NETLIFY_DEPLOY_README.md','netlify.toml','netlify.json','netlify.yml','netlify.yaml'])assert.equal(existsSync(f),false,f);
 for(const f of ['_redirects','public/_redirects','_headers','public/_headers'])if(existsSync(f))assert.doesNotMatch(readFileSync(f,'utf8'),/netlify|telegram-webhook/iu,f);
});
test('Netlify-only manifest dependency and its exclusive lock subtree removed; every other dependency unchanged',()=>{
 const before=json(evidence+'/package.json.before.txt'),now=json('package.json');
 assert.equal(before.devDependencies['@netlify/functions'],'^5.3.0');delete before.devDependencies['@netlify/functions'];assert.deepEqual(now,before);
 const a=json(evidence+'/package-lock.json.before.txt'),b=json('package-lock.json');
 assert.deepEqual(Object.keys(a.packages).filter(k=>!(k in b.packages)).sort(),['node_modules/@netlify/functions','node_modules/@netlify/types']);
 delete a.packages['node_modules/@netlify/functions'];delete a.packages['node_modules/@netlify/types'];delete a.packages[''].devDependencies['@netlify/functions'];assert.deepEqual(b,a);
 assert.deepEqual(b.packages[''].devDependencies,now.devDependencies);assert.deepEqual(b.packages[''].dependencies,now.dependencies);
 assert.ok(now.dependencies['@google/genai']);assert.ok(now.dependencies.googleapis);
});
test('active source imports and Render entrypoint never depend on the retired Netlify function or SDK',()=>{
 for(const f of ['server.ts','knowledge.ts',...sourceFiles('src'),...sourceFiles('scripts')])for(const name of imports(f))assert.doesNotMatch(name,/netlify|telegram-webhook/iu,`${f}: ${name}`);
 const manifest=json('package.json');assert.equal(manifest.scripts.start,'node dist/server.cjs');assert.match(manifest.scripts.build,/esbuild server\.ts/u);
 const render=readFileSync('render.yaml','utf8');assert.match(render,/buildCommand: npm ci && npm run build/u);assert.match(render,/startCommand: npm start/u);assert.doesNotMatch(render,/netlify/iu);
});
test('Express has no retired Telegram webhook route; authorized setup still enters guarded backend polling',()=>{
 const routes:{verb:string;path:string;node:ts.CallExpression}[]=[];const visit=(n:ts.Node)=>{
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText()==='app'&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0]))routes.push({verb:n.expression.name.text,path:n.arguments[0].text,node:n});
  ts.forEachChild(n,visit);
 };visit(ast('server.ts'));
 assert.equal(routes.some(r=>/netlify|telegram[-_]webhook/iu.test(r.path)),false);
 const setup=routes.find(r=>r.verb==='post'&&r.path==='/api/setup-telegram');assert.ok(setup);const call=setup.node.getText();
 assert.match(call,/requireAuth/u);assert.match(call,/requireBodyBusinessPermission\('settings\.manage'\)/u);assert.match(call,/createTelegramSetupHandler/u);assert.match(call,/startTelegramPolling/u);
});
test('every reviewed Render/runtime/source/catalog/schema/booking safeguard remains byte-identical',()=>{
 for(const [f,h]of Object.entries(old.renderPathSources))assert.equal(sha(f),h,f);
 assert.equal(sha('server.ts'),old.renderPathSources['server.ts']);assert.equal(sha('render.yaml'),json('docs/validation/shared-core-2026-10-22/controlled-trial-safeguards-20261029/preservation-before.json').geminiFiles['render.yaml']);
});
test('all protected historical evidence and the 317-entry experimental ledger are unchanged',()=>{
 for(const [f,h]of Object.entries(old.historicalFiles))assert.equal(sha(f),h,f);
 assert.equal(sha('docs/validation/shared-core-2026-10-22/source-aware-usage.json'),old.ledgerSha256);
 const l=json('docs/validation/shared-core-2026-10-22/source-aware-usage.json');assert.equal(l.calls.length,317);
 assert.equal(l.estimatedUsd,old.estimatedUsd);assert.equal(l.unmeteredReserveUsd,old.unknownReserveUsd);
});
