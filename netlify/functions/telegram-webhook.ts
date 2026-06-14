import { Handler } from '@netlify/functions';
import { GoogleGenAI } from '@google/genai';

const chatSessions: Record<number, any[]> = {};

export const handler: Handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Acknowledge immediately to prevent Telegram retries if we took too long (in a real setup, you might push this to a queue)
  try {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const apiKey = process.env.GEMINI_API_KEY;
    const systemPrompt = process.env.SYSTEM_PROMPT || "You are a helpful assistant.";

    if (!telegramToken || !apiKey) {
      console.error("Missing environment variables");
      return { statusCode: 500, body: 'Missing config' };
    }

    const update = JSON.parse(event.body || '{}');
    if (!update.message) return { statusCode: 200, body: 'OK' };

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
      const fileRes = await fetch(`https://api.telegram.org/bot${telegramToken}/getFile?file_id=${voice.file_id}`);
      const fileData = await fileRes.json();
      if (fileData.ok && fileData.result.file_path) {
        const downloadUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileData.result.file_path}`;
        const audioRes = await fetch(downloadUrl);
        const audioBuffer = await audioRes.arrayBuffer();
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
        
        userMessageContent.push({
          inlineData: {
            data: base64Audio,
            mimeType: "audio/ogg" // typical format for telegram voices
          }
        });
        userMessageContent.push({ text: "Here is a voice message. Please reply to it as a voice message." });
      }
    } else {
      return { statusCode: 200, body: 'OK' };
    }

    const contents = [...history, { role: "user", parts: userMessageContent }];

    const constraint = "\nCRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. Never exceed this limit under any circumstances, whether responding in Swedish, English, or Persian or another languages . Keep it brief, professional, and straight to the point.";
    const chatResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: { systemInstruction: systemPrompt + constraint }
    });
    const textResponse = chatResponse.text;

    history.push({ role: "user", parts: userMessageContent });
    history.push({ role: "model", parts: [{ text: textResponse || "" }] });

    if (voice && textResponse) {
      try {
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
           
           // Convert PCM to WAV
           const sampleRate = 24000;
           const wavHeader = Buffer.alloc(44);
           wavHeader.write('RIFF', 0);
           wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
           wavHeader.write('WAVE', 8);
           wavHeader.write('fmt ', 12);
           wavHeader.writeUInt32LE(16, 16);
           wavHeader.writeUInt16LE(1, 20); // PCM
           wavHeader.writeUInt16LE(1, 22); // Channels
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
           
           await fetch(`https://api.telegram.org/bot${telegramToken}/sendVoice`, {
             method: 'POST',
             body: formData
           });
           
           return { statusCode: 200, body: 'OK' };
        }
      } catch (e) {
        console.error("TTS generation failed:", e);
      }
    }

    // Default to text if not a voice message or TTS fails
    await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: textResponse })
    });

    return { statusCode: 200, body: 'OK' };

  } catch (error) {
    console.error("Webhook processing error:", error);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
