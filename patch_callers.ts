import fs from "fs";
let content = fs.readFileSync("server.ts", "utf8");

content = content.replace(/generateContentWithFallback\(ai,/g, "generateContentWithFallback(null,");

fs.writeFileSync("server.ts", content);
