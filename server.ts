import "dotenv/config";
import express from "express";
import cron from "node-cron";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import fs from "fs";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

let supabase: any = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

let currentKeyIndex = 0;

function getApiKeys(): string[] {
    const keys: string[] = [];
    if (process.env.GEMINI_API_KEY) {
        keys.push(process.env.GEMINI_API_KEY);
    }
    if (process.env.GEMINI_API_KEYS) {
        keys.push(...process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(k => k));
    }
    if (fs.existsSync('agent-config.json')) {
        try {
            const cfg = JSON.parse(fs.readFileSync('agent-config.json', 'utf8'));
            if (cfg.apiKey) keys.push(cfg.apiKey);
        } catch (e) {}
    }
    return Array.from(new Set(keys)).filter(k => k);
}

function rotateKey(keys: string[]) {
    if (keys.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % keys.length;
        console.log("Rotated API key, now using index:", currentKeyIndex);
    }
}

async function generateContentWithFallback(ai: GoogleGenAI | null, options: { messages: any[], tools?: any[], systemInstruction?: string, model?: string }, retries = 3, retryDelay = 2000): Promise<any> {
  const allKeys = getApiKeys();
  let activeAi = ai || new GoogleGenAI({ apiKey: allKeys[currentKeyIndex] || process.env.GEMINI_API_KEY });


  const modelName = options.model || 'gemini-2.5-flash';
  const formattedMessages = options.messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'user', parts: [{ functionResponse: { name: m.name, response: JSON.parse(m.content), id: m.id } }] };
    }
    if (m.tool_calls) {
      const toolParts = m.tool_calls.map((c:any) => ({ functionCall: { name: c.function.name, args: JSON.parse(c.function.arguments), id: c.id } }));
      if (typeof m.content === "string" && m.content.length > 0) {
          return { role: 'model', parts: [{ text: m.content }, ...toolParts] };
      }
      return { role: 'model', parts: toolParts };
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: Array.isArray(m.content) ? m.content : [{ text: m.content }] };
  });

  const params: any = {
    model: modelName,
    contents: formattedMessages,
    config: {
        systemInstruction: options.systemInstruction,
        tools: options.tools
    }
  };
  
  // Clean up undefined properties from config to avoid SDK issues
  if (!params.config.systemInstruction) delete params.config.systemInstruction;
  if (!params.config.tools) delete params.config.tools;

  if (params.config.tools) {
    console.log("DEBUG API CALL - Tools active:", params.config.tools[0]?.functionDeclarations?.map((f: any) => f.name));
  } else {
    console.log("DEBUG API CALL - No tools configured!");
  }
// Removed global wait checking

  let response;
  let maxRetries = Math.max(retries, allKeys.length * 2);
  while (true) {
    try {
       response = await activeAi.models.generateContent(params);
       break;
    } catch(e: any) {
       console.warn("API Error in generateContentWithFallback:", String(e.message || e));
       const eStr = String(e.message || e);
       const isQuota = eStr.includes('429') || eStr.includes('quota') || eStr.includes('RESOURCE_EXHAUSTED');
       const isUnavailable = eStr.includes('503') || eStr.includes('UNAVAILABLE') || eStr.includes('high demand');
       
       if (isQuota || isUnavailable) {
           if (maxRetries > 0) {
               maxRetries--;
               if (allKeys.length > 1) {
                   rotateKey(allKeys);
                   const newKey = allKeys[currentKeyIndex];
                   activeAi = new GoogleGenAI({ apiKey: newKey });
               }
               if (isUnavailable) {
                   console.log("Service unavailable/high demand. Retrying request after 1.5s delay...");
                   await new Promise(resolve => setTimeout(resolve, 1500));
               } else {
                   console.log("Retrying request with new key...");
               }
               continue;
           }
       }
       throw e;
    }
  }

  const functionCalls = response.functionCalls ? response.functionCalls.map((fc: any) => ({

    id: fc.id || Math.random().toString(36).substring(7),
    function: { name: fc.name, arguments: JSON.stringify(fc.args) }
  })) : [];
  
  let safeText = "";
  try {
     safeText = response.text;
  } catch(e) {
     const parts = response.candidates?.[0]?.content?.parts || [];
     safeText = parts.map((p:any) => p.text || "").join("");
  }
  
  return {
    text: safeText || "",
    functionCalls
  };
}


async function handleSystemAnalysisLog(chatId: string, analysis: any) {
    if (!supabase) return { success: false, message: "No database configured" };
    try {
        if (analysis.name || analysis.phone || analysis.booked_appointment || analysis.feedback_left) {
           const updateData: any = {
              user_id: chatId.toString()
           };
           if (analysis.name) updateData.customer_name = analysis.name;
           if (analysis.phone) updateData.phone_number = analysis.phone;
           
           const { data: existing } = await supabase.from('appointments_leads').select('user_id').eq('user_id', chatId.toString()).single();
           if (existing && existing.user_id) {
               await supabase.from('appointments_leads').update(updateData).eq('user_id', existing.user_id);
           } else {
               await supabase.from('appointments_leads').insert([updateData]);
           }
           
           if (analysis.feedback_left && analysis.feedback_summary && activeConfig?.telegramToken && activeConfig?.adminTelegramChatId) {
               await fetch(`https://api.telegram.org/bot${activeConfig.telegramToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                     chat_id: activeConfig.adminTelegramChatId,
                     text: `New Feedback from ${analysis.name || chatId.toString()}:\n${analysis.feedback_summary}`
                  })
               });
           }
           return { success: true, message: "Logged analysis successfully" };
        }
        return { success: true, message: "Nothing to log" };
    } catch(e: any) {
        console.error("handleSystemAnalysisLog err:", e);
        return { success: false, error: e.message };
    }
}
async function postProcessMessage(chatId: string, platform: string, userMessage: string, agentResponse: string, tgToken?: string, aiConfigKey?: string) {
  if (!supabase) return;
  try {
    const payload = [
      {
        user_id: chatId.toString(),
        platform,
        sender: "user",
        message: userMessage
      },
      {
        user_id: chatId.toString(),
        platform,
        sender: "bot",
        message: agentResponse
      }
    ];
    const { error } = await supabase.from('chat_history').insert(payload).select();
    if (error) {
      console.error('Supabase chat_history error:', JSON.stringify(error));
      if (tgToken) {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: "Supabase chat_history Error: " + JSON.stringify(error) })
        });
      }
    }
  } catch(e) { console.error('Supabase chat_history error:', e); }

}

// Unified Calendar Adapter Interface
interface CalendarAdapter {
  checkSlots(startDate: string, endDate?: string, durationMinutes?: number): Promise<any> | any;
  insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes?: number, chatId?: string): Promise<any> | any;
  getEvents(startDate: string, endDate: string): Promise<any> | any;
}

function formatSwedishTimeSlots(slotsArray: string[], specificTime?: string): string {
    const dayMap = new Map<string, string[]>();
    let foundSpecificSlot = null;

    slotsArray.forEach(slot => {
        const match = slot.match(/\(ISO:\s(.*?)\)/);
        if (match && match[1]) {
            const iso = match[1];
            const d = new Date(iso);
            const months = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
            const days = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
            const dayName = days[d.getDay()];
            const dateStr = `${dayName} den ${d.getDate()} ${months[d.getMonth()]}`;
            const timeStr = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
            
            if (specificTime && timeStr.includes(specificTime)) {
                foundSpecificSlot = { dateStr, timeStr };
            }

            if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
            dayMap.get(dateStr)!.push(timeStr);
        } else {
             const basicSlot = slot.split(' (ISO')[0];
             const dateStr = "Vissa dagar";
             if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
             dayMap.get(dateStr)!.push(basicSlot);
        }
    });

    if (specificTime && foundSpecificSlot) {
        return `Ja, ${(foundSpecificSlot as any).dateStr} kl ${(foundSpecificSlot as any).timeStr} är ledig! Ska jag boka den åt dig?`;
    }

    let sentences = [];
    for (const [dateStr, times] of dayMap.entries()) {
        if (times.length === 1) {
            sentences.push(`${dateStr} kl ${times[0]}`);
        } else if (times.length === 2) {
            sentences.push(`${dateStr} kl ${times[0]} och ${times[1]}`);
        } else {
            const last = times.pop();
            sentences.push(`${dateStr} kl ${times.join(', ')} och ${last}`);
        }
    }

    if (specificTime && !foundSpecificSlot) {
        if (sentences.length === 0) return `Tyvärr är kl ${specificTime} redan bokat, och jag hittade inga andra lediga tider för den perioden. Har du något annat datum i åtanke? 😊`;
        return `Tyvärr är kl ${specificTime} redan bokat. Men jag hittade lediga tider ${sentences.join(', samt ')}. Vilken av dessa tider passar dig bäst? 😊`;
    }

    if (sentences.length === 0) return "Jag hittade tyvärr inga lediga tider för den perioden. Har du något annat datum i åtanke? 😊";
    
    return `Jag hittade lediga tider ${sentences.join(', samt ')}. Vilken av dessa tider passar dig bäst? 😊`;
}

function getDailySlots(startDateStr: string, endDateStr: string, events: any[], durationMinutes: number = 60) {
  const slots: string[] = [];
  
  // We parse the dates explicitly without assuming local timezone
  const startParts = startDateStr.split('-');
  const startD = new Date(Date.UTC(Number(startParts[0]), Number(startParts[1])-1, Number(startParts[2])));
  
  const endString = endDateStr || startDateStr;
  const endParts = endString.split('-');
  const endD = new Date(Date.UTC(Number(endParts[0]), Number(endParts[1])-1, Number(endParts[2])));
  
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', hour: 'numeric', minute: 'numeric', hour12: false });
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long' });

  for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
    // Skip weekends (0=Sunday, 6=Saturday)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    
    // Format YYYY-MM-DD
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const dStr = `${y}-${m}-${day}`;
    
    // Check from 10:00 to 18:00 (10 to 17 start times) per business hours
    for (let i = 10; i <= 17; i++) {
      const startHour = String(i).padStart(2, '0');
      const isoString = `${dStr}T${startHour}:00:00+02:00`;
      const slotD = new Date(isoString);
      const requestedStartTime = slotD.getTime();
      const requestedEndTime = requestedStartTime + durationMinutes * 60 * 1000;
      
      // Skip slots in the past
      if (requestedStartTime < Date.now()) continue;

      let isBooked = false;
      for (const e of events) {
        if (!e.start && !e.startTime) continue;
        const startIso = e.start?.dateTime || e.start?.date || e.startTime;
        const endIso = e.end?.dateTime || e.end?.date || e.endTime;
        
        const eventStartTime = new Date(startIso).getTime();
        const eventEndTime = new Date(endIso).getTime() || (eventStartTime + 60*60*1000);
        
        if ((requestedStartTime < eventEndTime) && (requestedEndTime > eventStartTime)) {
          isBooked = true;
          break;
        }
      }
      
      if (!isBooked) {
        let weekday = dayFormatter.format(slotD);
        weekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
        slots.push(`${weekday} kl ${formatter.format(slotD)} (ISO: ${isoString})`);
      }
    }
  }
  
  const topSlots = slots.slice(0, 3);
  if (topSlots.length === 0) return "No available slots found for this period.";
  return topSlots.join("\n");
}

// Default Mock implementation
class MockCalendarAdapter implements CalendarAdapter {
  events: any[] = [
    { id: '1', summary: 'Meeting with Bob', startTime: '2026-06-06T10:00:00Z', endTime: '2026-06-06T11:00:00Z' }
  ];

  checkSlots(startDate: string, endDate?: string, durationMinutes?: number) {
    const events = this.events;
    const slots = getDailySlots(startDate, endDate || startDate, events, durationMinutes);
    return { available_slots_string: slots };
  }

  getEvents(startDate: string, endDate: string) { return this.events; }
  insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes: number = 60, chatId?: string) {
    const conflicting = this.events.filter(e => e.startTime === dateTime);
    if(conflicting.length > 0) return { success: false, message: "Slot already booked." };
    const evEnd = new Date(new Date(dateTime).getTime() + durationMinutes * 60000).toISOString();
    const event = { id: String(this.events.length + 1), summary: `Bokad: ${name} - ${phone}`, description: `Tjänst: ${service}\nTelegramChatId: ${chatId || ''}`, startTime: dateTime, endTime: evEnd };
    this.events.push(event);
    return { success: true, message: `Successfully booked for ${name} at ${dateTime}.`, event };
  }
}

// Generic Webhook/REST implementation
class GenericCalendarAdapter implements CalendarAdapter {
  constructor(private apiUrl: string, private apiKey?: string) {}

  async getEvents(startDate: string, endDate: string) { return []; }
  async getEvents(startDate: string, endDate: string) {
    try {
      const timeMin = new Date(`${startDate}T00:00:00Z`).toISOString();
      const timeMax = new Date(`${endDate}T23:59:59Z`).toISOString();
      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return res.data.items || [];
    } catch(e) { return []; }
  }
  async checkSlots(startDate: string, endDate?: string, durationMinutes?: number) {
    try {
      const headers: any = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/check?startDate=${startDate}&endDate=${endDate || startDate}&duration=${durationMinutes || 60}`, { headers });
      return await res.json();
    } catch(e) {
      return { success: false, message: 'Failed to access remote calendar API to check slots.' };
    }
  }

  async insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes?: number, chatId?: string) {
    try {
      const headers: any = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/book`, { 
        method: 'POST', 
        headers,
        body: JSON.stringify({ name, phone, service, dateTime, durationMinutes, chatId })
      });
      return await res.json();
    } catch(e) {
      return { success: false, message: 'Failed to access remote calendar API to book slot.' };
    }
  }
}

// Google Calendar API implementation
class GoogleCalendarAdapter implements CalendarAdapter {
  private calendar: any;
  private calendarId: string;

  constructor(clientEmail: string, privateKey: string, calendarId: string) {
    let finalKey = privateKey || process.env.GOOGLE_PRIVATE_KEY || '';
    let finalEmail = clientEmail || process.env.GOOGLE_CLIENT_EMAIL;

    if (finalKey.trim().startsWith('{')) {
      try {
        const keyJson = JSON.parse(finalKey);
        if (keyJson.private_key) finalKey = keyJson.private_key;
        if (keyJson.client_email && !finalEmail) finalEmail = keyJson.client_email;
      } catch (e) {
        // ignore
      }
    }

    if (finalKey.startsWith('"') && finalKey.endsWith('"')) {
      finalKey = finalKey.slice(1, -1);
    }
    const cleanKey = finalKey.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT({
      email: finalEmail,
      key: cleanKey,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    this.calendar = google.calendar({ version: 'v3', auth: auth });
    this.calendarId = calendarId;
  }

  async checkSlots(startDate: string, endDate?: string, durationMinutes?: number) {
    try {
      const timeMin = new Date(`${startDate}T00:00:00Z`).toISOString();
      const endDateString = endDate || startDate;
      const timeMax = new Date(`${endDateString}T23:59:59Z`).toISOString();

      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      });
      const events = res.data.items || [];
      const slotsText = getDailySlots(startDate, endDateString, events, durationMinutes);
      return { available_slots_string: slotsText };
    } catch(e: any) {
      console.error("Google Calendar checkSlots Error:", e.message);
      return { success: false, message: 'Failed to access Google Calendar API to check slots.' };
    }
  }

  async insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes: number = 60, chatId?: string) {
    try {
      // Container runs in UTC, so parsing "T15:00:00" assumes UTC, which is 17:00 in Sweden.
      // We explicitly append Europe/Stockholm offset if not provided.
      const safeDateTime = dateTime.includes('Z') || dateTime.includes('+') ? dateTime : dateTime + "+02:00";
      const startTime = new Date(safeDateTime);
      const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000); // dynamic duration

      const res = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: `Bokad: ${name} - ${phone}`,
          description: `Tjänst: ${service}\nTelegramChatId: ${chatId || ''}`,
          start: { dateTime: startTime.toISOString(), timeZone: "Europe/Stockholm" },
          end: { dateTime: endTime.toISOString(), timeZone: "Europe/Stockholm" },
        },
      });
      return { success: true, message: `Successfully booked for ${name} at ${dateTime}.`, event: res.data };
    } catch(e: any) {
      console.error("Google Calendar insertAppointment Error:", e.message);
      return { success: false, message: 'Failed to access Google Calendar API to book slot.' };
    }
  }
}

function getCalendarAdapter(config: any): CalendarAdapter {
  if (config.calendarProvider === 'google' || 
      (!config.calendarProvider && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_CALENDAR_ID)) {
    const email = process.env.GOOGLE_CLIENT_EMAIL || config.googleClientEmail;
    const key = process.env.GOOGLE_PRIVATE_KEY || config.googlePrivateKey;
    const id = process.env.GOOGLE_CALENDAR_ID || config.googleCalendarId;
    if (email && key && id) {
      return new GoogleCalendarAdapter(email, key, id);
    } else {
      console.warn("Google Calendar adapter requested but credentials missing. Falling back to Mock.");
    }
  } else if (config.calendarProvider === 'custom' && config.calendarApiUrl) {
    return new GenericCalendarAdapter(config.calendarApiUrl, config.calendarApiKey);
  }
  return new MockCalendarAdapter();
}

const calendarTools: any = [{
  functionDeclarations: [
    {
      name: "checkSlots",
      description: "Checks availability for a date or a range of dates. Returns a single simple text string containing the top 3 available slots that the agent should offer to the user without any further processing.",
      parameters: {
        type: "OBJECT",
        properties: {
          startDate: { type: "STRING", description: "Start date in YYYY-MM-DD format." },
          endDate: { type: "STRING", description: "End date in YYYY-MM-DD format. If only asking for one day, this can be omitted." },
          requestedTime: { type: "STRING", description: "If the user explicitly requested a specific time, pass it here (e.g., '13:00' or '10:00'). Otherwise omit." },
          durationMinutes: { type: "INTEGER", description: "The length of the requested booking in minutes. MANDATORY: Calculate this as (treatment duration + 15 min buffer). Example: Bikinilinje is 20 min -> durationMinutes = 35." }
        },
        required: ["startDate", "durationMinutes"]
      }
    },
    {
      name: "insertAppointment",
      description: "Creates an event in the configured calendar provider. Must check availability first. You are STRICTLY PROHIBITED from calling this until you have explicitly asked the user for both their Name and Mobile Number and received them.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "The customer's name." },
          phone: { type: "STRING", description: "The customer's mobile number. Must be explicitly collected." },
          service: { type: "STRING", description: "The service being booked." },
          dateTime: { type: "STRING", description: "The requested start time in ISO 8601 format." },
          durationMinutes: { type: "INTEGER", description: "The length of the booking in minutes. Calculate as (treatment duration + 15 min buffer)." }
        },
        required: ["name", "phone", "service", "dateTime", "durationMinutes"]
      }
    },
    {
      name: "logSystemAnalysis",
      description: "Logs the user's intent quietly. Call this tool alongside others whenever the user provides their name, phone, requests an appointment, or leaves feedback.",
      parameters: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "user's name if mentioned, else null" },
          phone: { type: "STRING", description: "user's phone number if mentioned, else null" },
          booked_appointment: { type: "BOOLEAN", description: "true if user is trying to book or booked, else false" },
          feedback_left: { type: "BOOLEAN", description: "true if they left any complain/suggestion, else false" },
          feedback_summary: { type: "STRING", description: "summary of feedback if they left any, else null" }
        }
      }
    }
  ]
}];

let activeConfig: any = {};
if (fs.existsSync(path.join(process.cwd(), "agent-config.json"))) {
  try {
    activeConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "agent-config.json"), "utf8"));
  } catch(e) {}
}

activeConfig = {
  ...activeConfig,
  apiKey: process.env.GEMINI_API_KEY || activeConfig.apiKey,
  telegramToken: process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || activeConfig.telegramToken,
  instagramToken: process.env.INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || activeConfig.instagramToken,
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_ID || activeConfig.adminTelegramChatId,
  systemPrompt: process.env.SYSTEM_PROMPT || activeConfig.systemPrompt,
  calendarProvider: activeConfig.calendarProvider || "google",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || activeConfig.googleCalendarId,
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || activeConfig.googleClientEmail,
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY || activeConfig.googlePrivateKey,
};

const chatSessions: Record<number, any[]> = {};
let globalWaitUntil = 0;

type TelegramPollerState = {
  isPolling: boolean;
  lastUpdateId: number;
  pollingTimeout: NodeJS.Timeout | null;
  config: any;
};

const telegramPollers: Record<string, TelegramPollerState> = {};
const processedUpdateIds = new Set<string>();

function maskToken(token?: string) {
  if (!token) return "missing-token";
  if (token.length < 12) return token;
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function normalizeBusinessConfig(row: any) {
  return {
    ...activeConfig,
    businessRecordId: row.id,
    businessName: row.business_name,
    telegramToken: row.telegram_bot_token,
    googleCalendarId: row.google_calendar_id,
    systemPrompt: row.custom_system_prompt,
    calendarProvider: "google",
  };
}

async function startTelegramPolling(config: any) {
  const token = config?.telegramToken;
  if (!token) {
    console.log("Telegram polling skipped: missing telegram token.");
    return;
  }

  if (telegramPollers[token]?.isPolling) {
    console.log(`Telegram polling already active for ${config.businessName || "business"} (${maskToken(token)})`);
    return;
  }

  const pollingConfig = { ...activeConfig, ...config, telegramToken: token };
  const state: TelegramPollerState = {
    isPolling: true,
    lastUpdateId: 0,
    pollingTimeout: null,
    config: pollingConfig,
  };

  telegramPollers[token] = state;

  console.log(`Starting Telegram long polling for ${pollingConfig.businessName || "business"} (${maskToken(token)})...`);

  try {
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`);
  } catch (e) {
    console.error(`Error clearing webhook for ${maskToken(token)}:`, e);
  }

  const poll = async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=30`);
      const data = await res.json();

      if (!data.ok) {
        console.error(`Telegram getUpdates failed for ${pollingConfig.businessName || "business"} (${maskToken(token)}):`, data);
      } else if (data.result.length > 0) {
        console.log(`Received ${data.result.length} Telegram update(s) for ${pollingConfig.businessName || "business"} (${maskToken(token)})`);
        for (const update of data.result) {
          state.lastUpdateId = update.update_id;
          await processTelegramUpdate(update, state.config, "telegram-polling");
        }
      }
    } catch (e) {
      console.error(`Polling error for ${pollingConfig.businessName || "business"} (${maskToken(token)}):`, e);
    }

    if (state.isPolling) {
      state.pollingTimeout = setTimeout(poll, 1000);
    }
  };

  poll();
}

async function startAllBusinessTelegramPollers() {
  const startedTokens = new Set<string>();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .not('telegram_bot_token', 'is', null);

      if (error) throw error;

      for (const business of data || []) {
        const token = business.telegram_bot_token;
        if (!token || startedTokens.has(token)) continue;

        startedTokens.add(token);
        await startTelegramPolling(normalizeBusinessConfig(business));
      }
    } catch (err) {
      console.error("Failed to load business telegram pollers from Supabase:", err);
    }
  }

  const fallbackToken = activeConfig.telegramToken || process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (fallbackToken && !startedTokens.has(fallbackToken)) {
    await startTelegramPolling({
      ...activeConfig,
      businessName: activeConfig.businessName || "Environment Bot",
      telegramToken: fallbackToken,
    });
  }
}

async function processTelegramUpdate(update: any, config: any, platform: string = "telegram-polling") {
  const telegramToken = config?.telegramToken;
  if (!telegramToken) return;

  if (update.update_id) {
    const processedKey = `${telegramToken}:${update.update_id}`;
    if (processedUpdateIds.has(processedKey)) return;
    processedUpdateIds.add(processedKey);
    if (processedUpdateIds.size > 5000) {
        const first = processedUpdateIds.values().next().value;
        if (first !== undefined) processedUpdateIds.delete(first);
    }
  }

  const { apiKey, systemPrompt } = config;
  if (!update.message) return;
  if (!update.message.chat) return;

  const chatId = update.message.chat.id;
  console.log(`Processing Telegram message for ${config.businessName || "business"} (${maskToken(telegramToken)}), chatId=${chatId}`);
  try {
    // 🌟 تزریق پایگاه داده برای بارگذاری پویای اطلاعات بیزینس
    if (supabase) {
      const { data: sessionData } = await supabase
        .from('chat_history')
        .select('business_id')
        .eq('user_id', chatId.toString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sessionData && sessionData.business_id) {
        const { data: activeTenant } = await supabase
          .from('businesses')
          .select('*')
          .eq('id', sessionData.business_id)
          .single();

        if (activeTenant) {
          config.telegramToken = activeTenant.telegram_bot_token;
          config.googleCalendarId = activeTenant.google_calendar_id;
          config.systemPrompt = activeTenant.custom_system_prompt;
         }
      }
    }
    // 🌟 پایان تزریق

  } catch (tenantErr) {
    console.error("Tenant config injection failed:", tenantErr);
  }

  try {
    const text = update.message.text;
    const voice = update.message.voice;
    
    
    const ai = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY });
    if (!chatSessions[chatId]) chatSessions[chatId] = [];
    const history = chatSessions[chatId];
    let userMessageContent: any = "";
    
    if (text) {
      userMessageContent = text;
    } else if (voice) {
      try {
        const fileRes = await fetch(`https://api.telegram.org/bot${telegramToken}/getFile?file_id=${voice.file_id}`);
        const fileData = await fileRes.json();
        if (fileData.ok) {
           const fileUrl = `https://api.telegram.org/file/bot${telegramToken}/${fileData.result.file_path}`;
           const audioRes = await fetch(fileUrl);
           const audioBuffer = await audioRes.arrayBuffer();
           
           const base64Audio = Buffer.from(audioBuffer).toString("base64");
           
           userMessageContent = [ { text: "Voice message input:" }, { inlineData: { data: base64Audio, mimeType: "audio/ogg" } } ];
        } else {
           userMessageContent = "[User sent a voice message, but I couldn't download it]";
        }
      } catch (e: any) {
        console.error("Error downloading voice note:", e);
        const eStr = String(e.message || e);
        if (eStr.includes("429") || eStr.includes("503") || eStr.includes("quota") || eStr.includes("high demand")) {
            throw e;
        }
        userMessageContent = "[User sent a voice message, but an error occurred downloading it]";
      }
    } else {
      return; // Ignore other types
    }
    
    const messages = [...history];
    messages.push({ role: "user", content: userMessageContent });
    
const businessName = config.businessName || config.business_name || 'this business';

const constraint = `
CRITICAL CONSTRAINT:
Your response for each message MUST be concise and strictly limited to a maximum of 60 words.
Use the business-specific system prompt from the database as your main source of truth.
You must act only as the receptionist for: ${businessName}.
Never mention Laser Luxury unless the current business name is Laser Luxury.
Never mention services, prices, or treatments that are not included in this business-specific system prompt.
If the customer asks about services and the prompt does not include enough information, politely ask what service they are interested in or say you can help with booking and general guidance.
Before confirming any booking, you must check availability.
Before creating any appointment, collect the customer's name and mobile number.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
`;
    const swedenDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Europe/Stockholm',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;
    
    let finalSystemInstruction = (systemPrompt || "") + currentDateContext + constraint;
    if (voice) {
        finalSystemInstruction += 
          "\nVoice specific instructions: You officially support 4 languages: Swedish, Persian (Farsi), English, and Spanish.\n" +
          "CRITICAL: Detect the language the user is speaking, and you MUST reply in that exact same language.\n" +
          "CRITICAL CONSTRAINT: Keep response max 60 words, use memory of checked slots if applicable, otherwise use `checkSlots` immediately!!";
    }
    
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
                    .split('\n')
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
                const notifyText = `🔔 Ny bokning mottagen!\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
                await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
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
         systemInstruction: finalSystemInstruction + "\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
         model: 'gemini-2.5-flash'
      });
    }
    
    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: "user", content: Array.isArray(userMessageContent) ? "(User Voice Message)" : userMessageContent });
    history.push({ role: "assistant", content: textResponse });
    
    // Voice-to-Voice vs Text-to-Text via Gemini
    if (voice) {
      let sentAudio = false;
      try {
         const EdgeTTS = (await import('node-edge-tts')).EdgeTTS;
         let voiceCode = 'en-US-AriaNeural'; // default English
         const lowerText = textResponse.toLowerCase();
         if (/[\u0600-\u06FF]/.test(textResponse)) {
             voiceCode = 'fa-IR-DilaraNeural'; // Persian
         } else if (/[åäöÅÄÖ]/i.test(textResponse) || /\b(hej|tack|ja|nej|bra|jag|är|en|ett|för)\b/i.test(textResponse)) {
             voiceCode = 'sv-SE-SofieNeural'; // Swedish
         } else if (/[áéíóúñ¿¡]/i.test(textResponse) || /\b(gracias|hola|adiós|sí|claro|por favor|el|la|los|las|y)\b/i.test(textResponse)) {
             voiceCode = 'es-ES-ElviraNeural'; // Spanish
         }

         const outName = `/tmp/bot_tts_${Date.now()}.mp3`;
         const cleanText = sanitizeTTS(textResponse);
         const finalTts = new EdgeTTS({ voice: voiceCode, rate: '-10%', timeout: 60000 });
         await finalTts.ttsPromise(cleanText || "Förlåt, jag förstod inte.", outName);
         
         const mp3Buf = fs.readFileSync(outName);
         const blob = new Blob([mp3Buf as any], { type: 'audio/mpeg' });
         const formData = new FormData();
         formData.append('chat_id', chatId.toString());
         formData.append('voice', blob, 'response.mp3');
         
         await fetch(`https://api.telegram.org/bot${telegramToken}/sendVoice`, {
           method: 'POST',
           body: formData as any
         });
         fs.unlinkSync(outName);
         sentAudio = true;
      } catch (ttsErr) {
        console.error("TTS generation failed:", ttsErr);
      }
      
      if (!sentAudio) {
        await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: textResponse })
        });
      }
      postProcessMessage(chatId.toString(), platform, userMessageContent, textResponse, telegramToken, apiKey);
    } else {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: textResponse })
      });
      
      postProcessMessage(chatId.toString(), platform, userMessageContent, textResponse, telegramToken, apiKey);
    }
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    const eStr = String(error.message || error);
    if (update.message && update.message.chat && update.message.chat.id && config.telegramToken && (eStr.includes("429") || eStr.includes("503") || eStr.includes("quota") || eStr.includes("RESOURCE_EXHAUSTED") || eStr.includes("high demand"))) {
       try {
          await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: update.message.chat.id, text: "Just nu är det hög belastning på linjen. Vänligen vänta några sekunder och pröva att skicka ditt meddelande igen! 😊" })
          });
       } catch(e) {
          console.error("Failed to send fallback message", e);
       }
    }
  }
}


function sanitizeTTS(text: string) {
  if (!text) return text;
  let cleaned = text.replace(/[*#~`!\[\]\(\)]/g, "");
  cleaned = cleaned.replace(/\{.*?\}/gs, "");
  cleaned = cleaned.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  return cleaned.trim();
}


function setupDailyReminders() {
  cron.schedule("0 19 * * *", async () => {
    console.log("[Cron] Starting daily reminder job for tomorrow's appointments...");
    try {
      const adapter = getCalendarAdapter(activeConfig);
      
      const swedenFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
      const tomorrowMs = Date.now() + 24 * 60 * 60 * 1000;
      const tomorrowDateStr = swedenFormatter.format(tomorrowMs);
      
      const events = await adapter.getEvents(tomorrowDateStr, tomorrowDateStr);
      let dispatched = 0;
      
      if (!events || events.length === 0) {
        console.log("[Cron] No events found for tomorrow.");
        return;
      }

      const telegramToken = activeConfig.telegramToken || process.env.TELEGRAM_TOKEN;
      if (!telegramToken) {
        console.log("[Cron] No Telegram token configured. Aborting reminders.");
        return;
      }
      
      const months = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
      const days = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
      
      for (const event of events) {
         if (!event.start || !event.start.dateTime) continue;
         const startIso = event.start.dateTime;
         const eventDate = new Date(startIso);
         
         const dayName = days[eventDate.getDay()];
         const dayNum = eventDate.getDate();
         const monthName = months[eventDate.getMonth()];
         const tStr = eventDate.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
         
         const summary = event.summary || '';
         const matchName = summary.match(/Bokad:\s(.*?)\s-/);
         const name = matchName ? matchName[1] : 'kära kund';
         
         const desc = event.description || '';
         const matchChatId = desc.match(/TelegramChatId:\s(\d+)/);
         if (matchChatId && matchChatId[1]) {
            const chatId = matchChatId[1];
           const reminderBusinessName = activeConfig.businessName || activeConfig.business_name || 'oss';

           const msg = `Hej ${name}! Det här är en påminnelse från ${reminderBusinessName}. Du har en bokad tid för behandling imorgon, ${dayName} den ${dayNum} ${monthName}, klockan ${tStr}. Vi ser fram emot att träffa dig! Varmt välkommen! 😊`;
            try {
              const fetchResult = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, text: msg })
              });
              if(fetchResult.ok) {
                 dispatched++;
              } else {
                 console.log(`[Cron] Failed to send to ${chatId}: ${fetchResult.statusText}`);
              }
            } catch(e: any) {
               console.error(`[Cron] Fetch error sending to ${chatId}:`, e.message);
            }
         }
      }
      console.log(`[Cron] Successfully dispatched ${dispatched} reminders.`);
    } catch(err: any) {
      console.error("[Cron] Daily reminder job encountered an error:", err.message);
    }
  }, {
    timezone: "Europe/Stockholm"
  });
  console.log("[Cron] Daily reminder job scheduled at 19:00 Europe/Stockholm time.");
}


async function processInstagramUpdate(webhook_event: any, config: any, platform: string = "instagram-webhook") {
  const senderId = webhook_event.sender?.id;
  const messageText = webhook_event.message?.text;
  
  if (!senderId || !messageText) return;

  const chatId = `ig_${senderId}`;
  const voice = null; 
  try {
  // 🌟 تزریق پایگاه داده برای بارگذاری پویای اطلاعات بیزینس (اینستاگرام)
  if (supabase) {
    const { data: sessionData } = await supabase
      .from('chat_history')
      .select('business_id')
      .eq('user_id', chatId.toString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionData && sessionData.business_id) {
      const { data: activeTenant } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', sessionData.business_id)
        .single();

      if (activeTenant && config) {
        config.systemPrompt = activeTenant.custom_system_prompt;
        config.googleCalendarId = activeTenant.google_calendar_id;
            }
      }
    }
    // 🌟 پایان تزریق

  } catch (tenantErr) {
    console.error("Instagram tenant config injection failed:", tenantErr);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: config?.apiKey || process.env.GEMINI_API_KEY });
    if (!chatSessions[chatId]) chatSessions[chatId] = [];
    const history = chatSessions[chatId];
    let userMessageContent: any = messageText;
    
    const messages = [...history];
    messages.push({ role: "user", content: userMessageContent });
    
 const businessName = config.businessName || config.business_name || 'this business';

const constraint = `
CRITICAL CONSTRAINT:
Your response for each message MUST be concise and strictly limited to a maximum of 60 words.
Use the business-specific system prompt from the database as your main source of truth.
You must act only as the receptionist for: ${businessName}.
Never mention Laser Luxury unless the current business name is Laser Luxury.
Never mention services, prices, or treatments that are not included in this business-specific system prompt.
If the customer asks about services and the prompt does not include enough information, politely ask what service they are interested in or say you can help with booking and general guidance.
Before confirming any booking, you must check availability.
Before creating any appointment, collect the customer's name and mobile number.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
`;
    const swedenDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Europe/Stockholm',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;
    
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
                    .split('\n')
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
                const notifyText = `🔔 Ny bokning mottagen!\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
                await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
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
         systemInstruction: finalSystemInstruction + "\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
         model: 'gemini-2.5-flash'
      });
    }
    
    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: "user", content: userMessageContent });
    history.push({ role: "assistant", content: textResponse });
    
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    if (accessToken) {
        await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${accessToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
            await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${accessToken}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipient: { id: senderId },
                message: { text: "Ursäkta, jag stötte på ett tekniskt problem. Kan du försöka igen om en stund?" }
              })
            });
        }
    } catch(e) {}
  }
}

async function startServer() {

  const PORT = Number(process.env.PORT) || 3000;
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  
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

  app.post("/api/setup-telegram", async (req, res) => {
    try {
      const config = req.body;
      activeConfig = config;
      fs.writeFileSync(path.join(process.cwd(), "agent-config.json"), JSON.stringify(config, null, 2));
      
      if (config.telegramToken) {
        try {
          await fetch(`https://api.telegram.org/bot${config.telegramToken}/deleteWebhook`);
        } catch (e) {
          console.error("Error clearing old webhook:", e);
        }
        startTelegramPolling(config);
      }
      res.json({ success: true, message: "Configuration saved and webhook registered." });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/telegram-webhook", async (req, res) => {
    res.status(200).send("OK");
    await processTelegramUpdate(req.body, activeConfig, "telegram-webhook");
  });

  app.post("/api/chat", async (req, res) => {
    const { chatId: clientChatId } = req.body;
    const chatId = clientChatId || "web-" + Math.random().toString(36).substring(7);
    
    try {
      const { message, audioData: incomingAudioData, mimeType: incomingMimeType, apiKey } = req.body;
      const ai = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY });
      
      if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
      const history = chatSessions[chatId as any];
      
      let userMessageContent = message;
      
      if (incomingAudioData) {
          try {
             const base64Audio = incomingAudioData.startsWith('data:') 
                ? incomingAudioData.split(',')[1] 
                : Buffer.from(incomingAudioData, "base64").toString("base64");
                
              userMessageContent = [
                  { text: "Voice message input:" },
                  { inlineData: { data: base64Audio, mimeType: incomingMimeType || "audio/ogg" } }
              ];
          } catch(e: any) {
             console.error("Transcription failed", e);
             const eStr = String(e.message || e);
             if (eStr.includes("429") || eStr.includes("503") || eStr.includes("quota") || eStr.includes("high demand")) {
                 throw e;
             }
             userMessageContent = message;
          }
      }

      const messages: any[] = [...history];
      messages.push({ role: "user", content: userMessageContent });
const businessName = config.businessName || config.business_name || 'this business';

const constraint = `
CRITICAL CONSTRAINT:
Your response for each message MUST be concise and strictly limited to a maximum of 60 words.
Use the business-specific system prompt from the database as your main source of truth.
You must act only as the receptionist for: ${businessName}.
Never mention Laser Luxury unless the current business name is Laser Luxury.
Never mention services, prices, or treatments that are not included in this business-specific system prompt.
If the customer asks about services and the prompt does not include enough information, politely ask what service they are interested in or say you can help with booking and general guidance.
Before confirming any booking, you must check availability.
Before creating any appointment, collect the customer's name and mobile number.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
`;
      const swedenDate = new Date().toLocaleDateString('en-US', {
        timeZone: 'Europe/Stockholm',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;
      
      let finalSystemInstruction = (activeConfig.systemPrompt || "") + currentDateContext + constraint;
      if (incomingAudioData) {
          finalSystemInstruction += 
            "\nVoice specific instructions: You officially support 7 languages: Swedish, German/Tyska, Italian, Portuguese, Persian (Farsi), English, and Spanish.\n" +
            "CRITICAL: Detect the language the user is speaking, and you MUST reply in that exact same language.\n" +
            "CRITICAL CONSTRAINT: Keep response max 60 words, use memory of checked slots if applicable, otherwise use `checkSlots` immediately!!";
      }

      let chatResponse = await generateContentWithFallback(null, {
        messages,
        systemInstruction: finalSystemInstruction, 
        tools: calendarTools,
        model: 'gemini-2.5-flash'
      });
      
      let maxWebTurns = 3;
      while (chatResponse.functionCalls && chatResponse.functionCalls.length > 0 && maxWebTurns > 0) {
        maxWebTurns--;
        messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });
        const adapter = getCalendarAdapter(activeConfig);
        const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
          let adapterRes;
          const args = JSON.parse(call.function.arguments);
          if (call.function.name === "checkSlots" && args) {
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes);
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\n')
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
                const notifyText = `🔔 Ny bokning mottagen!\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
                await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
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
           systemInstruction: finalSystemInstruction + "\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
           model: 'gemini-2.5-flash'
        });
      }
      
      history.push({ role: "user", content: Array.isArray(userMessageContent) ? "(User Voice Message)" : userMessageContent });
      let textPart = chatResponse.text || "I couldn't process your request.";
      history.push({ role: "assistant", content: textPart });

      let audioDataOut = null;
      let outMimeType = null;
      
     if (incomingAudioData) {
    try {
        const EdgeTTS = (await import('node-edge-tts')).EdgeTTS;
        let voiceCode = 'en-US-AriaNeural'; // default English
        const lowerText = textPart.toLowerCase();

        // بررسی زبان فارسی
        if (/[\u0600-\u06FF]/.test(textPart)) {
            voiceCode = 'fa-IR-DilaraNeural'; 
            
        // بررسی زبان سوئدی
        } else if (/[\u00e4\u00f6\u00e5\u00c4\u00d6\u00c5]/i.test(textPart) || /\b(hej|tack|ja|nej|bra|jag|är|en|ett|för|ledig|boka)\b/i.test(lowerText)) {
            voiceCode = 'sv-SE-SofieNeural'; 
            
        // بررسی زبان اسپانیایی
        } else if (/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1]/i.test(textPart) || /\b(gracias|hola|adiós|sí|claro|por favor)\b/i.test(lowerText)) {
            voiceCode = 'es-ES-ElviraNeural'; 

        // ----- فیکسِ قطعی برای آلمانی (با بررسی کلمات رایج آلمانی در پاسخ) -----
        } else if (/\b(h[aä]ll[oö]|guten|tag|danke|nein|entschuldigung|super|ist|ledig|freitag|uhr|termin)\b/i.test(lowerText) || lowerText.includes(' ist ') || lowerText.includes(' ledig ')) {
            voiceCode = 'de-DE-KatjaNeural'; // German (آلمانی)

        // بررسی ایتالیایی
        } else if (/\b(ciao|buongiorno|grazie|prego)\b/i.test(lowerText)) {
            voiceCode = 'it-IT-ElsaNeural'; // Italian (ایتالیایی)

        // بررسی پرتغالی
        } else if (/\b(olá|bom dia|obrigado)\b/i.test(lowerText)) {
            voiceCode = 'pt-PT-DuarteNeural'; // Portuguese (پرتغالی)
        }

           const outName = `/tmp/web_tts_${Date.now()}.mp3`;
           const cleanWebText = sanitizeTTS(textPart);
           const finalWebTts = new EdgeTTS({ voice: voiceCode, rate: '-10%', timeout: 60000 });
           await finalWebTts.ttsPromise(cleanWebText || "Förlåt, jag förstod inte.", outName);
           
           const mp3Buf = fs.readFileSync(outName);
           audioDataOut = mp3Buf.toString("base64");
           outMimeType = "audio/mpeg";
           
           fs.unlinkSync(outName);
         } catch (ttsErr) {
           console.error("Web TTS failed:", ttsErr);
         }
      }

      postProcessMessage(chatId, "web-chat", message || "[Voice]", textPart, undefined, apiKey);
      res.json({ text: textPart, audioData: audioDataOut, mimeType: outMimeType, chatId });
    } catch (error: any) {
      console.error("Web chat processing error:", error);
      if (!res.headersSent) {
          const eStr = String(error.message || error);
          if (eStr.includes("429") || eStr.includes("503") || eStr.includes("quota") || eStr.includes("RESOURCE_EXHAUSTED") || eStr.includes("high demand")) {
              res.status(200).json({ text: "Just nu är det hög belastning på linjen. Vänligen vänta några sekunder och pröva att skicka ditt meddelande igen! 😊", chatId });
          } else {
              res.status(500).json({ error: eStr });
          }
      }
    }
  });

  app.post("/api/transcribe", async (req, res) => {
    try {
      const { audioData, mimeType, apiKey } = req.body;
      const allKeys = getApiKeys();
      let activeAi = new GoogleGenAI({ apiKey: apiKey || allKeys[currentKeyIndex] || process.env.GEMINI_API_KEY });
      let transcriptionRes;
      let maxRetries = Math.max(3, allKeys.length * 2);
      while (true) {
         try {
             transcriptionRes = await activeAi.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    { inlineData: { data: audioData, mimeType: mimeType || "audio/ogg" } },
                    "Analyze this booking request voice note and transcribe it accurately. Output ONLY the transcript without any markdown or formatting."
                ]
             });
             break;
         } catch (e: any) {
             console.warn("API Error in transcribe:", String(e.message || e));
             const eStr = String(e.message || e);
             const isQuota = eStr.includes('429') || eStr.includes('quota') || eStr.includes('RESOURCE_EXHAUSTED');
             const isUnavailable = eStr.includes('503') || eStr.includes('UNAVAILABLE') || eStr.includes('high demand');
             
             if (isQuota || isUnavailable) {
                 if (maxRetries > 0) {
                     maxRetries--;
                     if (allKeys.length > 1) {
                         rotateKey(allKeys);
                         activeAi = new GoogleGenAI({ apiKey: allKeys[currentKeyIndex] });
                     }
                     if (isUnavailable) {
                         console.log("Transcription: Service unavailable/high demand. Retrying after 1.5s delay...");
                         await new Promise(resolve => setTimeout(resolve, 1500));
                     } else {
                         console.log("Retrying transcription with new key...");
                     }
                     continue;
                 }
             }
             throw e;
         }
      }
      res.json({ text: transcriptionRes.text });
    } catch (error: any) {
      console.error("Transcribe processing error:", error);
      const eStr = String(error.message || error);
      if (eStr.includes("429") || eStr.includes("503") || eStr.includes("quota") || eStr.includes("RESOURCE_EXHAUSTED") || eStr.includes("high demand")) {
         res.status(200).json({ text: "Just nu är det hög belastning på linjen. Vänligen vänta några sekunder och pröva att skicka ditt meddelande igen! 😊" });
      } else {
         res.status(500).json({ error: eStr });
      }
    }
  });


  // API: دریافت لیست سالن‌ها/شعبه‌ها از دیتابیس
  app.get('/api/salons', async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
      }

      const { data, error } = await supabase
        .from('salons')
        .select('*')
       

      if (error) throw error;

      res.status(200).json(data || []);
    } catch (err: any) {
      console.error('Error fetching salons:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // API: ثبت سالن/شعبه جدید در دیتابیس
  app.post('/api/salons', async (req, res) => {
    try {
      if (!supabase) {
        return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
      }

      const { salonName, businessId, status } = req.body;

      if (!salonName || !businessId) {
        return res.status(400).json({ success: false, message: 'salonName and businessId are required.' });
      }

      const { data, error } = await supabase
        .from('salons')
        .insert([
          {
            salon_name: salonName,
            business_id: businessId,
            status: status || 'active',
          },
        ])
        .select();

      if (error) throw error;

      res.status(200).json({ success: true, data });
    } catch (err: any) {
      console.error('Error adding salon:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // API: دریافت تنظیمات بیزینس از دیتابیس
app.get('/api/businesses', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    }

    const { data, error } = await supabase
      .from('businesses')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    res.status(200).json({
      success: true,
      data: data || [],
    });
  } catch (err: any) {
    console.error('Error fetching businesses:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

  // API: ذخیره یا به‌روزرسانی تنظیمات بیزینس در دیتابیس
app.post('/api/businesses', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    }

    const { id, businessName, businessId, telegramToken, calendarId, systemPrompt } = req.body;
    const finalBusinessName = businessName || businessId;

    if (!finalBusinessName) {
      return res.status(400).json({ success: false, message: 'businessName is required.' });
    }

    const payload: any = {
      business_name: finalBusinessName,
      telegram_bot_token: telegramToken || '',
      google_calendar_id: calendarId || '',
      custom_system_prompt: systemPrompt || '',
    };

    let query;

    if (id) {
      query = supabase
        .from('businesses')
        .update(payload)
        .eq('id', id)
        .select();
    } else {
      query = supabase
        .from('businesses')
        .insert([payload])
        .select();
    }

    const { data, error } = await query;

    if (error) throw error;

    const savedBusiness = data?.[0];

    if (savedBusiness?.telegram_bot_token) {
      await startTelegramPolling(normalizeBusinessConfig(savedBusiness));
    }

    activeConfig = {
      ...activeConfig,
      telegramToken: payload.telegram_bot_token,
      googleCalendarId: payload.google_calendar_id,
      systemPrompt: payload.custom_system_prompt,
    };

    res.status(200).json({ success: true, data });
  } catch (err: any) {
    console.error('Error saving business config:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Static file serving for production
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
  app.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);

    // Auto-start polling for all business bot tokens saved in Supabase.
    // This is what makes the backend multi-business / multi-bot.
    startAllBusinessTelegramPollers().catch((err) => {
      console.error("Failed to start Telegram pollers:", err);
    });

    // Setup cron
    setupDailyReminders();
  });
}

startServer().catch(console.error);
