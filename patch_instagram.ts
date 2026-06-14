import fs from 'fs';

let content = fs.readFileSync('server.ts', 'utf8');

// ۱. تزریق تابع پردازش اینستاگرام
const igFunction = `
async function processInstagramUpdate(webhook_event: any, config: any, platform: string = "instagram-webhook") {
  const senderId = webhook_event.sender?.id;
  const messageText = webhook_event.message?.text;
  if (!senderId || !messageText) return;
  const chatId = \`ig_\${senderId}\`;
  try {
    const ai = new GoogleGenAI({ apiKey: config?.apiKey || process.env.GEMINI_API_KEY });
    if (!chatSessions[chatId]) chatSessions[chatId] = [];
    const history = chatSessions[chatId];
    let userMessageContent: any = messageText;
    const messages = [...history];
    messages.push({ role: "user", content: userMessageContent });
    const constraint = "\\nCRITICAL CONSTRAINT: Keep responses under 60 words. Parse tool output into natural text. DO NOT SEND RAW JSON.";
    const finalSystemInstruction = (config?.systemPrompt || "") + constraint;
    
    let chatResponse = await generateContentWithFallback(null, {
      messages, systemInstruction: finalSystemInstruction, tools: calendarTools, model: 'gemini-2.5-flash'
    });
    // (بقیه منطقِ چت‌بات در اینجا قرار دارد)
    history.push({ role: "user", content: userMessageContent });
    history.push({ role: "assistant", content: chatResponse.text });
    // ... ادامه لاجیک اینستاگرام ...
  } catch (err: any) { console.error("IG Error:", err); }
}
`;

if (!content.includes("async function processInstagramUpdate")) {
    content = content.replace("async function startServer() {", igFunction + "\nasync function startServer() {");
}

// ۲. تزریق N8N API Endpoint (در بالاترین اولویت)
const n8nEndpoint = `
app.post("/api/n8n-check-slots", async (req, res) => {
  try {
    const { startDate, endDate, durationMinutes } = req.body;
    const adapter = getCalendarAdapter(activeConfig);
    const result = await adapter.checkSlots(startDate, endDate, durationMinutes);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch slots" });
  }
});
`;

if (!content.includes('/api/n8n-check-slots')) {
    content = content.replace("const app = express();", "const app = express();\n" + n8nEndpoint);
}

// ۳. تزریق Webhook اینستاگرام
const webhookEndpoints = `
  app.get("/webhook", (req, res) => {
     if (req.query['hub.verify_token'] === process.env.INSTAGRAM_VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
     else res.sendStatus(403);
  });
  app.post("/webhook", async (req, res) => {
     if (req.body.object === 'instagram') {
        res.status(200).send('EVENT_RECEIVED');
        for (const entry of req.body.entry) {
           for (const event of entry.messaging) processInstagramUpdate(event, activeConfig).catch(console.error);
        }
     } else res.sendStatus(404);
  });
  app.post("/api/setup-telegram", `;

content = content.replace('app.post("/api/setup-telegram", ', webhookEndpoints);

fs.writeFileSync('server.ts', content);
