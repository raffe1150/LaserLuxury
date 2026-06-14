import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

const replacementLogic = `
        if (call.function.name === "checkSlots" && args) {
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate);
          if (adapterRes.available_slots_string) {
             const slotsArray = adapterRes.available_slots_string
                 .split('\\n')
                 .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
             
             let replyMessage = "Jag hittade tyvärr inga lediga tider för den perioden. Har du något annat datum i åtanke? 😊";
             if (slotsArray.length > 0) {
                 replyMessage = "Jag hittade några lediga tider:\\n";
                 slotsArray.forEach((slot: string) => {
                     replyMessage += \`- \${slot}\\n\`;
                 });
                 replyMessage += "Vilken av dessa tider passar dig bäst? 😊";
             }
             
             return { TERMINATE_EARLY: true, replyMessage };
          }
        }
`;

content = content.replace(
  /if \(call\.function\.name === "checkSlots" && args\) adapterRes = await adapter\.checkSlots\(args\.startDate, args\.endDate\);/g,
  replacementLogic.trim()
);

const handleLogic1 = `
      const earlyTerm = functionResponsesParts.find((p: any) => p && p.TERMINATE_EARLY);
      if (earlyTerm) {
         const textResponse = earlyTerm.replyMessage;
         history.push({ role: "user", content: Array.isArray(userMessageContent) ? "(User Voice Message)" : userMessageContent });
         history.push({ role: "assistant", content: textResponse });
         
         if (typeof platform !== 'undefined' && (platform === "telegram-webhook" || platform === "telegram-polling")) {
            await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendMessage\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: textResponse })
            });
            activeRequests.delete(chatId);
            return;
         } else {
             // In web /api/chat
             if (typeof res !== 'undefined' && !res.headersSent) {
                 res.json({ text: textResponse, chatId });
             }
             activeRequests.delete(chatId);
             return; // Break out of post handler
         }
      }
      
      messages.push(...functionResponsesParts);
`;

content = content.replace(
  /messages\.push\(\.\.\.functionResponsesParts\);/g,
  handleLogic1.trim()
);

fs.writeFileSync("server.ts", content);
