import fs from "fs";
let c = fs.readFileSync("server.ts", "utf8");
c = c.replaceAll(
  "const notifyText = `🔔 Ny bokning mottagen!\\n👤 Namn: ${args.name}\\n📞 Mobil: ${args.phone}\\n📅 Tid: ${args.dateTime}\\n🛠 Service: ${args.service}`;",
  "const notifyText = `🔔 Ny bokning mottagen!\\n👤 Namn: ${args.name}\\n📞 Mobil: ${args.phone}\\n📅 Tid: ${args.dateTime}`;"
);
fs.writeFileSync("server.ts", c);
