import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// Replace processTelegramUpdate
const processTelegramUpdateRegex = /async function processTelegramUpdate\(update: any, config: any, platform: string = "telegram-polling"\) \{[\s\S]*?\}\n\}/m;
const newProcessTelegramUpdate = `async function processTelegramUpdate(update: any, config: any, platform: string = "telegram-polling") {
    try {
      const { telegramToken, apiKey, systemPrompt } = config;
      if (!telegramToken || !apiKey) return;
      if (!update.message) return;
      
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const voice = update.message.voice;
      
      const ai = new Groq({ apiKey });
      if (!chatSessions[chatId]) chatSessions[chatId] = [];
      const history = chatSessions[chatId];
      let userMessageContent = "";
      
      if (text) {
        userMessageContent = text;
      } else if (voice) {
        const fileRes = await fetch(\`https://api.telegram.org/bot\${telegramToken}/getFile?file_id=\${voice.file_id}\`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result.file_path) {
          const downloadUrl = \`https://api.telegram.org/file/bot\${telegramToken}/\${fileData.result.file_path}\`;
          const audioRes = await fetch(downloadUrl);
          const audioBuffer = await audioRes.arrayBuffer();
          // Write down to file for groq
          const tmpPath = \`/tmp/tg_audio_\${Date.now()}.ogg\`;
          fs.writeFileSync(tmpPath, Buffer.from(audioBuffer));
          
          try {
             const transcription = await ai.audio.transcriptions.create({
                file: fs.createReadStream(tmpPath),
                model: "whisper-large-v3-turbo"
             });
             userMessageContent = "User sent a voice message transcribed as: " + transcription.text + ". Please reply nicely formatted and never raw JSON.";
          } catch(e) {
             console.error("Transcription failed", e);
             return;
          } finally {
             fs.unlinkSync(tmpPath);
          }
        }
      } else {
        return; // Ignore other types
      }
      
      const messages = [...history];
      messages.push({ role: "user", content: userMessageContent });
      
      const constraint = "\\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the \`checkSlots\` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking. If a slot is marked as 'BOOKED' in the matrix, you must tell the user it is taken and offer alternative open slots. IMPORTANT: DO NOT SEND RAW JSON OUTPUT TO THE USER. Parse tool output into beautiful natural text in the user's language (Swedish, Persian, English, etc).";
      
      let chatResponse = await generateContentWithFallback(ai, {
        messages,
        systemInstruction: (systemPrompt || "") + constraint, 
        tools: calendarTools
      });
      
      if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
        // Groq requires tool calls to be appended before the tool results
        messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });
        
        const adapter = getCalendarAdapter(config);
        const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
          let res;
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "checkSlots" && args) res = await adapter.checkSlots(args.dateStr);
          else if (call.function.name === "insertAppointment" && args) res = await adapter.insertAppointment(args.name, args.dateTime);
          else res = { error: "Unknown tool" };
          
          return {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(res)
          };
        }));
        
        messages.push(...functionResponsesParts);
        
        chatResponse = await generateContentWithFallback(ai, {
          messages,
          systemInstruction: (systemPrompt || "") + constraint, 
          tools: calendarTools
        });
      }
      
      const textResponse = chatResponse.text || "I'm having trouble processing that right now.";
      history.push({ role: "user", content: userMessageContent });
      history.push({ role: "assistant", content: textResponse });
      
      // Voice-to-Voice vs Text-to-Text
      if (voice) {
        try {
          // Detect language naive fallback to english 
          let voiceName = 'en-US-AriaNeural'; 
          if(textResponse.match(/[åäöÅÄÖ]/)) voiceName = 'sv-SE-SofieNeural';
          if(textResponse.match(/[\u0600-\u06FF]/)) voiceName = 'fa-IR-DilaraNeural';

          const tts = new EdgeTTS({ voice: voiceName });
          const outName = \`/tmp/tts_\${Date.now()}.mp3\`;
          await tts.ttsPromise(textResponse, outName);
          
          const audioBuffer = fs.readFileSync(outName);
          const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });
          const formData = new FormData();
          formData.append('chat_id', chatId.toString());
          formData.append('audio', blob, 'response.mp3');
          
          await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendAudio\`, {
            method: 'POST',
            body: formData
          });
          fs.unlinkSync(outName);
          
          postProcessMessage(chatId.toString(), platform, "[Voice Message]", textResponse, telegramToken, apiKey);
        } catch (ttsErr) {
          console.error("TTS generation/sending failed:", ttsErr);
          await fetch(\`https://api.telegram.org/bot\${telegramToken}/sendMessage\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: textResponse })
          });
          postProcessMessage(chatId.toString(), platform, "[Voice Message]", textResponse, telegramToken, apiKey);
        }
      } else {
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
code = code.replace(processTelegramUpdateRegex, newProcessTelegramUpdate);



// Replace chat logic
const chatRegex = /app\.post\("\/api\/chat", async \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ error: error\.message \}\);\n    \}\n  \}\);/m;
const newChat = `app.post("/api/chat", async (req, res) => {
    try {
      const { message, audioData: incomingAudioData, mimeType: incomingMimeType, apiKey } = req.body;
      if (!apiKey) return res.status(401).json({ error: "Missing API Key" });

      const ai = new Groq({ apiKey });
      const chatId = "web-" + Math.random().toString(36).substring(7); // simple session mock for web route
      
      let userMessageContent = message;
      
      if (incomingAudioData) {
          const buf = Buffer.from(incomingAudioData, 'base64');
          const tmpPath = \`/tmp/web_audio_\${Date.now()}.\${incomingMimeType.includes('webm') ? 'webm' : 'ogg'}\`;
          fs.writeFileSync(tmpPath, buf);
          try {
             const transcription = await ai.audio.transcriptions.create({
                file: fs.createReadStream(tmpPath),
                model: "whisper-large-v3-turbo"
             });
             userMessageContent = "User sent a voice message transcribed as: " + transcription.text + ". Please reply nicely formatted and never raw JSON.";
          } catch(e) {
             console.error("Transcription failed", e);
             userMessageContent = message;
          } finally {
             if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          }
      }

      const messages: any[] = [{ role: "user", content: userMessageContent }];
      const constraint = "\\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the \`checkSlots\` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking. If a slot is marked as 'BOOKED' in the matrix, you must tell the user it is taken and offer alternative open slots. IMPORTANT: DO NOT SEND RAW JSON OUTPUT TO THE USER. Parse tool output into beautiful natural text in the user's language (Swedish, Persian, English, etc).";
      
      let chatResponse = await generateContentWithFallback(ai, {
        messages,
        systemInstruction: constraint, 
        tools: calendarTools
      });
      
      if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
        messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });
        const adapter = getCalendarAdapter(activeConfig);
        const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
          let adapterRes;
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "checkSlots" && args) adapterRes = await adapter.checkSlots(args.dateStr);
          else if (call.function.name === "insertAppointment" && args) adapterRes = await adapter.insertAppointment(args.name, args.dateTime);
          else adapterRes = { error: "Unknown tool" };
          
          return {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(adapterRes)
          };
        }));
        
        messages.push(...functionResponsesParts);
        
        chatResponse = await generateContentWithFallback(ai, {
          messages,
          systemInstruction: constraint, 
          tools: calendarTools
        });
      }
      
      let textPart = chatResponse.text || "I couldn't process your request.";
      let audioDataOut = null;
      let outMimeType = null;
      
      if (incomingAudioData) {
         try {
           let voiceName = 'en-US-AriaNeural'; 
           if(textPart.match(/[åäöÅÄÖ]/)) voiceName = 'sv-SE-SofieNeural';
           if(textPart.match(/[\u0600-\u06FF]/)) voiceName = 'fa-IR-DilaraNeural';
           
           const tts = new EdgeTTS({ voice: voiceName });
           const outName = \`/tmp/web_tts_\${Date.now()}.mp3\`;
           await tts.ttsPromise(textPart, outName);
           
           const mp3Buf = fs.readFileSync(outName);
           audioDataOut = mp3Buf.toString('base64');
           outMimeType = "audio/mpeg";
           fs.unlinkSync(outName);
         } catch (ttsErr) {
           console.error("Web TTS failed:", ttsErr);
         }
      }

      postProcessMessage(chatId, "web-chat", message || "[Voice]", textPart, undefined, apiKey);
      res.json({ text: textPart, audioData: audioDataOut, mimeType: outMimeType });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });`;

code = code.replace(chatRegex, newChat);

// Transcribe api 
const transcribeRegex = /app\.post\("\/api\/transcribe", async \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ error: error\.message \}\);\n    \}\n  \}\);/m;
const newTranscribe = `app.post("/api/transcribe", async (req, res) => {
    try {
      const { audioData, mimeType, apiKey } = req.body;
      if (!apiKey) return res.status(401).json({ error: "Missing API Key" });

      const ai = new Groq({ apiKey });
      const buf = Buffer.from(audioData, 'base64');
      const tmpPath = \`/tmp/transcribe_\${Date.now()}.\${mimeType.includes('webm') ? 'webm' : 'ogg'}\`;
      fs.writeFileSync(tmpPath, buf);
      try {
         const transcription = await ai.audio.transcriptions.create({
            file: fs.createReadStream(tmpPath),
            model: "whisper-large-v3-turbo"
         });
         res.json({ text: transcription.text });
      } finally {
         fs.unlinkSync(tmpPath);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });`;
code = code.replace(transcribeRegex, newTranscribe);

fs.writeFileSync('server.ts', code);
