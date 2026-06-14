import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

const regexChat = /app\.post\("\/api\/chat", async \(req, res\) => \{[\s\S]*?res\.json\(\{ text: textPart, audioData, mimeType \}\);\n    \} catch \(error: any\) \{/m;

const replacementChat = `app.post("/api/chat", async (req, res) => {
    try {
      const { message, apiKey } = req.body;
      let textPart = "";
      const adapter = getCalendarAdapter({});
      
      const dateMatch = message.match(/\\b\\d{4}-\\d{2}-\\d{2}\\b/);
      if (message.toLowerCase().includes("book")) {
         const timeMatch = message.match(/\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(Z|[+-]\\d{2}:\\d{2})?\\b/i);
         if (timeMatch) {
            const result = await adapter.insertAppointment("Test User", timeMatch[0]);
            textPart = JSON.stringify(result, null, 2);
         } else {
            textPart = "To book, please provide a full ISO dateTime string, e.g., 'book 2026-06-08T10:00:00Z'";
         }
      } else {
         const dateToCheck = dateMatch ? dateMatch[0] : "2026-06-08";
         const result = await adapter.checkSlots(dateToCheck);
         textPart = JSON.stringify(result, null, 2);
      }
      
      let audioData = null;
      let mimeType = null;

      postProcessMessage("web-" + Math.random().toString(36).substring(7), "web-chat", message, textPart || "", undefined, apiKey);
      res.json({ text: textPart, audioData, mimeType });
    } catch (error: any) {`;

code = code.replace(regexChat, replacementChat);

const regexPostProcess = /const ai = new GoogleGenAI\(\{ apiKey: aiConfigKey \|\| process\.env\.GEMINI_API_KEY \}\);[\s\S]*?\} catch\(e\) \{ console\.error\('Analysis error:', e\); \}/m;

const replacementPostProcess = `// Bypass Gemini Lead Extraction
    const analysis: any = {
       name: "Test Name",
       phone: null,
       booked_appointment: agentResponse.includes("booking") || agentResponse.includes("booked") || agentResponse.includes("Successfully booked"),
       feedback_left: false,
       feedback_summary: null
    };
    
    try {
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
      }
    } catch(e) { console.error('Analysis error:', e); }`;

code = code.replace(regexPostProcess, replacementPostProcess);

fs.writeFileSync('server.ts', code);
