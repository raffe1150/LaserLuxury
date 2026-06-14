import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexGenerateContent = /async function generateContentWithFallback\(ai: GoogleGenAI, options: any\) \{[\s\S]*?\}\n\}/m;

const replacementGenerateContent = `async function generateContentWithFallback(ai: GoogleGenAI, options: any) {
  return {
    text: "Simulated response bypass",
    functionCalls: [],
    candidates: [{ content: { parts: [{ text: "Bypass" }] } }]
  };
}`;

code = code.replace(regexGenerateContent, replacementGenerateContent);

fs.writeFileSync('server.ts', code);
