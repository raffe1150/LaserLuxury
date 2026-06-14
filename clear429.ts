import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// 1. Remove the globalWaitUntil checking wait loop completely in generateContentWithFallback
content = content.replace(
/  if \(Date\.now\(\) < globalWaitUntil\) \{[\s\S]*?  \}\n\n  let response;/m,
  "  let response;"
);

// 2. Replace the catch block for 429
content = content.replace(
/  \} catch\(e: any\) \{[\s\S]*?throw e;\n  \}/m,
`  } catch(e: any) {
     const errorString = String(e.message || e);
     if (e.status === 429 || errorString.includes('429') || errorString.includes('RESOURCE_EXHAUSTED') || errorString.includes('quota') || errorString.includes('high demand')) {
        globalWaitUntil = 0; // Flush cache
        console.warn("Rate limit hit 429. Gracefully returning wait message.");
        return {
           text: "Systemet har extremt hög belastning just nu. Vänligen vänta 10 sekunder och försök igen.",
           functionCalls: []
        };
     }
     throw e;
  }`
);

fs.writeFileSync("server.ts", content);
