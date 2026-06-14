import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf8');

const igFunction = `
async function processInstagramUpdate(webhook_event: any, config: any, platform: string = "instagram-webhook") {
  const senderId = webhook_event.sender?.id;
  const messageText = webhook_event.message?.text;
  
  if (!senderId || !messageText) return;

  const chatId = \`ig_\${senderId}\`;
  const voice = null; 

  try {
    const ai = new GoogleGenAI({ apiKey: config?.apiKey || process.env.GEMINI_API_KEY });
    if (!chatSessions[chatId]) chatSessions[chatId] = [];
    const history = chatSessions[chatId];
    let userMessageContent: any = messageText;
    
    const messages = [...history];
    messages.push({ role: "user", content: userMessageContent });
    
    const constraint = "\\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. You may use your conversation memory (context) to keep track of already checked time slots without re-checking the calendar if you already queried the exact date in this conversation. However, BEFORE proposing any NEW date/time or confirming a booking, you MUST read the calendar output. IMPORTANT: DO NOT SEND RAW JSON OUTPUT TO THE USER. Parse tool output into beautiful natural text in the user's language (Swedish, Persian, English, etc)." +
    "\\nPERSONA: You are the exclusive AI receptionist for 'Laser luxury', a high-end beauty/laser salon. Your personality is warm, professional, welcoming, and very kind (snäll). Use natural, conversational Swedish. Avoid robotic phrasing, and use emotive language that makes clients feel valued and relaxed. You ONLY manage laser and beauty appointments. You do NOT offer dentistry or other random services." +
    "\\nBOOKING RULES: 1. Before calling \`insertAppointment\`, you must check availability. If a user asks for a slot that is already booked, you must NOT book it. 2. MANDATORY DATA COLLECTION: Before calling \`createEvent\` or \`insertAppointment\`, you MUST explicitly ask the user for their Name and Mobile Number ('Vad är ditt namn och mobilnummer?'). 3. VAGUE TIME REQUESTS: Whenever a customer asks for a vague or general time (e.g., 'next week', 'sometime this afternoon', 'tomorrow around lunch', 'vilka tider har du', 'när finns det tid'), DO NOT ask them 'What time works for you?'. Instead, AUTOMATICALLY call the checkSlots tool for that period! You must NEVER ask the user when they want to come if they give a vague date; you MUST execute checkSlots." +
    "\\n4. UNAVAILABLE SLOTS (EXPLICIT DENIAL): If the user asks for a specific hour or range that is BOOKED or unavailable in the calendar, you MUST explicitly state that first (e.g., 'Tyvärr är kl 11:00 redan bokat, men...')." +
    "\\n5. MANDATORY TREATMENT INQUIRY: You MUST always ask the user which treatment they want before finalizing or proposing exact time slots, so you can calculate the correct duration." +
    "\\n6. 15-MINUTE PAUSE RULE: Every single treatment requires an additional 15 minutes of cleanup/break. When you calculate availability or book, you MUST add 15 minutes to the treatment's baseline duration (e.g., 20 min treatment -> 35 min total)." +
    "\\n7. NO MENTION OF INTERNAL BUFFER: You are strictly FORBIDDEN from mentioning internal break times, buffer times, or clean-up pauses to the user. To the user, the treatment duration is only the exact active laser time from the list. The 15-minute buffer is strictly internal." +
    \`
---
OFFICIAL SERVICES & PRICE LIST - LASER LUXURY:

[DAM - SOPRANO TITANIUM SPECIAL EDITION]
- Överläpp / Haka / Näsborrar / Händer & Fingrar / Fötter & Tår: 10 min | 495 kr
- Armhålor / Hals / Dekolletage / Bröstvårtor / Svank / Rumpa: 15 min | 695 kr (except Dekolletage/Rumpa: 895 kr)
- Bikinilinje / Hela ansiktet / Hela ansiktet inkl. hals / Bröst & Mage / Navel & Maglinje / Överarmar / Underarmar / Lår / Underben: 20 min | Prices: Bikinilinje: 895 kr, Hela ansiktet: 1295 kr, Hela ansiktet inkl. hals: 1595 kr, Bröst & Mage: 1495 kr, Navel/Maglinje: 495 kr, Över/Underarmar: 695 kr, Lår/Underben: 995 kr.
- Hela armar / Hela ben / Intim inkl. mellan rumpa: 30 min | Prices: Hela armar: 1195 kr, Hela ben: 1795 kr, Intim: 1495 kr.

[HERR - SOPRANO TITANIUM SPECIAL EDITION]
- Öron / Mellan ögonbryn / Fötter & Tår - herr / Händer & Fingrar - herr: 10 min | Prices: Öron/Mellan ögonbryn: 495 kr (Mellan ögonbryn: 295 kr), Fötter/Händer: 595 kr.
- Hals - herr / Skägglinje / Nacke - herr / Armhålor - herr / Överarmar - herr / Underarmar - herr: 15 min | Prices: Hals/Nacke/Skägglinje: 795 kr, Armhålor/Överarmar/Underarmar: 895 kr.
- Axlar / Bröst & Mage - herr / Rygg - herr / Lår - herr / Underben - herr: 20 min | Prices: Axlar: 995 kr, Bröst & Mage/Rygg: 1895 kr, Lår/Underben: 1495 kr.
- Hela armar - herr / Hela ben - herr: 30 min | Prices: Hela armar: 1595 kr, Hela ben: 2795 kr.

[PAKETPRIS DAM]
- Helkropp: 90 min | 4 495 kr
- Armhålor, intim inkl. mellan rumpa, hela armar: 45 min | 2 879 kr
- Armhålor, intim inkl. mellan rumpa, hela ben: 45 min | 3 389 kr
- Haka & överläpp: 15 min | 895 kr

[PAKETPRIS HERR]
- Helkropp - Herr: 90 min | 5 995 kr
- Rygg, axlar, bröst & mage: 40 min | 3 495 kr
- Bröst, mage & armhålor: 30 min | 2 495 kr

[ÖVRIGT]
- Laserhårborttagning- Konsultation på plats: 30 min | 0 kr (Gratis)
---\`;
    const swedenDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Europe/Stockholm',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const currentDateContext = \`\\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: \${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).\`;
    
    let finalSystemInstruction = (config?.systemPrompt || "") + currentDateContext + constraint;
    
    let chatResponse = await generateContentWithFallback(null, {
      messages,
      systemInstruction: finalSystemInstruction, 
      tools: calendarTools,
      model: 'gemini-2.5-flash'
    });
    
    let maxTurns = 3;
    while (chatResponse.functionCalls && chatResponse.functionCalls.length > 0 && maxTurns > 0) {
      maxTurns--;
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });
      
      const adapter = getCalendarAdapter(config);
      const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);
        if (call.function.name === "checkSlots" && args) {
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes);
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\\n')
                    .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime);
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
        else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          const notifyToken = (typeof config !== 'undefined' && config ? config.telegramToken : activeConfig?.telegramToken) || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = (typeof config !== 'undefined' && config ? config.adminTelegramChatId : activeConfig?.adminTelegramChatId) || process.env.ADMIN_TELEGRAM_ID;
          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
             try {
                const notifyText = \`🔔 Ny bokning mottagen!\\n👤 Namn: \${args.name}\\n📞 Mobil: \${args.phone}\\n📅 Tid: \${args.dateTime}\`;
                await fetch(\`https://api.telegram.org/bot\${notifyToken}/sendMessage\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
                });
             } catch(e) { console.error("Admin notify error:", e); }
          }
        }
        else if (call.function.name === "logSystemAnalysis" && args) adapterRes = await handleSystemAnalysisLog(chatId, args);
        else adapterRes = { error: "Unknown tool" };
        
        return {
          role: "tool",
          name: call.function.name,
          id: call.id,
          content: JSON.stringify(adapterRes)
        };
      }));
      
      const earlyTerm = functionResponsesParts.find((p: any) => p && p.TERMINATE_EARLY);
      if (earlyTerm) {
          chatResponse.text = earlyTerm.replyMessage;
          chatResponse.functionCalls = null;
          break;
      }
      
      messages.push(...functionResponsesParts);
      
      chatResponse = await generateContentWithFallback(null, {
        messages,
        systemInstruction: finalSystemInstruction, 
        tools: calendarTools,
        model: 'gemini-2.5-flash'
      });
    }
    
    if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
      chatResponse = await generateContentWithFallback(null, {
         messages,
         systemInstruction: finalSystemInstruction + "\\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
         model: 'gemini-2.5-flash'
      });
    }
    
    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: "user", content: userMessageContent });
    history.push({ role: "assistant", content: textResponse });
    
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    if (accessToken) {
        await fetch(\`https://graph.facebook.com/v21.0/me/messages?access_token=\${accessToken}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          messaging_type: "RESPONSE",
            recipient: { id: senderId },
            message: { text: textResponse }
          })
        });
    }

    try {
      await postProcessMessage(chatId, platform, userMessageContent, textResponse, config?.telegramToken);
    } catch(e) {}
    
  } catch (err: any) {
    console.error("IG processing error:", err);
    try {
        const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
        if (accessToken) {
            await fetch(\`https://graph.facebook.com/v21.0/me/messages?access_token=\${accessToken}\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
              messaging_type: "RESPONSE",
                recipient: { id: senderId },
                message: { text: "Ursäkta, jag stötte på ett tekniskt problem. Kan du försöka igen om en stund?" }
              })
            });
        }
    } catch(e) {}
  }
}
`;

content = content.replace("async function startServer() {", igFunction + "\nasync function startServer() {");

const webhookEndpoints = `
  app.get("/webhook", (req, res) => {
    const verify_token = process.env.INSTAGRAM_VERIFY_TOKEN;
    
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];
      
    if (mode && token) {
      if (mode === 'subscribe' && token === verify_token) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);      
      }
    } else {
      res.sendStatus(400);
    }
  });

  app.post("/webhook", async (req, res) => {
    const body = req.body;

    if (body.object === 'instagram') {
      res.status(200).send('EVENT_RECEIVED');
      
      if (body.entry) {
         for (const entry of body.entry) {
            if (entry.messaging) {
               for (const webhook_event of entry.messaging) {
                  processInstagramUpdate(webhook_event, activeConfig).catch(e => console.error("IG webhook error:", e));
               }
            }
         }
      }
    } else {
      res.sendStatus(404);
    }
  });

  app.post("/api/setup-telegram", `;

content = content.replace('app.post("/api/setup-telegram", ', webhookEndpoints);

fs.writeFileSync('server.ts', content);
