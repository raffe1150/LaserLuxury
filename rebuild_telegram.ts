import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

const newProcessTelegramUpdate = `async function processTelegramUpdate(update: any, config: any, platform: string = "telegram-polling") {
    try {
      const { telegramToken, apiKey, systemPrompt } = config;
      if (!telegramToken || !apiKey) return;
      if (!update.message) return;
      
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const voice = update.message.voice;
      
      const ai = new GoogleGenAI({ apiKey });
      if (!chatSessions[chatId]) chatSessions[chatId] = [];
      const history = chatSessions[chatId];
      let userMessageContent: any[] = [];
      
      if (text) {
        userMessageContent.push({ text });
      } else if (voice) {
        const fileRes = await fetch(\`https://api.telegram.org/bot\${telegramToken}/getFile?file_id=\${voice.file_id}\`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result.file_path) {
          const downloadUrl = \`https://api.telegram.org/file/bot\${telegramToken}/\${fileData.result.file_path}\`;
          const audioRes = await fetch(downloadUrl);
          const audioBuffer = await audioRes.arrayBuffer();
          const base64Audio = Buffer.from(audioBuffer).toString('base64');
          
          userMessageContent.push({
            inlineData: { data: base64Audio, mimeType: "audio/ogg" }
          });
          userMessageContent.push({ text: "Here is a voice message. Please reply to it as a voice message. Make sure your text output is beautifully formatted in the natural language requested and NEVER send raw JSON." });
        }
      } else {
        return; // Ignore other types
      }
      
      const contents = [...history, { role: "user", parts: userMessageContent }];
      const constraint = "\\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the \`checkSlots\` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking. If a slot is marked as 'BOOKED' in the matrix, you must tell the user it is taken and offer alternative open slots. IMPORTANT: DO NOT SEND RAW JSON OUTPUT TO THE USER. Parse tool output into beautiful natural text in the user's language (Swedish, Persian, English, etc).";
      
      let chatResponse = await generateContentWithFallback(ai, {
        contents,
        config: { systemInstruction: (systemPrompt || "") + constraint, tools: calendarTools }
      });
      
      if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
        contents.push({ role: "model", parts: chatResponse.candidates?.[0]?.content?.parts || [] });
        const adapter = getCalendarAdapter(config);
        const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async call => {
          let res;
          if (call.name === "checkSlots" && call.args) res = await adapter.checkSlots((call.args as any).dateStr);
          else if (call.name === "insertAppointment" && call.args) res = await adapter.insertAppointment((call.args as any).name, (call.args as any).dateTime);
          else res = { error: "Unknown tool" };
          
          return {
            functionResponse: {
              name: call.name,
              response: res
            }
          };
        }));
        
        contents.push({ role: "user", parts: functionResponsesParts as any });
        
        chatResponse = await generateContentWithFallback(ai, {
          contents,
          config: { systemInstruction: (systemPrompt || "") + constraint, tools: calendarTools }
        });
      }
      
      const textResponse = chatResponse.text || "I'm having trouble processing that right now.";
      history.push({ role: "user", parts: userMessageContent });
      history.push({ role: "model", parts: [{ text: textResponse }] });
      
      // Dynamic routing: Voice-to-Voice vs Text-to-Text
      if (voice) {
        try {
          // Convert ai text to speech
          const ttsResponse = await ai.models.generateContent({
             model: "gemini-3.1-flash-tts-preview",
             contents: [{ parts: [{ text: textResponse }] }],
             config: {
               responseModalities: ["AUDIO"],
               speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
             }
          });
          
          const audioPart = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (audioPart) {
             const pcmBase64 = audioPart.data;
             const pcmBuffer = Buffer.from(pcmBase64, 'base64');
             const sampleRate = 24000;
             const wavHeader = Buffer.alloc(44);
             wavHeader.write('RIFF', 0);
             wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
             wavHeader.write('WAVE', 8);
             wavHeader.write('fmt ', 12);
             wavHeader.writeUInt32LE(16, 16);
             wavHeader.writeUInt16LE(1, 20);
             wavHeader.writeUInt16LE(1, 22);
             wavHeader.writeUInt32LE(sampleRate, 24);
             wavHeader.writeUInt32LE(sampleRate * 2, 28);
             wavHeader.writeUInt16LE(2, 32); 
             wavHeader.writeUInt16LE(16, 34); 
             wavHeader.write('data', 36);
             wavHeader.writeUInt32LE(pcmBuffer.length, 40);
             
             const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
             const blob = new Blob([wavBuffer], { type: 'audio/wav' });
             const formData = new FormData();
             formData.append('chat_id', chatId.toString());
             const duration = Math.ceil(pcmBuffer.length / (24000 * 2));
             formData.append('duration', duration.toString());
             formData.append('voice', blob, 'response.ogg');
             
             await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendVoice\`, {
               method: 'POST',
               body: formData
             });
             
             postProcessMessage(chatId.toString(), platform, "[Voice Message]", textResponse, telegramToken, apiKey);
             return;
          }
        } catch (ttsErr) {
          console.error("TTS generation/sending failed:", ttsErr);
          // Fallback to text if TTS fails
          await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendMessage\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: textResponse })
          });
          postProcessMessage(chatId.toString(), platform, "[Voice Message]", textResponse, telegramToken, apiKey);
        }
      } else {
        // Text-to-Text
        await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendMessage\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: textResponse })
        });
        
        postProcessMessage(chatId.toString(), platform, text, textResponse, telegramToken, apiKey);
      }
    } catch (error) {
      console.error("Webhook processing error:", error);
    }
}`;

const regexProcessTelegramUpdate = /async function processTelegramUpdate\(update: any, config: any\) \{[\s\S]*?console\.error\("Webhook processing error:", error\);\n  \}\n\}/m;
code = code.replace(regexProcessTelegramUpdate, newProcessTelegramUpdate);

const regexTelegramWebhookHandler = /app\.post\("\/api\/telegram-webhook"[\s\S]*?console\.error\("Webhook processing error:", e\);\n    \}\n  \}\);/m;
const newTelegramWebhookHandler = `app.post("/api/telegram-webhook", async (req, res) => {
    res.status(200).send("OK");
    await processTelegramUpdate(req.body, activeConfig, "telegram-webhook");
  });`;
code = code.replace(regexTelegramWebhookHandler, newTelegramWebhookHandler);

fs.writeFileSync('server.ts', code);
