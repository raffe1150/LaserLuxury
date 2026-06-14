import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// 1. Update CalendarAdapter
content = content.replace(
  "insertAppointment(name: string, dateTime: string): Promise<any> | any;",
  "insertAppointment(name: string, phone: string, service: string, dateTime: string): Promise<any> | any;"
);

// 2. Update MockCalendarAdapter
content = content.replace(
  "insertAppointment(name: string, dateTime: string) {",
  "insertAppointment(name: string, phone: string, service: string, dateTime: string) {"
);
content = content.replace(
  "const event = { id: String(this.events.length + 1), summary: `Booking for ${name}`, startTime: dateTime, endTime: dateTime };",
  "const event = { id: String(this.events.length + 1), summary: `Bokad: ${name} - ${phone}`, description: service, startTime: dateTime, endTime: dateTime };"
);

// 3. Update RemoteCalendarAdapter
content = content.replace(
  "async insertAppointment(name: string, dateTime: string) {",
  "async insertAppointment(name: string, phone: string, service: string, dateTime: string) {"
);
content = content.replace(
  "body: JSON.stringify({ name, dateTime })",
  "body: JSON.stringify({ name, phone, service, dateTime })"
);

// 4. Update GoogleCalendarAdapter
content = content.replace(
  "async insertAppointment(name: string, dateTime: string) {",
  "async insertAppointment(name: string, phone: string, service: string, dateTime: string) {"
);
content = content.replace(
  "summary: `Booking for ${name}`,",
  "summary: `Bokad: ${name} - ${phone}`,\n          description: service,"
);

// 5. Update calendarTools insertAppointment
content = content.replace(
  /name: "insertAppointment",[\s\S]*?required: \["name", "dateTime"\]/m,
  `name: "insertAppointment",
      description: "Creates an event in the configured calendar provider. Must check availability first. You are STRICTLY PROHIBITED from calling this until you have explicitly asked the user for both their Name and Mobile Number and received them.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "The customer's name." },
          phone: { type: "STRING", description: "The customer's mobile number. Must be explicitly collected." },
          service: { type: "STRING", description: "The service being booked." },
          dateTime: { type: "STRING", description: "The requested start time in ISO 8601 format." }
        },
        required: ["name", "phone", "service", "dateTime"]`
);

// 6. Update tool dispatch in processTelegramUpdate
content = content.replace(
  /else if \(call\.function\.name === "insertAppointment" && args\) adapterRes = await adapter\.insertAppointment\(args\.name, args\.dateTime\);/g,
  `else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime);
          const notifyToken = typeof config !== 'undefined' && config ? config.telegramToken : activeConfig?.telegramToken;
          const notifyAdmin = typeof config !== 'undefined' && config ? config.adminTelegramChatId : activeConfig?.adminTelegramChatId;
          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
             try {
                const notifyText = \`🔔 Ny bokning mottagen!\\n👤 Namn: \${args.name}\\n📞 Mobil: \${args.phone}\\n📅 Tid: \${args.dateTime}\\n🛠 Service: \${args.service}\`;
                await fetch(\`https://api.telegram.org/bot\${notifyToken}/sendMessage\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
                });
             } catch(e) { console.error("Admin notify error:", e); }
          }
        }`
);

// 7. Update explicit prompt enforcement
content = content.replace(
  /"\\nBOOKING RULES: Before calling `insertAppointment`, you must check availability\. If a user asks for a slot that is already booked, you must NOT book it\. Instead, politely inform them it's taken and look at the calendar to suggest next available slots\.";/g,
  `"\\nBOOKING RULES: 1. Before calling \`insertAppointment\`, you must check availability. If a user asks for a slot that is already booked, you must NOT book it. 2. MANDATORY DATA COLLECTION: Before calling \`createEvent\` or \`insertAppointment\`, you MUST explicitly and politely ask the user for their Name and Mobile Number ('Vad är ditt namn och mobilnummer?'). You are STRICTLY PROHIBITED from calling \`insertAppointment\` until both pieces of information are gathered from the user's voice/text.";`
);

// Delete the obsolete deprecated module
try {
  let packageJson = fs.readFileSync("package.json", "utf8");
  packageJson = packageJson.replace(/"node-domexception": "[^"]+",?/g, "");
  fs.writeFileSync("package.json", packageJson);
} catch(e) {}

fs.writeFileSync("server.ts", content);
console.log("Patched server.ts successfully");
