import fs from "fs";
let content = fs.readFileSync("server.ts", "utf8");

content = content.replace(
  "             const transcriptionRes = await ai.models.generateContent({\n                 model: 'gemini-2.5-flash',\n                 contents: [\n                     { inlineData: { data: base64Audio, mimeType: \"audio/ogg\" } },\n                     \"Analyze this booking request voice note and transcribe it accurately. Output ONLY the transcript without any markdown or formatting.\"\n                 ]\n              });\n              const transcribedText = transcriptionRes.text || \"[Unintelligible audio]\";\n              userMessageContent = transcribedText;",
  "              userMessageContent = [\n                  { text: \"Voice message input:\" },\n                  { inlineData: { data: base64Audio, mimeType: \"audio/ogg\" } }\n              ];"
);
fs.writeFileSync("server.ts", content);
