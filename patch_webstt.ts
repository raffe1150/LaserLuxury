import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

const oldWebChatStart = `  app.post("/api/chat", async (req, res) => {
    try {
      const { message, audioData: incomingAudioData, mimeType: incomingMimeType, apiKey } = req.body;
      const ai = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY });
      const chatId = "web-" + Math.random().toString(36).substring(7);`;

const newWebChatStart = `  app.post("/api/chat", async (req, res) => {
    try {
      const { message, audioData: incomingAudioData, mimeType: incomingMimeType, apiKey, chatId: clientChatId } = req.body;
      const ai = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY });
      const chatId = clientChatId || "web-" + Math.random().toString(36).substring(7);
      
      if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
      const history = chatSessions[chatId as any];`;

content = content.replace(oldWebChatStart, newWebChatStart);

const oldWebSTT = `             const transcriptionRes = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    { inlineData: { data: base64Audio, mimeType: incomingMimeType || "audio/ogg" } },
                    "Analyze this booking request voice note and transcribe it accurately. Output ONLY the transcript without any markdown or formatting."
                ]
             });

             userMessageContent = "User sent a voice message transcribed as: " + transcriptionRes.text + ". Please reply nicely formatted and never raw JSON.";`;

const newWebSTT = `              userMessageContent = [
                  { text: "Voice message input:" },
                  { inlineData: { data: base64Audio, mimeType: incomingMimeType || "audio/ogg" } }
              ];`;

content = content.replace(oldWebSTT, newWebSTT);


const oldWebMessagesInit = `      const messages: any[] = [{ role: "user", content: userMessageContent }];`;
const newWebMessagesInit = `      const messages: any[] = [...history];\n      messages.push({ role: "user", content: userMessageContent });`;

content = content.replace(oldWebMessagesInit, newWebMessagesInit);

const oldWebHistPush = `      let textPart = chatResponse.text || "I couldn't process your request.";`;
const newWebHistPush = `      history.push({ role: "user", content: Array.isArray(userMessageContent) ? "(User Voice Message)" : userMessageContent });
      let textPart = chatResponse.text || "I couldn't process your request.";
      history.push({ role: "assistant", content: textPart });`;

content = content.replace(oldWebHistPush, newWebHistPush);

fs.writeFileSync("server.ts", content);
console.log("Patched Web chat session and STT single pass.");
