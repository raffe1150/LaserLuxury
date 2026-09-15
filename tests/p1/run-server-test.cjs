const fs=require('fs'),path=require('path'),cp=require('child_process'),esbuild=require('esbuild');
const out=path.join(__dirname,'.server.cjs');
try {
 esbuild.buildSync({stdin:{contents:fs.readFileSync('server.ts','utf8')+'\nexport const p1Internals={GenericCalendarAdapter,GoogleCalendarAdapter};',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',outfile:out,logLevel:'silent'});
 const r=cp.spawnSync(process.execPath,['--require',path.join(__dirname,'offline-network.cjs'),'--import','tsx',path.join(__dirname,process.argv[2])],{stdio:'inherit',env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',ODINLINK_LOCAL_TEST_MODE:'true',DOTENV_CONFIG_PATH:'/dev/null',GEMINI_API_KEY:'synthetic',TZ:'Europe/Stockholm'},timeout:60000});process.exitCode=r.status??1;
}finally{fs.rmSync(out,{force:true})}
