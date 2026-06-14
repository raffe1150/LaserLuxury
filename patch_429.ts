import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

const oldFunc = "async function generateContentWithFallback(ai: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string }) {";
const newFunc = "async function generateContentWithFallback(ai: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string }, retries = 3, retryDelay = 2000): Promise<any> {";

content = content.replace(oldFunc, newFunc);

const oldGen = `  const response = await ai.models.generateContent(params);
  const functionCalls = response.functionCalls ? response.functionCalls.map((fc: any) => ({`;

const newGen = `  let response;
  try {
     response = await ai.models.generateContent(params);
  } catch(e: any) {
     if ((e.status === 429 || (e.message && e.message.includes('429'))) && retries > 0) {
        console.warn(\`Rate limit hit 429. Retrying in \${retryDelay}ms...\`);
        await new Promise(r => setTimeout(r, retryDelay));
        return generateContentWithFallback(ai, options, retries - 1, retryDelay * 2);
     }
     throw e;
  }
  const functionCalls = response.functionCalls ? response.functionCalls.map((fc: any) => ({`;

content = content.replace(oldGen, newGen);

fs.writeFileSync("server.ts", content);
console.log("Patched generateContentWithFallback 429 handling.");
