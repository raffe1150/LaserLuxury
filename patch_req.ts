import fs from "fs";
let content = fs.readFileSync("server.ts", "utf8");

content = content.replace("return res.sendStatus(200);", "return;");

let newEnd = `      }
    } finally {
      activeRequests.delete(chatId);
    }
}


function sanitizeTTS`;
content = content.replace("    }\n}\n\n\nfunction sanitizeTTS", newEnd);

fs.writeFileSync("server.ts", content);
