import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

content = content.replace(
/  if \(Date\.now\(\) < globalWaitUntil\) \{\s*const waitTime = globalWaitUntil - Date\.now\(\);\s*console\.warn\([^)]+\);\s*await new Promise[^;]+;\s*\}/m,
  "// Removed global wait checking"
);

fs.writeFileSync("server.ts", content);
