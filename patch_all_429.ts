import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// 1. generateContentWithFallback: Parse RetryInfo
const genContentRegex = /async function generateContentWithFallback\(([\s\S]*?)(let response;\n\s*try \{[\s\S]*?\} catch\(e: any\) \{[\s\S]*?throw e;\n\s*\})/m;
const matchGen = content.match(genContentRegex);

if (matchGen) {
  const newCatch = `  let response;
  try {
     response = await ai.models.generateContent(params);
  } catch(e: any) {
     const errorString = String(e.message || e);
     if (e.status === 429 || errorString.includes('429') || errorString.includes('RESOURCE_EXHAUSTED')) {
        let requestedDelay = 0;
        const delayMatch = errorString.match(/"retryDelay"\s*:\s*"([0-9\.]+)s"/);
        if (delayMatch) {
            requestedDelay = parseFloat(delayMatch[1]) * 1000 + 1000;
        }
        const backoffDelay = requestedDelay > 0 ? requestedDelay : (10000 + Math.random() * 5000); 
        const delayToUse = retries > 0 ? Math.max(retryDelay, backoffDelay) : backoffDelay;
        globalWaitUntil = Date.now() + delayToUse;
        console.warn(\`Rate limit hit 429. DelayToUse: \${delayToUse}ms...\`);
        if (retries > 0) {
            await new Promise(r => setTimeout(r, delayToUse));
            return generateContentWithFallback(ai, options, retries - 1, delayToUse * 2);
        }
     }
     throw e;
  }`;
  content = content.replace(matchGen[2], newCatch);
}
fs.writeFileSync("server.ts", content);
console.log("Patched 429 fallback logic.");
