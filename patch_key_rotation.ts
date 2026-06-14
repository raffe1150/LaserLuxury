import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

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
    
    // Fallback to the default key in agent-config if available
    if (fs.existsSync('agent-config.json')) {
        try {
            const cfg = JSON.parse(fs.readFileSync('agent-config.json', 'utf8'));
            if (cfg.apiKey) keys.push(cfg.apiKey);
        } catch (e) {}
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

if (!content.includes('let currentKeyIndex = 0;')) {
    content = content.replace(
      /let supabase: any = null;/g,
      keyRotationCode + "\\nlet supabase: any = null;"
    );
}

// Replace generateContentWithFallback signature
const oldSig = \`async function generateContentWithFallback(ai: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string }, retries = 3, retryDelay = 2000): Promise<any> {\`;
const newSig = \`async function generateContentWithFallback(aiInstance: GoogleGenAI, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string, apiKey?: string }, retries = 3, retryDelay = 2000): Promise<any> {
  const allKeys = getApiKeys(options.apiKey);
  let activeAi = aiInstance;
\`;

if (content.includes(oldSig)) {
    content = content.replace(oldSig, newSig);
}

// Replace generateContent loop
const oldGen = \`let response;
  try {
     response = await ai.models.generateContent(params);
  } catch(e: any) {
     console.warn("API Error in generateContentWithFallback:", String(e.message || e));
     throw e;
  }\`;

const newGen = \`let response;
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
  }\`;

if (content.includes(oldGen)) {
    content = content.replace(oldGen, newGen);
}

// Update invocations to include apiKey in options
content = content.replace(/generateContentWithFallback\\(ai, \\{/g, "generateContentWithFallback(activeAi, { apiKey: typeof apiKey !== 'undefined' ? apiKey : (typeof config !== 'undefined' ? config.apiKey : undefined),");
// But wait, the first argument is 'ai', so we need to either change it or leave it as ai.
// Wait! I replaced it with `activeAi` in the invocation? No! In the invocation it's `ai`, so I should leave it as `ai`.
content = content.replace(/generateContentWithFallback\\(activeAi, /g, 'generateContentWithFallback(ai, '); // rollback if messed up
content = content.replace(/generateContentWithFallback\\(ai, \\{/g, "generateContentWithFallback(ai, { apiKey: typeof apiKey !== 'undefined' ? apiKey : (typeof config !== 'undefined' ? config.apiKey : undefined),");

fs.writeFileSync("server.ts", content);
