
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

  async getEvents(startDate: string, endDate: string) {
    try {
      const headers: any = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/events?startDate=${startDate}&endDate=${endDate}`, { headers });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return data.events || data.items || [];
    } catch(e) {
      return [];
    }
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

  async getEvents(startDate: string, endDate: string) {
    try {
      const timeMin = new Date(`${startDate}T00:00:00Z`).toISOString();
      const timeMax = new Date(`${endDate}T23:59:59Z`).toISOString();
      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return res.data.items || [];
    } catch(e: any) {
      console.error("Google Calendar getEvents Error:", e.message);
      return [];
    }
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
    const id = config.googleCalendarId || process.env.GOOGLE_CALENDAR_ID;
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
  instagramToken: activeConfig.instagramToken,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || activeConfig.whatsappAccessToken,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || activeConfig.whatsappPhoneNumberId,
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || activeConfig.whatsappBusinessAccountId,
  messengerPageId: process.env.MESSENGER_PAGE_ID || activeConfig.messengerPageId,
  messengerPageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN || activeConfig.messengerPageAccessToken,
  messengerVerifyToken: process.env.MESSENGER_VERIFY_TOKEN || activeConfig.messengerVerifyToken,
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_ID || activeConfig.adminTelegramChatId,
  systemPrompt: process.env.SYSTEM_PROMPT || activeConfig.systemPrompt,
  calendarProvider: activeConfig.calendarProvider || "google",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || activeConfig.googleCalendarId,
  googleClientEmail: process.env.GOOGLE_CLIENT_EMAIL || activeConfig.googleClientEmail,
  googlePrivateKey: process.env.GOOGLE_PRIVATE_KEY || activeConfig.googlePrivateKey,
};

const chatSessions: Record<string, any[]> = {};
const chatLanguages: Record<string, string> = {};
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
    instagramAccessToken: row.instagram_access_token,
    instagramToken: row.instagram_access_token,
    instagramAccountId: row.instagram_account_id,
    whatsappAccessToken: row.whatsapp_access_token,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappBusinessAccountId: row.whatsapp_business_account_id,
    whatsappEnabled: row.whatsapp_enabled,
    messengerPageId: row.messenger_page_id || row.facebook_page_id || row.page_id,
    messengerPageAccessToken: row.messenger_page_access_token || row.facebook_page_access_token || row.page_access_token,
    messengerVerifyToken: row.messenger_verify_token || row.facebook_verify_token,
    messengerEnabled: row.messenger_enabled,
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
  const telegramSessionId = `${telegramToken}:${chatId}`;
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
    if (!chatSessions[telegramSessionId]) chatSessions[telegramSessionId] = [];
    const history = chatSessions[telegramSessionId];
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
    
const businessName =
  config.businessName ||
  config.business_name ||
  activeConfig.businessName ||
  activeConfig.business_name ||
  'this business';

console.log(`Telegram AI config: business=${businessName}, hasSystemPrompt=${Boolean(config.systemPrompt)}`);

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
    let finalSystemInstruction =
  (config.systemPrompt || activeConfig.systemPrompt || "") +
  currentDateContext +
  constraint +
  languageEngine;
  if (voice) {
    finalSystemInstruction +=
    "\nVOICE ENGINE:\n" +
    "You support Swedish, English, Persian (Farsi), German, Spanish and Arabic.\n" +
    "Detect the spoken language automatically.\n" +
    "Reply using the exact same language.\n" +
    "If the user speaks Persian using Latin letters, reply in Persian script.\n" +
    "Your response must be suitable for natural TTS.\n" +
    "Keep responses under 60 words unless more detail is required.\n";
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
          const notifyToken = config?.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = config?.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
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
      
         const voiceCode = detectTtsVoiceCode(textResponse);

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
function detectTtsVoiceCode(text: string): string {
  const lower = (text || "").toLowerCase();

  // Persian
  if (/[\u0600-\u06FF]/.test(text)) {
    return "fa-IR-DilaraNeural";
  }

  // Arabic
  if (/[\u0600-\u06FF]/.test(text) &&
      /\b(مرحبا|السلام|شكرا|أهلا|موعد|حجز)\b/i.test(text)) {
    return "ar-SA-ZariyahNeural";
  }

  // German
  if (/\b(hallo|guten|danke|bitte|termin|möchte|buchen|tschüss)\b/i.test(lower)) {
    return "de-DE-KatjaNeural";
  }

  // Swedish default
  if (/\b(hej|tack|boka|tid|behandling|jag|är|har|vill)\b/i.test(lower)) {
    return "sv-SE-SofieNeural";
  }

  // Spanish
  if (/\b(hola|gracias|cita|quiero|reservar|tratamiento|adiós)\b/i.test(lower)) {
    return "es-ES-ElviraNeural";
  }

  // English
  if (/\b(hello|thanks|appointment|book|today|tomorrow|please)\b/i.test(lower)) {
    return "en-US-AriaNeural";
  }

  return "en-US-AriaNeural";
}
function detectUserLanguage(text: string): string {
  if (!text) return "en";

  const lower = text.toLowerCase();

  // Persian
  if (
    /[\u0600-\u06FF]/.test(text) ||
    /\b(salam|chetori|khubi|mamnoon|merci|lotfan|bebakhshid|mikham|mitoni)\b/i.test(lower)
  ) {
    return "fa";
  }

  // Swedish
  if (
    /[åäö]/i.test(text) ||
    /\b(hej|tack|ja|nej|bokning|boka|tid|kl|måndag|tisdag|onsdag|torsdag|fredag)\b/i.test(lower)
  ) {
    return "sv";
  }

  // German
  if (
    /\b(hallo|guten|danke|bitte|termin|uhr|morgen|nachmittag|ja|nein)\b/i.test(lower)
  ) {
    return "de";
  }

  // Spanish
  if (
    /[áéíóúñ¿¡]/i.test(text) ||
    /\b(hola|gracias|por favor|quiero|cita|mañana|sí)\b/i.test(lower)
  ) {
    return "es";
  }

  // Arabic
  if (
    /[\u0600-\u06FF]/.test(text) &&
    /\b(مرحبا|السلام|شكرا|موعد|اليوم|غدا)\b/u.test(text)
  ) {
    return "ar";
  }

  return "en";
}

function getErrorMessageByLanguage(language: string): string {
  switch (language) {
    case "fa":
      return "متأسفم، در حال حاضر یک مشکل فنی پیش آمده است. لطفاً چند دقیقه دیگر دوباره تلاش کنید.";
    case "de":
      return "Entschuldigung, es ist ein technisches Problem aufgetreten. Bitte versuchen Sie es in ein paar Minuten erneut.";
    case "sv":
      return "Ursäkta, jag stötte på ett tekniskt problem. Försök gärna igen om några minuter.";
    case "es":
      return "Lo siento, ha ocurrido un problema técnico. Por favor, inténtalo de nuevo en unos minutos.";
    case "ar":
      return "عذرًا، حدثت مشكلة تقنية. يرجى المحاولة مرة أخرى بعد بضع دقائق.";
    default:
      return "Sorry, a technical problem occurred. Please try again in a few minutes.";
  }
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



function cleanInstagramToken(token?: string | null) {
  if (!token) return "";

  let clean = String(token).trim();

  // Remove surrounding quotes/backticks and invisible copy/paste characters.
  clean = clean
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  // If someone pasted "Bearer TOKEN".
  clean = clean.replace(/^Bearer\s+/i, "").trim();

  // If someone pasted "INSTAGRAM_ACCESS_TOKEN=TOKEN" or "instagram_access_token: TOKEN".
  const assignmentMatch = clean.match(/(?:INSTAGRAM_ACCESS_TOKEN|INSTAGRAM_PAGE_ACCESS_TOKEN|instagram_access_token|access_token)\s*[:=]\s*["']?([^"'\s&]+)/i);
  if (assignmentMatch?.[1]) {
    clean = assignmentMatch[1].trim();
  }

  // If someone pasted a URL containing ?access_token=TOKEN.
  try {
    const decoded = decodeURIComponent(clean);
    const urlTokenMatch = decoded.match(/[?&]access_token=([^&\s"']+)/i);
    if (urlTokenMatch?.[1]) {
      clean = urlTokenMatch[1].trim();
    }
  } catch {
    // ignore decode errors
  }

  // If the value still contains spaces/new lines, keep the longest token-like part.
  const tokenLikeParts = clean.split(/\s+/).filter(Boolean);
  if (tokenLikeParts.length > 1) {
    clean = tokenLikeParts.sort((a, b) => b.length - a.length)[0];
  }

  // Remove trailing commas/semicolons accidentally copied from code/env files.
  clean = clean.replace(/[;,]+$/g, "").trim();

  if (!clean || clean === "undefined" || clean === "null") return "";

  // Meta access tokens are usually long and should not contain whitespace.
  if (/\s/.test(clean)) return "";

  return clean;
}

function getBusinessInstagramToken(businessConfig: any) {
  // IMPORTANT: Instagram must use the token stored for the matched business.
  // Do not fall back to ENV Instagram tokens here, because that can send with
  // the wrong account or a broken token in multi-business mode.
  return cleanInstagramToken(
    businessConfig?.instagramAccessToken ||
    businessConfig?.instagram_access_token ||
    businessConfig?.instagramToken
  );
}

async function sendInstagramMessage(recipientId: string, text: string, accessToken?: string) {
  const token = cleanInstagramToken(accessToken);

  if (!token) {
    console.error('Instagram reply skipped: missing business instagram_access_token');
    return false;
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text }
  };

  try {
    const endpoint = 'https://graph.instagram.com/v25.0/me/messages';
    const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log('Instagram reply sent:', JSON.stringify(result));
      return true;
    }

    console.error('Instagram send failed:', JSON.stringify(result));
    return false;
  } catch (err) {
    console.error('Instagram send error:', err);
    return false;
  }
}

function getPublicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    'https://laserluxury.onrender.com'
  ).replace(/\/$/, '');
}

async function createInstagramVoiceReplyFile(text: string) {
  const EdgeTTS = (await import('node-edge-tts')).EdgeTTS;
  const voiceCode = detectTtsVoiceCode(text);
  const audioDir = '/tmp/clinicpilot_ig_audio';
  fs.mkdirSync(audioDir, { recursive: true });

  const filename = `ig_reply_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  const filePath = path.join(audioDir, filename);
  const cleanText = sanitizeTTS(text);

  const tts = new EdgeTTS({ voice: voiceCode, rate: '-10%', timeout: 60000 });
  await tts.ttsPromise(cleanText || 'Förlåt, jag förstod inte.', filePath);

  // Best-effort cleanup of old generated audio files.
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(audioDir)) {
      const fullPath = path.join(audioDir, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (cleanupErr) {
    console.warn('Instagram audio cleanup failed:', cleanupErr);
  }

  return {
    filePath,
    url: `${getPublicBaseUrl()}/media/instagram/${filename}`,
  };
}
async function downloadInstagramAudio(audioUrl: string, accessToken?: string) {
  const attempts: Array<{ label: string; url: string; init?: RequestInit }> = [
    { label: 'raw', url: audioUrl },
  ];

  if (accessToken) {
    attempts.push({
      label: 'bearer',
      url: audioUrl,
      init: { headers: { Authorization: `Bearer ${accessToken}` } }
    });

    const separator = audioUrl.includes('?') ? '&' : '?';
    attempts.push({
      label: 'query-token',
      url: `${audioUrl}${separator}access_token=${encodeURIComponent(accessToken)}`
    });
  }

  let lastError = '';

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, attempt.init);
      if (response.ok) {
        console.log(`Instagram audio downloaded using ${attempt.label} fetch.`);
        return response;
      }

      lastError = `${response.status} ${response.statusText}`;
      console.warn(`Instagram audio download attempt ${attempt.label} failed: ${lastError}`);
    } catch (err: any) {
      lastError = String(err?.message || err);
      console.warn(`Instagram audio download attempt ${attempt.label} crashed:`, err);
    }
  }

  throw new Error(`Failed to download Instagram audio after retries: ${lastError}`);
}


async function sendInstagramAudioMessage(recipientId: string, audioUrl: string, accessToken?: string) {
  const token = cleanInstagramToken(accessToken);
  if (!token) {
    console.error('Instagram audio reply skipped: missing business instagram_access_token');
    return false;
  }

  const payload = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'audio',
        payload: {
          url: audioUrl,
          is_reusable: true
        }
      }
    }
  };

  try {
    const endpoint = 'https://graph.instagram.com/v25.0/me/messages';
    const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log('Instagram audio reply sent:', JSON.stringify(result));
      return true;
    }

    console.error('Instagram audio send failed:', JSON.stringify(result));
    return false;
  } catch (err) {
    console.error('Instagram audio send error:', err);
    return false;
  }
}

function cleanMetaToken(token?: string | null) {
  if (!token) return "";

  let clean = String(token).trim();

  clean = clean
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  clean = clean.replace(/^Bearer\s+/i, "").trim();

  const assignmentMatch = clean.match(/(?:WHATSAPP_ACCESS_TOKEN|INSTAGRAM_ACCESS_TOKEN|INSTAGRAM_PAGE_ACCESS_TOKEN|whatsapp_access_token|instagram_access_token|access_token)\s*[:=]\s*["']?([^"'\s&]+)/i);
  if (assignmentMatch?.[1]) {
    clean = assignmentMatch[1].trim();
  }

  try {
    const decoded = decodeURIComponent(clean);
    const urlTokenMatch = decoded.match(/[?&]access_token=([^&\s"']+)/i);
    if (urlTokenMatch?.[1]) {
      clean = urlTokenMatch[1].trim();
    }
  } catch {
    // ignore decode errors
  }

  const tokenLikeParts = clean.split(/\s+/).filter(Boolean);
  if (tokenLikeParts.length > 1) {
    clean = tokenLikeParts.sort((a, b) => b.length - a.length)[0];
  }

  clean = clean.replace(/[;,]+$/g, "").trim();

  if (!clean || clean === "undefined" || clean === "null") return "";
  if (/\s/.test(clean)) return "";

  return clean;
}

function getBusinessWhatsAppToken(businessConfig: any) {
  return cleanMetaToken(
    businessConfig?.whatsappAccessToken ||
    businessConfig?.whatsapp_access_token ||
    process.env.WHATSAPP_ACCESS_TOKEN
  );
}

function getBusinessWhatsAppPhoneNumberId(businessConfig: any) {
  return String(
    businessConfig?.whatsappPhoneNumberId ||
    businessConfig?.whatsapp_phone_number_id ||
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    ""
  ).trim();
}

async function sendWhatsAppMessage(to: string, text: string, businessConfig: any) {
  const token = getBusinessWhatsAppToken(businessConfig);
  const phoneNumberId = getBusinessWhatsAppPhoneNumberId(businessConfig);

  if (!token || !phoneNumberId) {
    console.error("WhatsApp reply skipped: missing whatsapp_access_token or whatsapp_phone_number_id");
    return false;
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: text
    }
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log("WhatsApp reply sent:", JSON.stringify(result));
      return true;
    }

    console.error("WhatsApp send failed:", JSON.stringify(result));
    return false;
  } catch (err) {
    console.error("WhatsApp send error:", err);
    return false;
  }
}

async function processWhatsAppMessage(message: any, metadata: any, config: any, platform: string = "whatsapp-webhook") {
  const from = message?.from;
  const textMessage = message?.text?.body || "";
  const phoneNumberId = metadata?.phone_number_id || "";

  if (!from || !phoneNumberId || !textMessage) {
    console.log("WhatsApp webhook ignored: no supported text message payload.");
    return;
  }

  console.log("==============================");
  console.log("REAL WHATSAPP TEXT MESSAGE");
  console.log("From:", from);
  console.log("Phone Number ID:", phoneNumberId);
  console.log("Message:", textMessage);
  console.log("==============================");

  const chatId = `wa_${from}`;
  const userLanguage = detectUserLanguage(textMessage || "");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };

  try {
    if (supabase) {
      const { data, error } = await supabase
        .from("businesses")
        .select("*")
        .eq("whatsapp_phone_number_id", phoneNumberId)
        .maybeSingle();

      if (error) {
        console.error("WhatsApp business lookup error:", JSON.stringify(error));
      }

      if (data) {
        businessConfig = {
          ...businessConfig,
          businessRecordId: data.id,
          businessName: data.business_name,
          business_name: data.business_name,
          systemPrompt: data.custom_system_prompt,
          googleCalendarId: data.google_calendar_id,
          telegramToken: data.telegram_bot_token,
          whatsappAccessToken: cleanMetaToken(data.whatsapp_access_token),
          whatsappPhoneNumberId: data.whatsapp_phone_number_id,
          whatsappBusinessAccountId: data.whatsapp_business_account_id,
          whatsappEnabled: data.whatsapp_enabled,
          calendarProvider: "google"
        };
        console.log(`WhatsApp business matched: ${data.business_name} (${data.id})`);
      } else {
        console.error("No business found for WhatsApp phone_number_id:", phoneNumberId);
      }
    }
  } catch (tenantErr) {
    console.error("WhatsApp tenant config injection failed:", tenantErr);
  }

  try {
    if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
    const history = chatSessions[chatId as any];

    const messages = [...history];
    messages.push({ role: "user", content: textMessage });

    const businessName = businessConfig.businessName || businessConfig.business_name || "this business";

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

    const swedenDate = new Date().toLocaleDateString("en-US", {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;

    let finalSystemInstruction = (businessConfig.systemPrompt || "") + currentDateContext + constraint + languageEngine;

    let chatResponse = await generateContentWithFallback(null, {
      messages,
      systemInstruction: finalSystemInstruction,
      tools: calendarTools,
      model: "gemini-2.5-flash"
    });

    let maxTurns = 3;
    while (chatResponse.functionCalls && chatResponse.functionCalls.length > 0 && maxTurns > 0) {
      maxTurns--;
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === "checkSlots" && args) {
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes);
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split("\n")
              .filter((s: string) => s.trim().length > 0 && !s.includes("No available slots"));

            const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime);
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);

          const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;

          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
            try {
              const notifyText = `🔔 Ny WhatsApp-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
              await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
              });
            } catch (e) {
              console.error("Admin notify error:", e);
            }
          }
        } else if (call.function.name === "logSystemAnalysis" && args) {
          adapterRes = await handleSystemAnalysisLog(chatId, args);
        } else {
          adapterRes = { error: "Unknown tool" };
        }

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
        model: "gemini-2.5-flash"
      });
    }

    if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
      chatResponse = await generateContentWithFallback(null, {
        messages,
        systemInstruction: finalSystemInstruction + "\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
        model: "gemini-2.5-flash"
      });
    }

    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: "user", content: textMessage });
    history.push({ role: "assistant", content: textResponse });

    await sendWhatsAppMessage(from, textResponse, businessConfig);

    try {
      await postProcessMessage(chatId, platform, textMessage, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey);
    } catch (e) {
      console.error("WhatsApp postProcessMessage failed:", e);
    }
  } catch (err: any) {
    console.error("WhatsApp processing error:", err);
    const errorMessage = getErrorMessageByLanguage(userLanguage || "en");
    await sendWhatsAppMessage(from, errorMessage, businessConfig);
  }
}


function getBusinessMessengerToken(businessConfig: any) {
  return cleanMetaToken(
    businessConfig?.messengerPageAccessToken ||
    businessConfig?.messenger_page_access_token ||
    businessConfig?.facebook_page_access_token ||
    businessConfig?.page_access_token ||
    process.env.MESSENGER_PAGE_ACCESS_TOKEN
  );
}

function getBusinessMessengerPageId(businessConfig: any) {
  return String(
    businessConfig?.messengerPageId ||
    businessConfig?.messenger_page_id ||
    businessConfig?.facebook_page_id ||
    businessConfig?.page_id ||
    process.env.MESSENGER_PAGE_ID ||
    ""
  ).trim();
}

async function sendMessengerMessage(recipientId: string, text: string, businessConfig: any) {
  const token = getBusinessMessengerToken(businessConfig);

  if (!token) {
    console.error("Messenger reply skipped: missing messenger_page_access_token / page access token");
    return false;
  }

  const payload = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text }
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log("Messenger reply sent:", JSON.stringify(result));
      return true;
    }

    console.error("Messenger send failed:", JSON.stringify(result));
    return false;
  } catch (err) {
    console.error("Messenger send error:", err);
    return false;
  }
}


async function downloadMessengerAudio(audioUrl: string, accessToken?: string) {
  const attempts: Array<{ label: string; url: string; init?: RequestInit }> = [
    { label: "raw", url: audioUrl }
  ];

  if (accessToken) {
    attempts.push({
      label: "bearer",
      url: audioUrl,
      init: { headers: { Authorization: `Bearer ${accessToken}` } }
    });

    const separator = audioUrl.includes("?") ? "&" : "?";
    attempts.push({
      label: "query-token",
      url: `${audioUrl}${separator}access_token=${encodeURIComponent(accessToken)}`
    });
  }

  let lastError = "";

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, attempt.init);
      if (response.ok) {
        console.log(`Messenger audio downloaded using ${attempt.label} fetch.`);
        return response;
      }

      lastError = `${response.status} ${response.statusText}`;
      console.warn(`Messenger audio download attempt ${attempt.label} failed: ${lastError}`);
    } catch (err: any) {
      lastError = String(err?.message || err);
      console.warn(`Messenger audio download attempt ${attempt.label} crashed:`, err);
    }
  }

  throw new Error(`Failed to download Messenger audio after retries: ${lastError}`);
}


function getMessengerPublicBaseUrl() {
  // Messenger/Facebook must be able to fetch the generated audio file from the internet.
  // On Render, RENDER_EXTERNAL_URL is usually the safest value. If you set
  // MESSENGER_PUBLIC_BASE_URL manually, it will override everything.
  return (
    process.env.MESSENGER_PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    'https://laserluxury.onrender.com'
  ).replace(/\/$/, '');
}

async function debugPublicAudioUrl(audioUrl: string) {
  try {
    const response = await fetch(audioUrl, { method: 'GET' });
    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    console.log(`Messenger public audio self-check: status=${response.status}, content-type=${contentType}, content-length=${contentLength}, url=${audioUrl}`);
    return response.ok;
  } catch (err) {
    console.error('Messenger public audio self-check failed:', err, 'url=', audioUrl);
    return false;
  }
}

async function createMessengerVoiceReplyFile(text: string) {
  const EdgeTTS = (await import("node-edge-tts")).EdgeTTS;
  const voiceCode = detectTtsVoiceCode(text);
  const audioDir = "/tmp/clinicpilot_messenger_audio";
  fs.mkdirSync(audioDir, { recursive: true });

  const filename = `messenger_reply_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  const filePath = path.join(audioDir, filename);
  const cleanText = sanitizeTTS(text);

  const tts = new EdgeTTS({ voice: voiceCode, rate: "-10%", timeout: 60000 });
  await tts.ttsPromise(cleanText || "Förlåt, jag förstod inte.", filePath);

  try {
    const now = Date.now();
    for (const file of fs.readdirSync(audioDir)) {
      const fullPath = path.join(audioDir, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch (cleanupErr) {
    console.warn("Messenger audio cleanup failed:", cleanupErr);
  }

  return {
    filePath,
    url: `${getMessengerPublicBaseUrl()}/media/messenger/${filename}`
  };
}

async function sendMessengerAudioMessage(recipientId: string, audioUrl: string, businessConfig: any) {
  const token = getBusinessMessengerToken(businessConfig);

  if (!token) {
    console.error("Messenger audio reply skipped: missing messenger_page_access_token / page access token");
    return false;
  }

  console.log("Messenger audio reply public URL:", audioUrl);
  await debugPublicAudioUrl(audioUrl);

  const buildPayload = (attachmentType: "audio" | "file") => ({
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: attachmentType,
        payload: {
          url: audioUrl,
          is_reusable: true
        }
      }
    }
  });

  async function sendAttachmentPayload(attachmentType: "audio" | "file") {
    const response = await fetch(`https://graph.facebook.com/v25.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(attachmentType))
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log(`Messenger ${attachmentType} reply sent:`, JSON.stringify(result));
      return true;
    }

    console.error(`Messenger ${attachmentType} send failed:`, JSON.stringify(result));
    return false;
  }

  try {
    // First try proper Messenger audio attachment.
    const audioSent = await sendAttachmentPayload("audio");
    if (audioSent) return true;

    // Some Messenger accounts reject audio upload from generated URLs.
    // Try file attachment as a fallback; Messenger can still deliver/play it in many clients.
    console.log("Messenger audio failed, trying file attachment fallback...");
    const fileSent = await sendAttachmentPayload("file");
    if (fileSent) return true;

    return false;
  } catch (err) {
    console.error("Messenger audio send error:", err);
    return false;
  }
}

async function findMessengerBusinessByPageId(pageId: string) {
  if (!supabase || !pageId) return null;

  try {
    // We select all rows and match in JS so this works even if your column name is
    // messenger_page_id, facebook_page_id, or page_id.
    const { data, error } = await supabase.from("businesses").select("*");

    if (error) {
      console.error("Messenger business lookup error:", JSON.stringify(error));
      return null;
    }

    return (data || []).find((row: any) => {
      const candidates = [
        row.messenger_page_id,
        row.facebook_page_id,
        row.page_id,
        row.instagram_page_id
      ].filter(Boolean).map((value: any) => String(value).trim());

      return candidates.includes(String(pageId).trim());
    }) || null;
  } catch (err) {
    console.error("Messenger business lookup crashed:", err);
    return null;
  }
}



const processedMetaCommentIds = new Set<string>();

function looksLikeNegativeComment(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return /\b(bad|terrible|awful|worst|angry|scam|fake|rude|unprofessional|besviken|dålig|sämst|arg|missnöjd|bedrägeri|kasst|uselt|خوب نبود|بد بود|افتضاح|کلاهبرداری|ناراضی)\b/i.test(lower);
}

async function findMetaCommentBusiness(ownerId: string) {
  if (!supabase || !ownerId) return null;

  try {
    const { data, error } = await supabase.from("businesses").select("*");
    if (error) {
      console.error("Meta comment business lookup error:", JSON.stringify(error));
      return null;
    }

    return (data || []).find((row: any) => {
      const candidates = [
        row.instagram_account_id,
        row.instagram_page_id,
        row.messenger_page_id,
        row.facebook_page_id,
        row.page_id
      ].filter(Boolean).map((value: any) => String(value).trim());

      return candidates.includes(String(ownerId).trim());
    }) || null;
  } catch (err) {
    console.error("Meta comment business lookup crashed:", err);
    return null;
  }
}

function normalizeMetaCommentBusinessConfig(row: any, fallbackConfig: any = {}) {
  return {
    ...activeConfig,
    ...fallbackConfig,
    businessRecordId: row.id,
    businessName: row.business_name,
    business_name: row.business_name,
    systemPrompt: row.custom_system_prompt,
    googleCalendarId: row.google_calendar_id,
    telegramToken: row.telegram_bot_token,
    instagramAccessToken: row.instagram_access_token,
    instagramToken: row.instagram_access_token,
    instagramAccountId: row.instagram_account_id,
    instagramPageId: row.instagram_page_id,
    messengerPageId: row.messenger_page_id || row.facebook_page_id || row.page_id,
    messengerPageAccessToken: cleanMetaToken(
      row.messenger_page_access_token ||
      row.facebook_page_access_token ||
      row.page_access_token ||
      row.instagram_access_token
    ),
    calendarProvider: "google"
  };
}

function getCommentAccessToken(source: "instagram" | "facebook", businessConfig: any) {
  if (source === "instagram") {
    return getBusinessInstagramToken(businessConfig);
  }
  return getBusinessMessengerToken(businessConfig);
}

async function sendMetaCommentReply(commentId: string, text: string, token: string, source: "instagram" | "facebook") {
  const cleanToken = cleanMetaToken(token);
  if (!commentId || !cleanToken || !text) {
    console.error("Comment reply skipped: missing commentId/token/text");
    return false;
  }

  try {
    const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(commentId)}/replies`;
    const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(cleanToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });

    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`${source} comment reply sent:`, JSON.stringify(result));
      return true;
    }

    console.error(`${source} comment reply failed:`, JSON.stringify(result));
    return false;
  } catch (err) {
    console.error(`${source} comment reply error:`, err);
    return false;
  }
}

async function notifyAdminAboutComment(businessConfig: any, payload: { source: string; businessName: string; username?: string; commentText: string; replyText: string; commentId: string; negative: boolean }) {
  const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
  const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
  if (!notifyToken || !notifyAdmin) return;

  try {
    const label = payload.negative ? "⚠️ Negative comment detected" : "💬 Comment replied";
    const text = `${label}\n🏢 Business: ${payload.businessName}\n📍 Source: ${payload.source}\n👤 User: ${payload.username || "unknown"}\n💬 Comment: ${payload.commentText}\n🤖 Reply: ${payload.replyText}\n🆔 Comment ID: ${payload.commentId}`;
    await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: notifyAdmin, text })
    });
  } catch (err) {
    console.error("Comment admin notify error:", err);
  }
}

async function processMetaCommentUpdate(entry: any, change: any, config: any, source: "instagram" | "facebook" = "instagram") {
  const value = change?.value || {};
  const commentId = value.comment_id || value.id;
  const text = value.text || value.message || "";
  const from = value.from || {};
  const username = from.username || from.name || from.id || "";
  const ownerId = String(entry?.id || value?.owner_id || value?.page_id || "").trim();

  if (!commentId || !text || !ownerId) {
    console.log("Meta comment ignored: missing commentId/text/ownerId.");
    return;
  }

  const dedupeKey = `${source}:${commentId}`;
  if (processedMetaCommentIds.has(dedupeKey)) return;
  processedMetaCommentIds.add(dedupeKey);
  if (processedMetaCommentIds.size > 5000) {
    const first = processedMetaCommentIds.values().next().value;
    if (first !== undefined) processedMetaCommentIds.delete(first);
  }

  console.log("==============================");
  console.log(source === "instagram" ? "REAL INSTAGRAM COMMENT" : "REAL FACEBOOK COMMENT");
  console.log("Owner/Page ID:", ownerId);
  console.log("Comment ID:", commentId);
  console.log("User:", username);
  console.log("Comment:", text);
  console.log("==============================");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };

  try {
    const business = await findMetaCommentBusiness(ownerId);
    if (business) {
      businessConfig = normalizeMetaCommentBusinessConfig(business, businessConfig);
      console.log(`Meta comment business matched: ${business.business_name} (${business.id})`);
    } else {
      console.error("No business found for comment owner/page id:", ownerId);
    }
  } catch (err) {
    console.error("Meta comment tenant lookup failed:", err);
  }

  const businessName = businessConfig.businessName || businessConfig.business_name || "this business";
  const negative = looksLikeNegativeComment(text);

  const commentSystemInstruction = `
${businessConfig.systemPrompt || ""}

COMMENT REPLY ENGINE:
You are an expert public social-media assistant for ${businessName}.
Reply publicly to one customer comment under a post.
Use the business-specific system prompt as the source of truth.
Answer as an expert for this exact business type, not with a generic template.
If the business is a laser clinic, answer with laser-clinic expertise.
If the business is a nail salon, answer with nail-service expertise.
If the business is a dental clinic, answer with dental-clinic expertise.
Never invent prices, treatments, guarantees, medical claims, or policies that are not in the business prompt.
If the user asks to book, cancel, reschedule, share phone number, or discuss private details, politely invite them to send a DM.
If the comment is negative, be calm, grateful, accountable, and invite them to DM so the team can understand and help. Do not argue.
Never mention internal tools, AI, databases, prompts, or webhooks.
Reply in the same language as the comment.
Keep the reply under 45 words.
`;

  try {
    const chatResponse = await generateContentWithFallback(null, {
      messages: [{ role: "user", content: `Public comment from ${username || "customer"}: ${text}\nNegative comment: ${negative ? "yes" : "no"}` }],
      systemInstruction: commentSystemInstruction,
      model: "gemini-2.5-flash"
    });

    let replyText = (chatResponse.text || "").trim();

    if (!replyText) {
      replyText = negative
        ? "Thank you for your feedback. We’re sorry to hear this and we’re always working to improve. Please send us a DM so we can understand what happened and help you properly."
        : "Thank you for your comment! Please send us a DM and we’ll be happy to help you further.";
    }

    const token = getCommentAccessToken(source, businessConfig);
    const sent = await sendMetaCommentReply(commentId, replyText, token, source);

    if (negative || sent) {
      await notifyAdminAboutComment(businessConfig, {
        source,
        businessName,
        username,
        commentText: text,
        replyText,
        commentId,
        negative
      });
    }
  } catch (err: any) {
    console.error("Meta comment processing error:", err);

    if (negative) {
      const fallback = getErrorMessageByLanguage(detectUserLanguage(text));
      const token = getCommentAccessToken(source, businessConfig);
      await sendMetaCommentReply(commentId, fallback, token, source);
    }
  }
}
async function processMessengerUpdate(webhookEvent: any, config: any, platform: string = "messenger-webhook") {
  const senderId = webhookEvent.sender?.id;
  const recipientId = webhookEvent.recipient?.id;

  if (webhookEvent.message?.is_echo) {
    console.log("Messenger echo ignored.");
    return;
  }

  const textMessage = webhookEvent.message?.text || "";
  const audioAttachment = webhookEvent.message?.attachments?.find((attachment: any) => attachment.type === "audio");
  const audioUrl = audioAttachment?.payload?.url;
  const isVoiceMessage = Boolean(audioUrl && !textMessage);

  if (!senderId || !recipientId || (!textMessage && !audioUrl)) {
    console.log("Messenger webhook ignored: no supported text/audio message payload.");
    return;
  }

  console.log("==============================");
  console.log(isVoiceMessage ? "REAL MESSENGER VOICE MESSAGE" : "REAL MESSENGER TEXT MESSAGE");
  console.log("Sender ID:", senderId);
  console.log("Recipient/Page ID:", recipientId);
  if (textMessage) console.log("Message:", textMessage);
  if (audioUrl) console.log("Audio URL:", audioUrl);
  console.log("==============================");

  const chatId = `ms_${senderId}`;
  const userLanguage = detectUserLanguage(textMessage || "");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };

  try {
    const data = await findMessengerBusinessByPageId(recipientId);

    if (data) {
      businessConfig = {
        ...businessConfig,
        businessRecordId: data.id,
        businessName: data.business_name,
        business_name: data.business_name,
        systemPrompt: data.custom_system_prompt,
        googleCalendarId: data.google_calendar_id,
        telegramToken: data.telegram_bot_token,
        messengerPageId: data.messenger_page_id || data.facebook_page_id || data.page_id || data.instagram_page_id,
        messengerPageAccessToken: cleanMetaToken(
          data.messenger_page_access_token ||
          data.facebook_page_access_token ||
          data.page_access_token ||
          data.instagram_access_token
        ),
        messengerEnabled: data.messenger_enabled,
        calendarProvider: "google"
      };
      console.log(`Messenger business matched: ${data.business_name} (${data.id})`);
    } else {
      console.error("No business found for Messenger recipient/page id:", recipientId);
    }
  } catch (tenantErr) {
    console.error("Messenger tenant config injection failed:", tenantErr);
  }

  try {
    if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
    const history = chatSessions[chatId as any];

    let userMessageContent: any = textMessage;
    let userMessageForLog = textMessage;

    if (isVoiceMessage && audioUrl) {
      const messengerToken = getBusinessMessengerToken(businessConfig);
      const audioRes = await downloadMessengerAudio(audioUrl, messengerToken);
      const audioBuffer = await audioRes.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");
      const contentType = audioRes.headers.get("content-type") || "audio/ogg";
      const mimeType = contentType.includes(";") ? contentType.split(";")[0].trim() : contentType;

      console.log(`Messenger voice downloaded. MIME=${mimeType}, bytes=${audioBuffer.byteLength}`);

      userMessageContent = [
        { text: "Voice message input from Messenger:" },
        { inlineData: { data: base64Audio, mimeType } }
      ];
      userMessageForLog = "[Messenger Voice Message]";
    }

    const messages = [...history];
    messages.push({ role: "user", content: userMessageContent });

    const businessName = businessConfig.businessName || businessConfig.business_name || "this business";

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

    const swedenDate = new Date().toLocaleDateString("en-US", {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;

    let finalSystemInstruction = (businessConfig.systemPrompt || "") + currentDateContext + constraint + languageEngine;

    if (isVoiceMessage) {
      finalSystemInstruction +=
        "\nVOICE ENGINE:\n" +
        "You support Swedish, English, Persian (Farsi), German, Spanish and Arabic.\n" +
        "Detect the spoken language automatically.\n" +
        "Reply using the exact same language.\n" +
        "If the user speaks Persian using Latin letters, reply in Persian script.\n" +
        "Your response must be suitable for natural TTS.\n" +
        "Keep responses under 60 words unless more detail is required.\n";
    }

    let chatResponse = await generateContentWithFallback(null, {
      messages,
      systemInstruction: finalSystemInstruction,
      tools: calendarTools,
      model: "gemini-2.5-flash"
    });

    let maxTurns = 3;
    while (chatResponse.functionCalls && chatResponse.functionCalls.length > 0 && maxTurns > 0) {
      maxTurns--;
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === "checkSlots" && args) {
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes);
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split("\n")
              .filter((s: string) => s.trim().length > 0 && !s.includes("No available slots"));

            const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime);
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);

          const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;

          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
            try {
              const notifyText = `🔔 Ny Messenger-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
              await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
              });
            } catch (e) {
              console.error("Messenger admin notify error:", e);
            }
          }
        } else if (call.function.name === "logSystemAnalysis" && args) {
          adapterRes = await handleSystemAnalysisLog(chatId, args);
        } else {
          adapterRes = { error: "Unknown tool" };
        }

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
        model: "gemini-2.5-flash"
      });
    }

    if (chatResponse.functionCalls && chatResponse.functionCalls.length > 0) {
      chatResponse = await generateContentWithFallback(null, {
        messages,
        systemInstruction: finalSystemInstruction + "\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.",
        model: "gemini-2.5-flash"
      });
    }

    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: "user", content: isVoiceMessage ? "[Messenger Voice Message]" : userMessageContent });
    history.push({ role: "assistant", content: textResponse });

    if (isVoiceMessage) {
      let sentVoiceReply = false;

      try {
        const voiceReply = await createMessengerVoiceReplyFile(textResponse);
        sentVoiceReply = await sendMessengerAudioMessage(senderId, voiceReply.url, businessConfig);
      } catch (ttsErr) {
        console.error("Messenger TTS/audio reply failed:", ttsErr);
      }

      if (!sentVoiceReply) {
        await sendMessengerMessage(senderId, textResponse, businessConfig);
      }
    } else {
      await sendMessengerMessage(senderId, textResponse, businessConfig);
    }

    try {
      await postProcessMessage(chatId, platform, userMessageForLog, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey);
    } catch (e) {
      console.error("Messenger postProcessMessage failed:", e);
    }
  } catch (err: any) {
    console.error("Messenger processing error:", err);
    const errorMessage = getErrorMessageByLanguage(userLanguage || "en");
    await sendMessengerMessage(senderId, errorMessage, businessConfig);
  }
}

const languageEngine = `
LANGUAGE ENGINE:
Always identify the customer's language from their latest message.
Reply in the same language as the customer’s latest message.

Supported languages:
- Swedish
- English
- Persian/Farsi
- Spanish
- German
- Arabic

Persian/Farsi rule:
If the customer writes Persian/Farsi with Latin letters, reply in Persian using Persian script.

Arabic rule:
If the customer writes Arabic, reply in Arabic script.

Mixed language rule:
If the customer mixes languages, choose the language that carries the main request. If the user explicitly asks for a language, use that language.

Never say "I can only speak Swedish" or "I only communicate in Swedish".
Never refuse a supported language.
Keep the same warm,friendly,human tone, professional receptionist tone in every language.
`;

async function processInstagramUpdate(webhook_event: any, config: any, platform: string = "instagram-webhook") {
  const senderId = webhook_event.sender?.id;
  const recipientId = webhook_event.recipient?.id;
  if (webhook_event.message?.is_echo) {
  console.log('Instagram echo ignored.');
  return;
}

  const textMessage = webhook_event.message?.text || '';
  const audioAttachment = webhook_event.message?.attachments?.find((attachment: any) => attachment.type === 'audio');
  const audioUrl = audioAttachment?.payload?.url;

  if (!senderId || !recipientId || (!textMessage && !audioUrl)) return;

  console.log('==============================');
  console.log(audioUrl ? 'REAL INSTAGRAM VOICE DM' : 'REAL INSTAGRAM TEXT DM');
  console.log('Sender ID:', senderId);
  console.log('Recipient ID:', recipientId);
  if (textMessage) console.log('Message:', textMessage);
  if (audioUrl) console.log('Audio URL:', audioUrl);
  console.log('==============================');

  const chatId = `ig_${senderId}`;
  let userLanguage = detectUserLanguage(textMessage || "");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };
  let businessRecord: any = null;

  try {
    if (supabase) {
      const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .eq('instagram_account_id', recipientId)
        .maybeSingle();

      if (error) {
        console.error('Instagram business lookup error:', JSON.stringify(error));
      }

      if (data) {
        businessRecord = data;
        businessConfig = {
          ...businessConfig,
          businessRecordId: data.id,
          businessName: data.business_name,
          business_name: data.business_name,
          systemPrompt: data.custom_system_prompt,
          googleCalendarId: data.google_calendar_id,
          instagramAccessToken: cleanInstagramToken(data.instagram_access_token),
          instagramToken: cleanInstagramToken(data.instagram_access_token),
          instagramAccountId: data.instagram_account_id,
          calendarProvider: 'google'
        };
        console.log(`Instagram business matched: ${data.business_name} (${data.id})`);
      } else {
        console.error('No business found for Instagram recipient id:', recipientId);
      }
    }
  } catch (tenantErr) {
    console.error('Instagram tenant config injection failed:', tenantErr);
  }

  try {
    if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
    const history = chatSessions[chatId as any];

    let userMessageContent: any = textMessage;
    let userMessageForLog = textMessage || '[Instagram Voice Message]';
    let isVoiceMessage = false;

    if (!textMessage && audioUrl) {
      isVoiceMessage = true;

      try {
        const instagramTokenForAudio = getBusinessInstagramToken(businessConfig);

        const audioResponse = await downloadInstagramAudio(audioUrl, instagramTokenForAudio);
        const audioBuffer = await audioResponse.arrayBuffer();
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
      let contentType =
  audioResponse.headers.get("content-type") || "audio/mpeg";

if (contentType === "video/mp4") {
  console.log(
    "Instagram returned video/mp4 for voice. Treating as audio/mp4."
  );
  contentType = "audio/mp4";
}
        console.log(`Instagram voice downloaded. MIME=${contentType}, bytes=${audioBuffer.byteLength}`);
        userMessageContent = [
  { text: "Instagram voice message input. Detect the spoken language from the audio and reply in the exact same language. Do not default to Swedish." },
  {
    inlineData: {
      data: base64Audio,
      mimeType: contentType,
    }
  }
];
      } catch (voiceErr) {
        console.error('Instagram voice download failed:', voiceErr);
        await sendInstagramMessage(
          senderId,
          'Ursäkta, jag kunde inte lyssna på röstmeddelandet just nu. Kan du skriva ditt meddelande istället?',
         getBusinessInstagramToken(businessConfig)
        );
        return;
      }
    }

    const messages = [...history];
    messages.push({ role: 'user', content: userMessageContent });

    const businessName = businessConfig.businessName || businessConfig.business_name || 'this business';

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

    let finalSystemInstruction = (businessConfig.systemPrompt || '') + currentDateContext + constraint + languageEngine;

    if (isVoiceMessage) {
      finalSystemInstruction +=
        "\nVoice specific instructions: The user sent an Instagram voice message. Detect the spoken language and reply in the exact same language. Keep the response natural, short, and suitable for voice playback.";
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
      messages.push({ role: 'assistant', content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === 'checkSlots' && args) {
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes);
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split('\n')
              .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));

            const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime);
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === 'insertAppointment' && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;

          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
            try {
              const notifyText = `🔔 Ny Instagram-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${args.name}\n📞 Mobil: ${args.phone}\n📅 Tid: ${args.dateTime}`;
              await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
              });
            } catch (e) {
              console.error('Admin notify error:', e);
            }
          }
        } else if (call.function.name === 'logSystemAnalysis' && args) {
          adapterRes = await handleSystemAnalysisLog(chatId, args);
        } else {
          adapterRes = { error: 'Unknown tool' };
        }

        return {
          role: 'tool',
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
        systemInstruction: finalSystemInstruction + '\nCRITICAL: Maximum tool calls reached. You MUST reply in natural language only. Summarize what you know. DO NOT USE TOOLS.',
        model: 'gemini-2.5-flash'
      });
    }

    const textResponse = chatResponse.text || "I'm having trouble processing that right now.";

    history.push({ role: 'user', content: isVoiceMessage ? '[Instagram Voice Message]' : userMessageContent });
    history.push({ role: 'assistant', content: textResponse });

    const instagramToken = getBusinessInstagramToken(businessConfig);
    console.log('Instagram token selected for business:', maskToken(instagramToken));

    if (!instagramToken) {
      console.error('Instagram reply skipped: no valid business instagram_access_token for matched business.');
      return;
    }

if (isVoiceMessage) {
  let sentVoiceReply = false;

  try {
    const voiceReply = await createInstagramVoiceReplyFile(textResponse);

    await sendInstagramMessage(
      senderId,
      `${textResponse}\n\n🎧 Lyssna här: ${voiceReply.url}`,
      instagramToken
    );

    sentVoiceReply = true;
  } catch (ttsErr) {
    console.error('Instagram TTS/audio reply failed:', ttsErr);
  }

  if (!sentVoiceReply) {
    await sendInstagramMessage(senderId, textResponse, instagramToken);
  }
} else {
  await sendInstagramMessage(senderId, textResponse, instagramToken);
}
try {
  await postProcessMessage(chatId, platform, userMessageForLog, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey);
} catch (e) {
  console.error('Instagram postProcessMessage failed:', e);
}
  } catch (err: any) {
    console.error('IG processing error:', err);
   const errorLanguage = chatLanguages[chatId] || userLanguage || "en";
   const errorMessage = getErrorMessageByLanguage(errorLanguage);
    await sendInstagramMessage(
      senderId,
      errorMessage,
     getBusinessInstagramToken(businessConfig)
    );
  }
}

async function startServer() {

  const PORT = Number(process.env.PORT) || 3000;
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  
 app.get("/webhook/instagram", (req, res) => {
  const verify_token = process.env.INSTAGRAM_VERIFY_TOKEN;

  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verify_token) {
      console.log('WEBHOOK_INSTAGRAM_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});
  app.get("/webhook", (req, res) => {
  const verify_token = process.env.INSTAGRAM_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("WEBHOOK_WHATSAPP_VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

  app.post("/webhook", async (req, res) => {
    console.log("========== WHATSAPP WEBHOOK ==========");
console.log(JSON.stringify(req.body, null, 2));
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
          if (entry.changes) {
            for (const change of entry.changes) {
              if (change.field === 'comments' || change.field === 'live_comments') {
                processMetaCommentUpdate(entry, change, activeConfig, 'instagram').catch(e => console.error("IG comment webhook error:", e));
              }
            }
          }
        }
      }
      } else if (body.object === "page") {
      res.status(200).send("EVENT_RECEIVED");

      console.log("========== MESSENGER WEBHOOK ==========");
      console.log(JSON.stringify(body, null, 2));

      for (const entry of body.entry || []) {
        for (const webhookEvent of entry.messaging || []) {
          processMessengerUpdate(webhookEvent, activeConfig).catch(e =>
            console.error("Messenger webhook error:", e)
          );
        }
        for (const change of entry.changes || []) {
          if (change.field === 'comments' || change.field === 'feed') {
            processMetaCommentUpdate(entry, change, activeConfig, 'facebook').catch(e =>
              console.error("Facebook comment webhook error:", e)
            );
          }
        }
      }
    } else if (body.object === 'whatsapp_business_account') {
      res.status(200).send('EVENT_RECEIVED');

      if (body.entry) {
        for (const entry of body.entry) {
          if (entry.changes) {
            for (const change of entry.changes) {
              const value = change.value || {};
              const metadata = value.metadata || {};
              const messages = value.messages || [];

              for (const message of messages) {
                processWhatsAppMessage(message, metadata, activeConfig).catch(e => console.error("WhatsApp webhook error:", e));
              }
            }
          }
        }
      }
    } else {
      res.sendStatus(404);
    }
  });
  app.get("/webhook/messenger", (req, res) => {
    const verifyToken = process.env.MESSENGER_VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      console.log("WEBHOOK_MESSENGER_VERIFIED");
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  app.post("/webhook/messenger", async (req, res) => {
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    res.status(200).send("EVENT_RECEIVED");

    console.log("========== MESSENGER WEBHOOK /webhook/messenger ==========");
    console.log(JSON.stringify(body, null, 2));

    for (const entry of body.entry || []) {
      for (const webhookEvent of entry.messaging || []) {
        processMessengerUpdate(webhookEvent, activeConfig).catch(e =>
          console.error("Messenger route processing error:", e)
        );
      }
    }
  });

  app.post("/webhook/instagram", async (req, res) => {
  const body = req.body;

  if (body.object !== "instagram") {
    return res.sendStatus(404);
  }

  res.status(200).send("EVENT_RECEIVED");

  if (body.entry) {
    for (const entry of body.entry) {
      if (entry.messaging) {
        for (const webhook_event of entry.messaging) {
          processInstagramUpdate(webhook_event, activeConfig).catch(e =>
            console.error("IG webhook instagram route error:", e)
          );
        }
      }
    }
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

const userText =
  typeof userMessageContent === "string"
    ? userMessageContent
    : Array.isArray(userMessageContent)
      ? userMessageContent.join(" ")
      : "";
const userLanguage = detectUserLanguage(userText);
      chatLanguages[chatId] = userLanguage;

messages.push({
  role: "user",
  content: userMessageContent
});
const businessName = activeConfig.businessName || activeConfig.business_name || 'this business';

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
     const languageEngine = `
LANGUAGE ENGINE:
The detected customer language is "${userLanguage}".
Reply ONLY in this language.
If the customer explicitly asks to change language, switch immediately.
Never translate unless requested.
`;
      let finalSystemInstruction =
  (activeConfig.systemPrompt || "") +
  currentDateContext +
  constraint +
  languageEngine;
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
          const notifyToken = activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
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
          const voiceCode = detectTtsVoiceCode(textPart);
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

app.put('/api/businesses/:id', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    }

    const { id } = req.params;

    const {
      businessName,
      telegramToken,
      calendarId,
      systemPrompt,
      instagramPageId,
      instagramAccountId,
      instagramAccessToken,
      instagramVerifyToken,
      instagramEnabled,
    } = req.body;

    const { data, error } = await supabase
      .from('businesses')
      .update({
        business_name: businessName,
        telegram_bot_token: telegramToken || '',
        google_calendar_id: calendarId || '',
        custom_system_prompt: systemPrompt || '',

        instagram_page_id: instagramPageId || '',
        instagram_account_id: instagramAccountId || '',
        instagram_access_token: instagramAccessToken || '',
        instagram_verify_token: instagramVerifyToken || '',
        instagram_enabled: Boolean(instagramEnabled),
      })
      .eq('id', Number(id))
      .select();

    if (error) throw error;

    res.status(200).json({
      success: true,
      data: data || [],
    });
  } catch (err: any) {
    console.error('Error updating business:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
  app.delete('/api/businesses/:id', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    }

    const { id } = req.params;

    const { error } = await supabase
      .from('businesses')
      .delete()
      .eq('id', Number(id));

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Business deleted successfully',
    });
  } catch (err: any) {
    console.error('Error deleting business:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});
  // API: ذخیره یا به‌روزرسانی تنظیمات بیزینس در دیتابیس
app.post('/api/businesses', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    }

   const {
  id,
  businessName,
  businessId,
  telegramToken,
  calendarId,
  systemPrompt,
  instagramPageId,
  instagramAccountId,
  instagramAccessToken,
  instagramVerifyToken,
  instagramEnabled,
} = req.body;
    const finalBusinessName = businessName || businessId;

    if (!finalBusinessName) {
      return res.status(400).json({ success: false, message: 'businessName is required.' });
    }

  const payload: any = {
  business_name: finalBusinessName,
  telegram_bot_token: telegramToken || '',
  google_calendar_id: calendarId || '',
  custom_system_prompt: systemPrompt || '',

  instagram_page_id: instagramPageId || '',
  instagram_account_id: instagramAccountId || '',
  instagram_access_token: instagramAccessToken || '',
  instagram_verify_token: instagramVerifyToken || '',
  instagram_enabled: Boolean(instagramEnabled),
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
  app.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN || 'clinicpilot_verify_123';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Instagram webhook verified successfully.');
    return res.status(200).send(challenge);
  }

  console.log('Instagram webhook verification failed.');
  return res.sendStatus(403);
});

app.post('/webhook/instagram', async (req, res) => {
  try {
    console.log('Incoming Instagram webhook:');
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body;

    if (body.object !== 'instagram') {
      return res.sendStatus(404);
    }

    // Acknowledge Meta fast, then process messages in the background.
    res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const messagingEvent of entry.messaging || []) {
        const hasText = Boolean(messagingEvent?.message?.text);
        const hasAudio = Boolean(
          messagingEvent?.message?.attachments?.some(
            (attachment: any) => attachment?.type === 'audio' && attachment?.payload?.url
          )
        );

        if (hasText || hasAudio) {
          processInstagramUpdate(messagingEvent, activeConfig).catch((e) => {
            console.error('Instagram async processing failed:', e);
          });
        } else {
          console.log('Instagram webhook ignored: no text/audio message payload.');
        }
      }

      // Instagram comments + Meta test payload support
      for (const change of entry.changes || []) {
        const value = change?.value;
        if (change?.field === 'comments' || change?.field === 'live_comments') {
          processMetaCommentUpdate(entry, change, activeConfig, 'instagram').catch((e) => {
            console.error('Instagram comment async processing failed:', e);
          });
        } else if (change?.field === 'messages' && value?.message?.text) {
          console.log('==============================');
          console.log('META TEST MESSAGE');
          console.log('Sender ID:', value.sender?.id);
          console.log('Recipient ID:', value.recipient?.id);
          console.log('Message:', value.message?.text);
          console.log('==============================');
        }
      }
    }
  } catch (err) {
    console.error('Instagram webhook error:', err);
    if (!res.headersSent) return res.sendStatus(500);
  }
});


  app.get('/media/instagram/:filename', (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join('/tmp/clinicpilot_ig_audio', filename);

      if (!fs.existsSync(filePath)) {
        return res.sendStatus(404);
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(filePath);
    } catch (err) {
      console.error('Instagram media serving error:', err);
      return res.sendStatus(500);
    }
  });


  app.get('/media/messenger/:filename', (req, res) => {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join('/tmp/clinicpilot_messenger_audio', filename);

      if (!fs.existsSync(filePath)) {
        return res.sendStatus(404);
      }

      const stat = fs.statSync(filePath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(filePath);
    } catch (err) {
      console.error('Messenger media serving error:', err);
      return res.sendStatus(500);
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
