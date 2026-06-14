import fs from "fs";

let content = fs.readFileSync("server.ts", "utf8");

// Telegram STT bypass
const oldSTT = `             const transcriptionRes = await ai.models.generateContent({
                 model: 'gemini-2.5-flash',
                 contents: [
                     { inlineData: { data: base64Audio, mimeType: "audio/ogg" } },
                     "Analyze this booking request voice note and transcribe it accurately. Output ONLY the transcript without any markdown or formatting."
                 ]
              });
              const transcribedText = transcriptionRes.text || "[Unintelligible audio]";
              userMessageContent = transcribedText;`;

const newSTT = `              // Single-Pass Processing: Pass audio directly to the main interaction
              userMessageContent = [
                  { text: "Voice message input:" },
                  { inlineData: { data: base64Audio, mimeType: "audio/ogg" } }
              ];`;

content = content.replace(oldSTT, newSTT);

// Web STT bypass
const oldWebSTT = `             const transcriptionRes = await ai.models.generateContent({
                 model: 'gemini-2.5-flash',
                 contents: [
                     { inlineData: { data: base64Audio, mimeType: incomingMimeType || "audio/ogg" } },
                     "Analyze this booking request voice note and transcribe it accurately. Output ONLY the transcript without any markdown or formatting."
                 ]
              });
              
              userMessageContent = transcriptionRes.text || "Unintelligible audio";`;

const newWebSTT = `              // Single-Pass Processing: Pass audio directly to the main interaction
              userMessageContent = [
                  { text: "Voice message input:" },
                  { inlineData: { data: base64Audio, mimeType: incomingMimeType || "audio/ogg" } }
              ];`;

content = content.replace(oldWebSTT, newWebSTT);


// Fix history push for arrays (Telegram)
const oldHistPush = `history.push({ role: "user", content: userMessageContent });`;
const newHistPush = `history.push({ role: "user", content: Array.isArray(userMessageContent) ? "(User Voice Message)" : userMessageContent });`;

content = content.replace(oldHistPush, newHistPush);


fs.writeFileSync("server.ts", content);
console.log("Patched STT with single pass.");
