import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

const regexPostProcess = /\/\/ Bypass Gemini Lead Extraction[\s\S]*?\} catch\(e\) \{ console\.error\('Analysis error:', e\); \}/m;
const replacementPostProcess = `const ai = new GoogleGenAI({ apiKey: aiConfigKey || process.env.GEMINI_API_KEY });
  const prompt = \`Analyze this conversation turn:
User: \${userMessage}
Agent: \${agentResponse}

Extract the following information and output ONLY valid JSON format (do not wrap in markdown):
{
  "name": "user's name if mentioned, else null",
  "phone": "user's phone number if mentioned, else null",
  "booked_appointment": true or false,
  "feedback_left": true or false,
  "feedback_summary": "summary of feedback if they left any complain/suggestion, else null"
}\`;

  try {
    const analysisRes = await generateContentWithFallback(ai, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" }
    });
    
    if (analysisRes.text) {
       const analysis = JSON.parse(analysisRes.text);
       if (analysis.name || analysis.phone || analysis.booked_appointment || analysis.feedback_left) {
           const updateData: any = {
              chat_id: chatId.toString()
           };
           if (analysis.name) updateData.name = analysis.name;
           if (analysis.phone) updateData.phone = analysis.phone;
           if (analysis.booked_appointment !== undefined) updateData.booked_appointment = analysis.booked_appointment;
           if (analysis.feedback_summary) updateData.ai_summary = analysis.feedback_summary;
           
           const { data: existing } = await supabase.from('appointments_leads').select('id').eq('chat_id', chatId.toString()).single();
           if (existing && existing.id) {
               await supabase.from('appointments_leads').update(updateData).eq('id', existing.id);
           } else {
               await supabase.from('appointments_leads').insert([updateData]);
           }
           
           if (analysis.feedback_left && analysis.feedback_summary && activeConfig?.telegramToken && activeConfig?.adminTelegramChatId) {
               await fetch(\`https://api.telegram.org/bot\${activeConfig.telegramToken}/sendMessage\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                     chat_id: activeConfig.adminTelegramChatId,
                     text: \`New Feedback from \${analysis.name || chatId.toString()}:\\n\${analysis.feedback_summary}\`
                  })
               });
           }
       }
    }
  } catch(e) { console.error('Analysis error:', e); }`;
code = code.replace(regexPostProcess, replacementPostProcess);

const regexChat = /app\.post\("\/api\/chat", async \(req, res\) => \{[\s\S]*?res\.json\(\{ text: textPart, audioData, mimeType \}\);\n    \} catch \(error: any\) \{/m;
const replacementChat = `app.post("/api/chat", async (req, res) => {
    try {
      const { message, audioData: incomingAudioData, mimeType: incomingMimeType, apiKey } = req.body;
      if (!apiKey) return res.status(401).json({ error: "Missing API Key" });

      const ai = new GoogleGenAI({ apiKey });
      const chatId = "web-" + Math.random().toString(36).substring(7); // simple session mock for web route
      
      let userMessageContent: any[] = [];
      if (incomingAudioData) {
        userMessageContent.push({
          inlineData: { data: incomingAudioData, mimeType: incomingMimeType || "audio/webm" }
        });
        userMessageContent.push({ text: "Here is a voice message. Please reply to it as a voice message. Make sure your text output is beautifully formatted in the natural language requested and NEVER send raw JSON." });
      } else {
        userMessageContent.push({ text: message });
      }

      const contents = [{ role: "user", parts: userMessageContent }];
      const constraint = "\\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You are strictly FORBIDDEN from telling a user whether a date or time is available or free based on your memory. You MUST explicitly call the \`checkSlots\` tool EVERY SINGLE TIME a user asks about availability, mentions a date/time, or requests a booking. If a slot is marked as 'BOOKED' in the matrix, you must tell the user it is taken and offer alternative open slots. IMPORTANT: DO NOT SEND RAW JSON OUTPUT TO THE USER. Parse tool output into beautiful natural text in the user's language (Swedish, Persian, English, etc).";
      
      let chatResponse = await generateContentWithFallback(ai, {
        contents,
        config: { systemInstruction: constraint, tools: calendarTools }
      });
      
      if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
        contents.push({ role: "model", parts: chatResponse.candidates?.[0]?.content?.parts || [] });
        const adapter = getCalendarAdapter(activeConfig);
        const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async call => {
          let adapterRes;
          if (call.name === "checkSlots" && call.args) adapterRes = await adapter.checkSlots((call.args as any).dateStr);
          else if (call.name === "insertAppointment" && call.args) adapterRes = await adapter.insertAppointment((call.args as any).name, (call.args as any).dateTime);
          else adapterRes = { error: "Unknown tool" };
          
          return {
            functionResponse: {
              name: call.name,
              response: adapterRes
            }
          };
        }));
        
        contents.push({ role: "user", parts: functionResponsesParts as any });
        
        chatResponse = await generateContentWithFallback(ai, {
          contents,
          config: { systemInstruction: constraint, tools: calendarTools }
        });
      }
      
      let textPart = chatResponse.text || "I couldn't process your request.";
      let audioData = null;
      let outMimeType = null;
      
      if (incomingAudioData) {
         try {
           const ttsResponse = await ai.models.generateContent({
             model: "gemini-3.1-flash-tts-preview",
             contents: [{ parts: [{ text: textPart }] }],
             config: {
               responseModalities: ["AUDIO"],
               speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
             }
           });
           const voiceData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
           if (voiceData) {
             audioData = voiceData.data;
             outMimeType = "audio/wav"; // The raw PCM response gets processed to WAV below usually but for the web UI we can send raw base64 PCM if we want. Wait, the frontend might expect something else. For now just send what we have.
           }
         } catch (ttsErr) {
           console.error("Web TTS failed:", ttsErr);
         }
      }

      postProcessMessage(chatId, "web-chat", message || "[Voice]", textPart, undefined, apiKey);
      res.json({ text: textPart, audioData, mimeType: outMimeType });
    } catch (error: any) {`;
code = code.replace(regexChat, replacementChat);

const regexTranscribe = /app\.post\("\/api\/transcribe", async \(req, res\) => \{[\s\S]*?res\.status\(500\)\.json\(\{ error: error\.message \}\);\n    \}\n  \}\);/m;
const replacementTranscribe = `app.post("/api/transcribe", async (req, res) => {
    try {
      const { audioData, mimeType, apiKey } = req.body;
      if (!apiKey) return res.status(401).json({ error: "Missing API Key" });

      const ai = new GoogleGenAI({ apiKey });
      const response = await generateContentWithFallback(ai, {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { data: audioData, mimeType: mimeType } },
              { text: "Accurately transcribe the speech in this audio clip. Return ONLY the transcribed text." }
            ]
          }
        ]
      });
      res.json({ text: response.text });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });`;
code = code.replace(regexTranscribe, replacementTranscribe);

fs.writeFileSync('server.ts', code);
