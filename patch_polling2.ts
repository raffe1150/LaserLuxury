import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexProcessTelegramUpdate = /async function processTelegramUpdate\(update: any, config: any\) \{[\s\S]*?console\.error\("Webhook processing error:", error\);\n  \}\n\}/m;

const replacementProcessTelegramUpdate = `async function processTelegramUpdate(update: any, config: any) {
  try {
    const { telegramToken, apiKey, systemPrompt } = config;
    if (!telegramToken || !apiKey) return;
    if (!update.message) return;
    
    const chatId = update.message.chat.id;
    const text = update.message.text;
    const voice = update.message.voice;
    
    let textResponse = "";
    const adapter = getCalendarAdapter(config);
    
    const messageText = text || "Check slots for 2026-06-08";
    const dateMatch = messageText.match(/\\b\\d{4}-\\d{2}-\\d{2}\\b/);
    
    if (messageText.toLowerCase().includes("book")) {
       const timeMatch = messageText.match(/\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(Z|[+-]\\d{2}:\\d{2})?\\b/i);
       if (timeMatch) {
          const result = await adapter.insertAppointment("Test User", timeMatch[0]);
          textResponse = JSON.stringify(result, null, 2);
       } else {
          textResponse = "To book, please provide a full ISO dateTime string, e.g., 'book 2026-06-08T10:00:00Z'";
       }
    } else {
       const dateToCheck = dateMatch ? dateMatch[0] : "2026-06-08";
       const result = await adapter.checkSlots(dateToCheck);
       textResponse = JSON.stringify(result, null, 2);
    }
    
    await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendMessage\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: textResponse })
    });
    
    postProcessMessage(chatId.toString(), "telegram-polling", text || "[Voice Message]", textResponse || "", telegramToken, apiKey);
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}`;

code = code.replace(regexProcessTelegramUpdate, replacementProcessTelegramUpdate);

fs.writeFileSync('server.ts', code);
