import fs from "fs";
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync("agent-config.json", "utf8"));
} catch(e){}
cfg.adminTelegramChatId = "174851440";
fs.writeFileSync("agent-config.json", JSON.stringify(cfg, null, 2));
