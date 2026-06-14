import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');
code = code.replace(/getCalendarAdapter\(\{\}\)/g, 'getCalendarAdapter(activeConfig)');
fs.writeFileSync('server.ts', code);
