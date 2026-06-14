import fs from "fs";
let content = fs.readFileSync("server.ts", "utf8");

content = content.replace(/const transcriptionRes = await ai\.models\.generateContent\(\{\s*model: 'gemini-2\.5-flash',\s*contents: \[\s*\{\s*inlineData: \{ data: base64Audio, mimeType: "audio\/ogg" \} \},\s*"Analyze this booking request voice note and transcribe it accurately\. Output ONLY the transcript without any markdown or formatting\."\s*\]\s*\}\);\s*const transcribedText = transcriptionRes\.text \|\| "\[Unintelligible audio\]";\s*userMessageContent = transcribedText;/g, 'userMessageContent = [ { text: "Voice message:" }, { inlineData: { data: base64Audio, mimeType: "audio/ogg" } } ];');

fs.writeFileSync("server.ts", content);
