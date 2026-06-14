import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexDuplicate = /postProcessMessage\(chatId\.toString\(\), "telegram-webhook", text \|\| "\[Voice Message\]", textResponse \|\| "", telegramToken, apiKey\);\n      \n      \/\/ TTS bypassed\n      \n      await fetch\(\`https:\/\/api\.telegram\.org\/bot\$\{telegramToken\}\/sendMessage\`, \{\n        method: "POST",\n        headers: \{ "Content-Type": "application\/json" \},\n        body: JSON\.stringify\(\{ chat_id: chatId, text: textResponse \}\)\n      \}\);/m;

const replacement = `postProcessMessage(chatId.toString(), "telegram-webhook", text || "[Voice Message]", textResponse || "", telegramToken, apiKey);`;

code = code.replace(regexDuplicate, replacement);

fs.writeFileSync('server.ts', code);
