export interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  audioData?: string;
  audioMimeType?: string;
  timestamp: Date;
}

export interface AgentConfig {
  apiKey: string;
  instagramToken: string;
  telegramToken: string;
  systemPrompt: string;
  calendarProvider?: 'google' | 'mock' | 'custom';
  calendarApiUrl?: string;
  calendarApiKey?: string;
}
