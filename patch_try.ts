import fs from "fs";
let content = fs.readFileSync("server.ts", "utf8");
content = content.replace(
  "      activeRequests.add(chatId);\n      const text = update.message.text;",
  "      activeRequests.add(chatId);\n      try {\n      const text = update.message.text;"
);
fs.writeFileSync("server.ts", content);
