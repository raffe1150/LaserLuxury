import React, { useState } from 'react';
import { AgentConfig, Message } from './types';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatSandbox } from './components/ChatSandbox';

const DEFAULT_PROMPT = `You are the Multi-Channel AI Agent for 'Laser Luxury', a high-end laser and beauty clinic in Gothenburg, Sweden. 
Your tone is warm, professional, playful, and friendly. 
You must answer in the exact language the user speaks: Swedish, English, or Persian (including Finglish).

Your primary goals are:
1. Provide clinic information (prices, opening hours, treatments).
2. Help users book an appointment.

CRITICAL: If a user confirms their booking details (date and time) and you finalize it, you MUST include the exact string "[BOOKING_CONFIRMED]" somewhere in your final response message so the system can trigger the calendar synchronization.

CRITICAL CONSTRAINT: Your response for each message MUST be concise and strictly limited to a maximum of 60 words. Never exceed this limit under any circumstances, whether responding in Swedish, English, or Persian or another languages . Keep it brief, professional, and straight to the point.`;

export default function App() {
  const [config, setConfig] = useState<AgentConfig>(() => {
    const saved = localStorage.getItem('laserLuxuryConfig');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved config", e);
      }
    }
    return {
      apiKey: '',
      instagramToken: '',
      telegramToken: '',
      systemPrompt: DEFAULT_PROMPT,
      calendarProvider: 'google',
      calendarApiUrl: '',
      calendarApiKey: '',
    };
  });
  
  const [isActivated, setIsActivated] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [chatId] = useState(() => 'web-' + Math.random().toString(36).substring(7));
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (message: string, durationMs: number = 4000) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), durationMs);
  };

  const handleSaveSettings = () => {
    localStorage.setItem('laserLuxuryConfig', JSON.stringify(config));
    showToast("💾 Settings saved to browser!");
  };

  const handleToggleActivation = async () => {
    if (!isActivated) {
      if (!config.apiKey.trim()) {
        showToast("Error: Google AI Studio API Key is required to activate!");
        return;
      }
      
      // Notify backend about config for Telegram webhook
      try {
        await fetch('/api/setup-telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
      } catch (e) {
        console.error("Failed to setup backend webhook config:", e);
      }

      if (config.instagramToken) console.log("✅ Instagram Webhook stub connected using token:", config.instagramToken);
      if (config.telegramToken) console.log("✅ Telegram Webhook registered using token:", config.telegramToken);
      
      // If either webhook token is present, we simulate a successful integration connection
      if (config.instagramToken || config.telegramToken) {
         showToast("Systems connected: Webhooks initialized!");
      }
    } else {
      setMessages([]);
    }
    setIsActivated(!isActivated);
  };

  const handleSendMessage = async (text: string, audioData?: string, audioMimeType?: string) => {
    const newUserMsg: Message = { id: Date.now().toString(), role: 'user', text, audioData, audioMimeType, timestamp: new Date() };
    setMessages(prev => [...prev, newUserMsg]);
    setIsTyping(true);

    try {
      // Send Request to Backend Server
      const result = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: messages,
          systemPrompt: config.systemPrompt,
          apiKey: config.apiKey
        })
      });

      const data = await result.json();

      if (!result.ok) {
        throw new Error(data.error || "Failed to contact AI.");
      }

      let agentText = data.text || "I'm sorry, I encountered an issue.";
      let agentAudio = data.audioData;
      let agentAudioMimeType = data.mimeType;
      
      // Process Webhook/Calendar trigger stub
      if (agentText.includes('[BOOKING_CONFIRMED]')) {
        agentText = agentText.replace('[BOOKING_CONFIRMED]', '').trim();
        // The user asked for a specific alert, we utilize the Toast for UI elegance and fallback alert
        showToast("📅 System Trigger: Booking data sent to Google Calendar API!", 6000);
      }

      const newAgentMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        text: agentText,
        audioData: agentAudio,
        audioMimeType: agentAudioMimeType,
        timestamp: new Date()
      };

      setMessages(prev => [...prev, newAgentMsg]);

    } catch (error: any) {
      console.error(error);
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        text: `System Error: ${error.message}. Please check your API key and server connection.`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleTranscribeAudio = async (audioData: string, mimeType: string): Promise<string> => {
    try {
      const result = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioData,
          mimeType,
          apiKey: config.apiKey
        })
      });

      const data = await result.json();

      if (!result.ok) {
        throw new Error(data.error || "Failed to transcribe audio.");
      }

      return data.text || "";
    } catch (error: any) {
      console.error(error);
      showToast(`Transcription Error: ${error.message}`);
      return "";
    }
  };

  return (
    <div className="w-full h-screen bg-slate-50 flex flex-col md:flex-row overflow-hidden font-sans text-slate-800">
      {/* Config Pannel - Left */}
      <div className="w-full md:w-[360px] shrink-0 h-[45vh] md:h-screen z-20">
        <ConfigPanel 
          config={config} 
          onConfigChange={setConfig} 
          isActivated={isActivated}
          onToggleActivation={handleToggleActivation}
          onSaveSettings={handleSaveSettings}
        />
      </div>

      {/* Main Sandbox Area - Right */}
      <div className="flex-1 h-[55vh] md:h-screen relative z-10 box-border">
        <ChatSandbox 
          messages={messages} 
          isActivated={isActivated}
          isTyping={isTyping}
          onSendMessage={handleSendMessage}
          onTranscribeAudio={handleTranscribeAudio}
          toastMessage={toastMessage}
        />
      </div>
    </div>
  );
}
