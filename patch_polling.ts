import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexTelegramPolling = /bot\.on\('message', async \(msg: any\) => \{[\s\S]*?postProcessMessage\(chatId\.toString\(\), "telegram-polling", text \|\| "\[Voice Message\]", textResponse \|\| "", telegramToken, apiKey\);/m;

const replacementTelegramPolling = `bot.on('message', async (msg: any) => {
  try {
    const { telegramToken, apiKey, systemPrompt } = activeConfig;
    if (!telegramToken || !apiKey) return;

    const chatId = msg.chat.id;
    const text = msg.text;
    const voice = msg.voice;

    let textResponse = "";
    const adapter = getCalendarAdapter(activeConfig);
    
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

    await bot.sendMessage(chatId, textResponse);
    postProcessMessage(chatId.toString(), "telegram-polling", text || "[Voice Message]", textResponse || "", telegramToken, apiKey);`;

code = code.replace(regexTelegramPolling, replacementTelegramPolling);

fs.writeFileSync('server.ts', code);
