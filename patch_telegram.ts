import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexTelegramWebhook = /app\.post\("\/api\/telegram-webhook", async \(req, res\) => \{[\s\S]*?postProcessMessage\(chatId\.toString\(\), "telegram-webhook", text \|\| "\[Voice Message\]", textResponse \|\| "", telegramToken, apiKey\);/m;

const replacementTelegramWebhook = `app.post("/api/telegram-webhook", async (req, res) => {
    res.status(200).send("OK");
    try {
      const { telegramToken, apiKey, systemPrompt } = activeConfig;
      if (!telegramToken || !apiKey) return;
      
      const update = req.body;
      if (!update.message) return;
      
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const voice = update.message.voice;
      
      // Temporary bypass for Gemini 429 quota error: execute tool locally and return result
      let textResponse = "";
      const adapter = getCalendarAdapter(activeConfig);
      
      const messageText = text || "Check slots for 2026-06-08"; // Fallback to text if voice
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: textResponse })
      });
      
      postProcessMessage(chatId.toString(), "telegram-webhook", text || "[Voice Message]", textResponse || "", telegramToken, apiKey);`;

code = code.replace(regexTelegramWebhook, replacementTelegramWebhook);

fs.writeFileSync('server.ts', code);
