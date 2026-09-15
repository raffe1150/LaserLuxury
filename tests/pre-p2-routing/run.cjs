// Bundle private wrapper access only in a disposable offline test artifact.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const out=path.join(__dirname,'.server.cjs');
try {
 require('esbuild').buildSync({stdin:{contents:fs.readFileSync('server.ts','utf8')+`\nimport {detectNormalizedIntent} from './src/ai/booking-intelligence'; export const routingProbe={run:processWhatsAppMessageClaimed,snapshot:(id,text)=>({pending:pendingBookings[id]||null,pre:priority1hUnifiedEngineTestBoundary.whatsappPreDispatchDecision(id,text)}),intent:detectNormalizedIntent};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:out,logLevel:'silent'});
 const result=cp.spawnSync(process.execPath,['--require',path.join(__dirname,'offline-network.cjs'),path.join(__dirname,'routing.test.cjs')],{stdio:'inherit',env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',ODINLINK_LOCAL_TEST_MODE:'true',DOTENV_CONFIG_PATH:'/dev/null',GEMINI_API_KEY:'synthetic',TZ:'Europe/Stockholm'},timeout:60000});
 process.exitCode=result.status??1;
} finally {fs.rmSync(out,{force:true});}
