import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// Add key rotation logic near the top
const keyRotationCode = `
let currentKeyIndex = 0;

function getApiKeys(overrideKey?: string): string[] {
    const keys: string[] = [];
    if (overrideKey) {
        keys.push(overrideKey);
    }
    if (process.env.GEMINI_API_KEY) {
        keys.push(process.env.GEMINI_API_KEY);
    }
    if (process.env.GEMINI_API_KEYS) {
        keys.push(...process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k));
    }
    return Array.from(new Set(keys)).filter(k => k); // Unique and non-empty
}

function rotateKey(keys: string[]) {
    if (keys.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
        console.log("Rotated API key, now using index:", currentKeyIndex);
    }
}
`;

content = content.replace(
  /let supabase: any = null;/g,
  keyRotationCode + "\nlet supabase: any = null;"
);


// Replace generateContentWithFallback signature
const oldSig = `async function generateContentWithFallback(ai: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string }, retries = 3, retryDelay = 2000): Promise<any> {`;
const newSig = `async function generateContentWithFallback(aiInstance: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string, apiKey?: string }, retries = 3, retryDelay = 2000): Promise<any> {
  const allKeys = getApiKeys(options.apiKey);
  let activeAi = aiInstance;
`;
content = content.replace(oldSig, newSig);

// Replace ai.models.generateContent call with retry loop
const oldGen = `let response;
  try {
     response = await ai.models.generateContent(params);
  } catch(e: any) {
     console.warn("API Error in generateContentWithFallback:", String(e.message || e));
     throw e;
  }`;

const newGen = `let response;
  while (true) {
      try {
         response = await activeAi.models.generateContent(params);
         break; // Success
      } catch(e: any) {
         console.warn("API Error in generateContentWithFallback:", String(e.message || e));
         const eStr = String(e.message || e);
         if (eStr.includes('429') || eStr.includes('quota') || eStr.includes('RESOURCE_EXHAUSTED')) {
             if (allKeys.length > 1) {
                 rotateKey(allKeys);
                 const newKey = allKeys[currentKeyIndex];
                 activeAi = new GoogleGenAI({ apiKey: newKey });
                 console.log("Retrying request with new key...");
                 continue; // Retry with new key
             }
         }
         throw e; // Give up if no other keys or different error
      }
  }`;

content = content.replace(oldGen, newGen);

fs.writeFileSync("server.ts", content);
