import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexTTS = /if \(voice && textResponse\) \{[\s\S]*?console\.error\("TTS sending failed:", e\);\n        \}\n      \}/m;

code = code.replace(regexTTS, `// TTS bypassed`);

fs.writeFileSync('server.ts', code);
