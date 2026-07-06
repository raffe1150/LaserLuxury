
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
if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
  // Prefer SERVICE_ROLE for server-side writes. This is needed when RLS blocks inserts
  // into tables such as appointments. Falls back to ANON only if service role is missing.
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  supabase = createClient(process.env.SUPABASE_URL, supabaseKey as string, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  console.log(`Supabase client initialized with ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "SERVICE_ROLE" : "ANON"} key.`);
} else {
  console.warn("Supabase not configured: missing SUPABASE_URL and key.");
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
async function postProcessMessage(chatId: string, platform: string, userMessage: string, agentResponse: string, tgToken?: string, aiConfigKey?: string, businessId?: string | null) {
  if (!supabase) return;
  try {
    const payload = [
      {
        user_id: chatId.toString(),
        platform,
        sender: "user",
        message: userMessage,
        business_id: businessId || null
      },
      {
        user_id: chatId.toString(),
        platform,
        sender: "bot",
        message: agentResponse,
        business_id: businessId || null
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
  checkSlots(startDate: string, endDate?: string, durationMinutes?: number, requestedTime?: string): Promise<any> | any;
  insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes?: number, chatId?: string): Promise<any> | any;
  getEvents(startDate: string, endDate: string): Promise<any> | any;
}


function getLastSundayOfMonth(year: number, monthIndex: number): number {
  const d = new Date(Date.UTC(year, monthIndex + 1, 0));
  return d.getUTCDate() - d.getUTCDay();
}

function getStockholmUtcOffset(dateStr?: string): string {
  const safeDate = String(dateStr || "").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!safeDate) return "+02:00";
  const [year, month, day] = safeDate.split("-").map(Number);
  const marchLastSunday = getLastSundayOfMonth(year, 2);
  const octoberLastSunday = getLastSundayOfMonth(year, 9);
  const numericDay = month * 100 + day;
  const dstStart = 3 * 100 + marchLastSunday;
  const dstEnd = 10 * 100 + octoberLastSunday;
  return numericDay >= dstStart && numericDay < dstEnd ? "+02:00" : "+01:00";
}

function ensureStockholmOffset(dateTime: string): string {
  const raw = String(dateTime || "").trim();
  if (!raw) return raw;
  if (raw.includes("Z") || /[+-]\d{2}:?\d{2}$/.test(raw)) return raw;
  const datePart = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return raw + getStockholmUtcOffset(datePart);
}

function localStockholmDateBoundary(dateStr: string, endOfDay = false): string {
  const timePart = endOfDay ? "23:59:59" : "00:00:00";
  return `${dateStr}T${timePart}${getStockholmUtcOffset(dateStr)}`;
}

function getBusinessIdFromConfig(config: any): string | null {
  return config?.businessRecordId || config?.business_id || config?.id || null;
}

function isLikelyWorkingHoursMarker(e: any): boolean {
  const summary = String(e?.summary || e?.title || "").trim().toLowerCase();
  const description = String(e?.description || "").trim().toLowerCase();
  const text = `${summary} ${description}`;

  if (!summary) return false;

  return (
    /working\s*hours|business\s*hours|opening\s*hours|öppettider|arbetstid|schema/.test(text) ||
    /\b\d{1,2}\s*(am|pm)\b/.test(text) ||
    /^laser\s+luxury\s*,?\s*\d{1,2}/i.test(summary)
  );
}

function normalizeRequestedTime(input?: string): string | null {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  const match = raw.match(/(\d{1,2})\s*[\.:]?\s*(\d{2})?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function inferRequestedTimeFromText(text?: string): string | null {
  if (!text) return null;
  const raw = String(text).toLowerCase();

  // Prefer explicit clock words so phone numbers like 0738... are not mistaken for times.
  const patterns = [
    /(?:kl|klockan|clock|saat|saate|hora|las|at)\s*(\d{1,2})(?:[\.:](\d{2}))?/i,
    /(?:^|\s)(\d{1,2})[\.:](\d{2})(?:\s|$)/i,
    /(?:^|\s)(\d{1,2})\s*(?:am|pm)(?:\s|$)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    let hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    if (/pm\b/i.test(match[0]) && hour < 12) hour += 12;
    if (/am\b/i.test(match[0]) && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  return null;
}

function parseSlotIso(slot: string): string | null {
  const match = slot.match(/\(ISO:\s(.*?)\)/);
  return match?.[1] || null;
}

function extractAvailableSlotTimes(slotsString?: string): Set<string> {
  const times = new Set<string>();
  if (!slotsString) return times;
  const matches = String(slotsString).matchAll(/ISO:\s*([^\)]+)/g);
  for (const match of matches) {
    const iso = match[1];
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      times.add(d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }));
    }
  }
  return times;
}

function buildLocalizedSlotReply(slotsArray: string[], specificTime?: string, language: string = "sv"): string {
  const normalizedSpecificTime = normalizeRequestedTime(specificTime || "") || undefined;
  const dayMap = new Map<string, string[]>();
  let foundSpecificSlot: any = null;

  const labels: any = {
    sv: {
      months: ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"],
      days: ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"],
      yes: (d: string, t: string) => `Ja, ${d} kl ${t} är ledig! Ska jag boka den åt dig?`,
      none: "Jag hittade tyvärr inga lediga tider för den perioden. Har du något annat datum i åtanke? 😊",
      busyNone: (t: string) => `Tyvärr är kl ${t} redan bokat, och jag hittade inga andra lediga tider för den perioden. Har du något annat datum i åtanke? 😊`,
      busyAlternatives: (t: string, slots: string) => `Tyvärr är kl ${t} inte ledig. Men jag hittade lediga tider ${slots}. Vilken passar dig bäst? 😊`,
      found: (slots: string) => `Jag hittade lediga tider ${slots}. Vilken av dessa tider passar dig bäst? 😊`,
      at: "kl", and: "och", also: "samt"
    },
    fa: {
      months: ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"],
      days: ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"],
      yes: (d: string, t: string) => `بله، ${d} ساعت ${t} خالی است. می‌خواهید برایتان رزرو کنم؟`,
      none: "متأسفانه برای این بازه زمان خالی پیدا نکردم. تاریخ دیگری مدنظرتان هست؟ 😊",
      busyNone: (t: string) => `متأسفانه ساعت ${t} پر است و زمان خالی دیگری پیدا نکردم. تاریخ دیگری مدنظرتان هست؟ 😊`,
      busyAlternatives: (t: string, slots: string) => `متأسفانه ساعت ${t} خالی نیست. این زمان‌ها خالی هستند: ${slots}. کدام مناسب شماست؟ 😊`,
      found: (slots: string) => `این زمان‌ها خالی هستند: ${slots}. کدام برای شما مناسب‌تر است؟ 😊`,
      at: "ساعت", and: "و", also: "همچنین"
    },
    es: {
      months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
      days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
      yes: (d: string, t: string) => `Sí, ${d} a las ${t} está libre. ¿Quieres que lo reserve?`,
      none: "Lo siento, no encontré horas libres en ese período. ¿Tienes otra fecha en mente? 😊",
      busyNone: (t: string) => `Lo siento, las ${t} ya están ocupadas y no encontré otras horas libres. ¿Tienes otra fecha? 😊`,
      busyAlternatives: (t: string, slots: string) => `Lo siento, las ${t} no están libres. Tengo estas horas: ${slots}. ¿Cuál te va mejor? 😊`,
      found: (slots: string) => `Tengo estas horas libres: ${slots}. ¿Cuál te va mejor? 😊`,
      at: "a las", and: "y", also: "también"
    },
    de: {
      months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
      days: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
      yes: (d: string, t: string) => `Ja, ${d} um ${t} Uhr ist verfügbar. Soll ich den Termin für Sie buchen?`,
      none: "Leider habe ich in diesem Zeitraum keine freien Termine gefunden. Haben Sie ein anderes Datum im Sinn? 😊",
      busyNone: (t: string) => `Leider ist ${t} Uhr bereits gebucht und ich habe keine anderen freien Zeiten gefunden. Haben Sie ein anderes Datum? 😊`,
      busyAlternatives: (t: string, slots: string) => `Leider ist ${t} Uhr nicht verfügbar. Ich habe diese freien Zeiten gefunden: ${slots}. Welche passt Ihnen am besten? 😊`,
      found: (slots: string) => `Ich habe diese freien Zeiten gefunden: ${slots}. Welche passt Ihnen am besten? 😊`,
      at: "um", and: "und", also: "sowie"
    },
    en: {
      months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
      days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      yes: (d: string, t: string) => `Yes, ${d} at ${t} is available. Would you like me to book it?`,
      none: "Sorry, I couldn’t find any available times for that period. Do you have another date in mind? 😊",
      busyNone: (t: string) => `Sorry, ${t} is already booked and I couldn’t find other available times. Do you have another date? 😊`,
      busyAlternatives: (t: string, slots: string) => `Sorry, ${t} is not available. I found these times: ${slots}. Which one suits you best? 😊`,
      found: (slots: string) => `I found these available times: ${slots}. Which one suits you best? 😊`,
      at: "at", and: "and", also: "also"
    }
  };

  const lang = labels[language] ? language : "en";
  const l = labels[lang];

  slotsArray.forEach(slot => {
    const iso = parseSlotIso(slot);
    if (iso) {
      const d = new Date(iso);
      const dateStr = `${l.days[d.getDay()]} ${d.getDate()} ${l.months[d.getMonth()]}`;
      const timeStr = d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' });
      if (normalizedSpecificTime && timeStr === normalizedSpecificTime) foundSpecificSlot = { dateStr, timeStr };
      if (!dayMap.has(dateStr)) dayMap.set(dateStr, []);
      dayMap.get(dateStr)!.push(timeStr);
    }
  });

  if (normalizedSpecificTime && foundSpecificSlot) return l.yes(foundSpecificSlot.dateStr, foundSpecificSlot.timeStr);

  const sentences: string[] = [];
  for (const [dateStr, timesRaw] of dayMap.entries()) {
    const times = [...timesRaw];
    if (times.length === 1) sentences.push(`${dateStr} ${l.at} ${times[0]}`);
    else if (times.length === 2) sentences.push(`${dateStr} ${l.at} ${times[0]} ${l.and} ${times[1]}`);
    else {
      const last = times.pop();
      sentences.push(`${dateStr} ${l.at} ${times.join(', ')} ${l.and} ${last}`);
    }
  }

  const slotsText = sentences.join(`, ${l.also} `);
  if (normalizedSpecificTime && !foundSpecificSlot) {
    if (!slotsText) return l.busyNone(normalizedSpecificTime);
    return l.busyAlternatives(normalizedSpecificTime, slotsText);
  }
  if (!slotsText) return l.none;
  return l.found(slotsText);
}

function formatSwedishTimeSlots(slotsArray: string[], specificTime?: string, language: string = "sv"): string {
  return buildLocalizedSlotReply(slotsArray, specificTime, language);
}

function isBlockingCalendarEvent(e: any): boolean {
  const summary = String(e?.summary || e?.title || "").trim();
  const transparency = String(e?.transparency || "").toLowerCase();
  const eventType = String(e?.eventType || "").toLowerCase();
  const status = String(e?.status || "").toLowerCase();

  if (status === "cancelled") return false;
  if (transparency === "transparent") return false;
  if (eventType === "workinglocation" || eventType === "outofoffice") return false;

  // Working-hour markers must not block the whole day. Real customer events still block,
  // even if they were not created by this bot and do not start with "Bokad:".
  if (isLikelyWorkingHoursMarker(e)) {
    console.log(`[Availability] Ignored working-hours marker: "${summary}"`);
    return false;
  }

  return true;
}

function isSlotFree(startMs: number, durationMinutes: number, events: any[]): boolean {
  const endMs = startMs + durationMinutes * 60 * 1000;
  if (startMs < Date.now()) return false;
  for (const e of events) {
    if (!isBlockingCalendarEvent(e)) continue;
    if (!e.start && !e.startTime) continue;
    const startIso = e.start?.dateTime || e.start?.date || e.startTime;
    const endIso = e.end?.dateTime || e.end?.date || e.endTime;
    const eventStart = new Date(startIso).getTime();
    const eventEnd = new Date(endIso).getTime() || (eventStart + 60 * 60 * 1000);
    if ((startMs < eventEnd) && (endMs > eventStart)) return false;
  }
  return true;
}

function getDailySlots(startDateStr: string, endDateStr: string, events: any[], durationMinutes: number = 60, requestedTime?: string) {
  const slots: string[] = [];
  const normalizedRequestedTime = normalizeRequestedTime(requestedTime || "");
  const endString = endDateStr || startDateStr;

  // ClinicPilot availability window.
  // Previous version used 18:00 as hard closing time, so a real free request like
  // Friday 18:00 was rejected if the treatment duration ended after 18:00.
  // We allow appointments to start at 18:00 and finish later, as long as they fit
  // before BUSINESS_CLOSE_MINUTES. Adjust these two constants later from Dashboard.
  const BUSINESS_OPEN_MINUTES = 9 * 60;
  const BUSINESS_CLOSE_MINUTES = 20 * 60;

  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long' });

  const makeSlot = (dStr: string, hour: number, minute: number) => {
    const isoString = `${dStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${getStockholmUtcOffset(dStr)}`;
    const slotD = new Date(isoString);
    let weekday = dayFormatter.format(slotD);
    weekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return { isoString, slotD, label: `${weekday} kl ${formatter.format(slotD)} (ISO: ${isoString})` };
  };

  const collectRange = (exactOnly: boolean) => {
    const startParts = startDateStr.split('-');
    const startD = new Date(Date.UTC(Number(startParts[0]), Number(startParts[1]) - 1, Number(startParts[2])));
    const endParts = endString.split('-');
    const endD = new Date(Date.UTC(Number(endParts[0]), Number(endParts[1]) - 1, Number(endParts[2])));

    for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const dStr = `${y}-${m}-${day}`;

      if (exactOnly && normalizedRequestedTime) {
        const [h, min] = normalizedRequestedTime.split(':').map(Number);
        const requested = makeSlot(dStr, h, min);
        const requestedStartTotal = h * 60 + min;
        const requestedEndTotal = requestedStartTotal + durationMinutes;
        const endsWithinBusinessHours = requestedStartTotal >= BUSINESS_OPEN_MINUTES && requestedEndTotal <= BUSINESS_CLOSE_MINUTES;
        if (endsWithinBusinessHours && isSlotFree(requested.slotD.getTime(), durationMinutes, events)) {
          slots.push(requested.label);
        }
        continue;
      }

      // Alternative slots every 15 minutes, not only whole hours.
      for (let totalMin = BUSINESS_OPEN_MINUTES; totalMin <= BUSINESS_CLOSE_MINUTES - 15; totalMin += 15) {
        const h = Math.floor(totalMin / 60);
        const min = totalMin % 60;
        const endTotal = totalMin + durationMinutes;
        if (endTotal > BUSINESS_CLOSE_MINUTES) continue;
        const slot = makeSlot(dStr, h, min);
        if (isSlotFree(slot.slotD.getTime(), durationMinutes, events)) slots.push(slot.label);
        if (slots.length >= 3) return;
      }
    }
  };

  // First check the exact time the customer requested. Only if unavailable, offer alternatives.
  if (normalizedRequestedTime) collectRange(true);
  if (slots.length === 0) collectRange(false);

  const topSlots = slots.slice(0, 3);
  if (topSlots.length === 0) return "No available slots found for this period.";
  return topSlots.join("\n");
}

// Default Mock implementation
class MockCalendarAdapter implements CalendarAdapter {
  events: any[] = [
    { id: '1', summary: 'Meeting with Bob', startTime: '2026-06-06T10:00:00Z', endTime: '2026-06-06T11:00:00Z' }
  ];

  checkSlots(startDate: string, endDate?: string, durationMinutes?: number, requestedTime?: string) {
    const events = this.events;
    const slots = getDailySlots(startDate, endDate || startDate, events, durationMinutes, requestedTime);
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
  async checkSlots(startDate: string, endDate?: string, durationMinutes?: number, requestedTime?: string) {
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
      const timeMin = new Date(localStockholmDateBoundary(startDate, false)).toISOString();
      const timeMax = new Date(localStockholmDateBoundary(endDate, true)).toISOString();
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

  async checkSlots(startDate: string, endDate?: string, durationMinutes?: number, requestedTime?: string) {
    try {
      const timeMin = new Date(localStockholmDateBoundary(startDate, false)).toISOString();
      const endDateString = endDate || startDate;
      const timeMax = new Date(localStockholmDateBoundary(endDateString, true)).toISOString();

      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: 'startTime',
      });
      const events = res.data.items || [];
      console.log(`[Availability] start=${startDate}, end=${endDateString}, requestedTime=${requestedTime || "none"}, duration=${durationMinutes || 60}, rawEvents=${events.length}`);
      for (const ev of events) {
        const evStart = ev.start?.dateTime || ev.start?.date || ev.startTime;
        const evEnd = ev.end?.dateTime || ev.end?.date || ev.endTime;
        console.log(`[Availability] event summary="${ev.summary || ""}" start=${evStart} end=${evEnd} blocking=${isBlockingCalendarEvent(ev)}`);
      }
      const slotsText = getDailySlots(startDate, endDateString, events, durationMinutes, requestedTime);
      console.log(`[Availability] result=${JSON.stringify(slotsText)}`);
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
      const safeDateTime = ensureStockholmOffset(dateTime);
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
      (!config.calendarProvider && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && (config.googleCalendarId || process.env.GOOGLE_CALENDAR_ID))) {
    const email = config.googleClientEmail || process.env.GOOGLE_CLIENT_EMAIL;
    const key = config.googlePrivateKey || process.env.GOOGLE_PRIVATE_KEY;
    const id = config.googleCalendarId || process.env.GOOGLE_CALENDAR_ID;
    if (email && key && id) {
      console.log(`[Calendar] Using Google calendar for business=${config.businessName || config.business_name || "unknown"}, business_id=${getBusinessIdFromConfig(config) || "missing"}, calendar_id=${id}`);
      return new GoogleCalendarAdapter(email, key, id);
    } else {
      console.warn("Google Calendar adapter requested but credentials missing. Falling back to Mock.");
    }
  } else if (config.calendarProvider === 'custom' && config.calendarApiUrl) {
    return new GenericCalendarAdapter(config.calendarApiUrl, config.calendarApiKey);
  }
  console.warn("[Calendar] Falling back to MockCalendarAdapter. This should not happen in production.");
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
          requestedTime: { type: "STRING", description: "MANDATORY if the user explicitly requested a specific time, including formats like 15:30, 15.30, 15, or kl 15.50. Normalize to HH:mm, for example 15:50." },
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

const pendingBookings: Record<string, any> = {};

function inferServiceFromText(text?: string): string {
  const raw = String(text || "").toLowerCase();
  if (raw.includes("bikini")) return "Bikinilinjebehandling";
  if (raw.includes("helkropp") || raw.includes("hel kropp") || raw.includes("full body") || raw.includes("fullbody") || raw.includes("ganzkörper") || raw.includes("ganzkorper") || raw.includes("hellkropp")) return "Helkropp laserbehandling";
  if (raw.includes("laser")) return "Laserbehandling";
  if (raw.includes("ansikte")) return "Ansiktsbehandling";
  if (raw.includes("ben")) return "Benbehandling";
  if (raw.includes("arm")) return "Armbehandling";
  return "Bokning";
}

function isAffirmativeBookingText(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (isGratitudeOnly(raw)) return false;
  return /\b(ja|japp|yes|yep|ok|okej|absolut|boka|boka den|gör det|ja tack|ja bitte|bitte|bale|بله|حتما|sí|si)\b/i.test(raw);
}

function isGratitudeOnly(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return /^(tack|tusen tack|thanks|thank you|thx|danke|vielen dank|merci|mersi|مرسی|ممنون|سپاس|gracias|شكرا|shukran)[!.😊🙏\s]*$/i.test(raw);
}

function extractNameAndPhone(text?: string): { name: string; phone: string } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const phoneMatch = raw.match(/(?:\+?\d[\d\s\-()]{6,}\d)/);
  if (!phoneMatch) return null;

  const phone = phoneMatch[0].replace(/[^\d+]/g, "");
  if (phone.replace(/\D/g, "").length < 7) return null;

  // Prefer the text before the phone number for name extraction.
  let beforePhone = raw.slice(0, phoneMatch.index).trim();

  // Swedish / English / Persian written with Latin letters.
  let namePart = beforePhone
    .replace(/mitt\s+namn\s+är/ig, " ")
    .replace(/jag\s+heter/ig, " ")
    .replace(/mitt\s+nummer\s+är/ig, " ")
    .replace(/nummer\s+är/ig, " ")
    .replace(/telefon(?:nummer)?\s+är/ig, " ")
    .replace(/mobil(?:nummer)?\s+är/ig, " ")
    .replace(/name\s+is/ig, " ")
    .replace(/my\s+name\s+is/ig, " ")
    .replace(/phone\s+(?:number\s+)?is/ig, " ")
    .replace(/mein\s+name\s+ist/ig, " ")
    .replace(/meine\s+nummer\s+ist/ig, " ")
    .replace(/telefonnummer\s+ist/ig, " ")
    .replace(/mi\s+nombre\s+es/ig, " ")
    .replace(/mi\s+n[uú]mero\s+es/ig, " ")
    .replace(/\besm(?:am)?\b/ig, " ")
    .replace(/\bnaam(?:am)?\b/ig, " ")
    .replace(/\bnam(?:am)?\b/ig, " ")
    .replace(/\bman\b/ig, " ")
    .replace(/\bhast(?:am)?\b/ig, " ")
    .replace(/\btelefon(?:am|an)?\b/ig, " ")
    .replace(/\bshomare(?:am)?\b/ig, " ")
    .replace(/\bmobile(?:am)?\b/ig, " ")
    .replace(/\boch\b/ig, " ")
    .replace(/\band\b/ig, " ")
    .replace(/\bund\b/ig, " ")
    .replace(/\bva\b/ig, " ")
    .replace(/[,:;.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stop = new Set(["mitt", "namn", "är", "nummer", "telefon", "mobil", "hast", "man", "esmam", "esme", "esmem", "namam", "telephone", "phone", "mein", "meine", "name", "ist", "und", "nummer", "telefonnummer", "mi", "nombre", "es"]);
  const words = namePart
    .split(" ")
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => /^[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]+$/.test(w))
    .filter(w => !stop.has(w.toLowerCase()));

  const name = words.slice(-2).join(" ").trim();
  if (!name) return null;
  return { name, phone };
}

async function savePendingBooking(chatId: string, platform: string, pending: any) {
  pendingBookings[chatId] = pending;
  if (!supabase) return;
  try {
    const minimal = {
      type: "pending_booking",
      platform,
      service: pending.service,
      dateTime: pending.dateTime,
      durationMinutes: pending.durationMinutes,
      status: pending.status,
      business_id: getBusinessIdFromConfig(pending.businessConfig)
    };
    const updateData: any = {
      user_id: chatId,
      platform,
      ai_summary: JSON.stringify(minimal)
    };
    const { data: existing, error: selectError } = await supabase
      .from("appointments_leads")
      .select("user_id")
      .eq("user_id", chatId)
      .maybeSingle();

    if (selectError) console.error("Pending booking lead lookup error:", JSON.stringify(selectError));

    if (existing?.user_id) {
      const { error } = await supabase.from("appointments_leads").update(updateData).eq("user_id", chatId);
      if (error) console.error("Pending booking lead update error:", JSON.stringify(error));
    } else {
      const { error } = await supabase.from("appointments_leads").insert([updateData]);
      if (error) console.error("Pending booking lead insert error:", JSON.stringify(error));
    }
  } catch (err) {
    console.error("savePendingBooking crashed:", err);
  }
}

async function loadPendingBooking(chatId: string, platform: string, businessConfig: any) {
  if (pendingBookings[chatId]) return pendingBookings[chatId];
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("appointments_leads")
      .select("ai_summary")
      .eq("user_id", chatId)
      .maybeSingle();
    if (error) {
      console.error("Pending booking load error:", JSON.stringify(error));
      return null;
    }
    if (!data?.ai_summary) return null;
    const parsed = JSON.parse(data.ai_summary);
    if (parsed?.type !== "pending_booking") return null;
    if (parsed?.platform && parsed.platform !== platform) return null;
    const pending = {
      businessConfig,
      platform,
      service: parsed.service || "Bokning",
      dateTime: parsed.dateTime,
      durationMinutes: Number(parsed.durationMinutes || 60),
      status: parsed.status || "awaiting_contact"
    };
    if (!pending.dateTime) return null;
    pendingBookings[chatId] = pending;
    console.log(`[DeterministicBooking] Pending booking restored from DB. chatId=${chatId}, dateTime=${pending.dateTime}`);
    return pending;
  } catch (err) {
    console.error("loadPendingBooking crashed:", err);
    return null;
  }
}

async function clearPendingBooking(chatId: string) {
  delete pendingBookings[chatId];
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("appointments_leads")
      .update({ ai_summary: null })
      .eq("user_id", chatId);
    if (error) console.error("Pending booking clear error:", JSON.stringify(error));
  } catch (err) {
    console.error("clearPendingBooking crashed:", err);
  }
}

async function notifyAdminAboutBooking(businessConfig: any, platformLabel: string, businessName: string, name: string, phone: string, dateTime: string) {
  const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
  if (!notifyToken || !notifyAdmin) {
    console.error(`[BookingNotify] skipped: missing token/admin. hasToken=${Boolean(notifyToken)}, hasAdmin=${Boolean(notifyAdmin)}`);
    return;
  }
  try {
    const notifyText = `🔔 Ny ${platformLabel}-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${name}\n📞 Mobil: ${phone}\n📅 Tid: ${dateTime}`;
    const res = await fetch(`https://api.telegram.org/bot${notifyToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: notifyAdmin, text: notifyText })
    });
    if (!res.ok) console.error("[BookingNotify] Telegram notify failed:", await res.text());
  } catch (e) {
    console.error("[BookingNotify] Telegram notify crashed:", e);
  }
}

function isExactRequestedSlotAvailable(slotsArray: string[], requestedTime?: string): boolean {
  const normalized = normalizeRequestedTime(requestedTime || "");
  if (!normalized) return false;
  for (const slot of slotsArray) {
    const iso = parseSlotIso(slot);
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const t = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
    if (t === normalized) return true;
  }
  return false;
}

function getExactSlotIso(slotsArray: string[], requestedTime?: string): string | null {
  const normalized = normalizeRequestedTime(requestedTime || "");
  for (const slot of slotsArray) {
    const iso = parseSlotIso(slot);
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const t = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
    if (!normalized || t === normalized) return iso;
  }
  return null;
}

function formatAskContactMessage(language: string = "sv"): string {
  if (language === "fa") return "حتماً 😊 برای رزرو، لطفاً نام و شماره موبایل‌تان را بفرستید.";
  if (language === "es") return "Perfecto 😊 Para reservar, necesito tu nombre y número de móvil.";
  if (language === "de") return "Sehr gern 😊 Für die Buchung brauche ich bitte Ihren Namen und Ihre Mobilnummer.";
  if (language === "ar") return "تمام 😊 لإتمام الحجز، أحتاج اسمك ورقم هاتفك.";
  if (language === "en") return "Perfect 😊 To book it, I just need your name and mobile number.";
  return "Toppen! Innan jag bokar din tid behöver jag ditt namn och mobilnummer. 😊";
}

function getLocaleForLanguage(language: string): string {
  if (language === "de") return "de-DE";
  if (language === "en") return "en-GB";
  if (language === "es") return "es-ES";
  if (language === "fa") return "fa-IR";
  if (language === "ar") return "ar";
  return "sv-SE";
}

function localizeServiceName(service: string, language: string): string {
  const raw = String(service || "Bokning").toLowerCase();
  const isFullBody = raw.includes("helkropp") || raw.includes("full") || raw.includes("ganz");
  const isBikini = raw.includes("bikini");
  if (language === "de") {
    if (isFullBody) return "Ganzkörperbehandlung";
    if (isBikini) return "Bikinibehandlung";
    return "Behandlung";
  }
  if (language === "fa") {
    if (isFullBody) return "لیزر فول بادی";
    if (isBikini) return "لیزر بیکینی";
    return "درمان";
  }
  if (language === "en") {
    if (isFullBody) return "full-body treatment";
    if (isBikini) return "bikini treatment";
    return "treatment";
  }
  if (language === "es") {
    if (isFullBody) return "tratamiento de cuerpo completo";
    if (isBikini) return "tratamiento de bikini";
    return "tratamiento";
  }
  if (isFullBody) return "helkroppsbehandling";
  if (isBikini) return "bikinibehandling";
  return service || "behandling";
}

function formatBookingSavedMessage(language: string, name: string, service: string, dateTime: string): string {
  const start = new Date(ensureStockholmOffset(dateTime));
  const locale = getLocaleForLanguage(language);
  const dateText = start.toLocaleDateString(locale, { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long" });
  const timeText = start.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  const serviceText = localizeServiceName(service, language);
  if (language === "fa") return `عالی ${name}! وقت شما برای ${serviceText} در ${dateText} ساعت ${timeText} رزرو شد. 😊`;
  if (language === "es") return `Perfecto ${name}! Tu cita para ${serviceText} está reservada el ${dateText} a las ${timeText}. 😊`;
  if (language === "de") return `Perfekt, ${name}! Ihr Termin für die ${serviceText} ist am ${dateText} um ${timeText} Uhr gebucht. 😊`;
  if (language === "ar") return `تمام ${name}! تم حجز موعدك لـ ${serviceText} يوم ${dateText} الساعة ${timeText}. 😊`;
  if (language === "en") return `Perfect, ${name}! Your appointment for ${serviceText} is booked on ${dateText} at ${timeText}. 😊`;
  return `Härligt ${name}! Din tid för ${serviceText} är nu bokad ${dateText} kl ${timeText}. Vi ser fram emot att träffa dig! 😊`;
}

function formatThanksAfterBookingMessage(language: string, name?: string): string {
  if (language === "fa") return name ? `خواهش می‌کنم ${name}! روز خوبی داشته باشید 😊` : "خواهش می‌کنم! روز خوبی داشته باشید 😊";
  if (language === "de") return name ? `Sehr gern, ${name}! Ich wünsche Ihnen einen schönen Tag 😊` : "Sehr gern! Ich wünsche Ihnen einen schönen Tag 😊";
  if (language === "es") return name ? `De nada, ${name}! Que tengas un buen día 😊` : "De nada! Que tengas un buen día 😊";
  if (language === "ar") return name ? `على الرحب والسعة ${name}! أتمنى لك يوماً جميلاً 😊` : "على الرحب والسعة! أتمنى لك يوماً جميلاً 😊";
  if (language === "en") return name ? `You're welcome, ${name}! Have a lovely day 😊` : "You're welcome! Have a lovely day 😊";
  return name ? `Varsågod, ${name}! Ha en fin dag 😊` : "Varsågod! Ha en fin dag 😊";
}

async function getLatestBookedAppointmentForUser(userId: string) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("customer_name,start_time,status")
      .eq("user_id", userId)
      .eq("status", "booked")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("Latest booked appointment lookup error:", JSON.stringify(error));
      return null;
    }
    return data || null;
  } catch (err) {
    console.error("getLatestBookedAppointmentForUser crashed:", err);
    return null;
  }
}

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, after an available slot is confirmed, ask for name and mobile number; do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. If the latest customer message is English, reply in English. If it is Swedish, reply in Swedish. If it is Persian, German, Spanish, or Arabic, reply in that same language. Never default to Swedish just because the business is in Sweden.
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
  languageEngine +
  buildLanguageLockInstruction(chatLanguages[telegramSessionId] || detectUserLanguage(text || ""));
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
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(text || ""));
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\n')
                    .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(text || ""), getConversationLanguage(telegramSessionId, text || ""));
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
        else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig: config,
              platform: "telegram",
              userId: chatId.toString(),
              name: args.name,
              phone: args.phone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
          }
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
      postProcessMessage(chatId.toString(), platform, userMessageContent, textResponse, telegramToken, apiKey, getBusinessIdFromConfig(config));
    } else {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: textResponse })
      });
      
      postProcessMessage(chatId.toString(), platform, userMessageContent, textResponse, telegramToken, apiKey, getBusinessIdFromConfig(config));
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
  const raw = String(text || "").trim();
  if (!raw) return "en";
  const lower = raw.toLowerCase();

  if (/[\u0600-\u06FF]/.test(raw)) {
    if (/\b(سلام|مرسی|ممنون|لطفا|لطفاً|وقت|رزرو|شماره|اسم|نوبت)\b/u.test(raw)) return "fa";
    if (/\b(مرحبا|السلام|شكرا|موعد|حجز|اليوم|غدا)\b/u.test(raw)) return "ar";
    return "fa";
  }

  const scores: Record<string, number> = { en: 0, sv: 0, de: 0, es: 0, fa: 0, ar: 0 };
  const add = (lang: string, pattern: RegExp, weight = 1) => {
    const matches = lower.match(pattern);
    if (matches) scores[lang] += matches.length * weight;
  };

  // Strong phrase-level signals first.
  add("de", /\b(ja\s*,?\s*bitte|ich\s+(möchte|wuerde|würde|will)|mein\s+name\s+ist|meine\s+nummer\s+ist|um\s+\d{1,2}(:\d{2})?\s*uhr|ganzkörper|ganzkorper)\b/g, 5);
  add("en", /\b(my\s+name\s+is|my\s+phone\s+is|i\s+(want|would\s+like|need)|can\s+i|could\s+i|thank\s+you|next\s+week)\b/g, 5);
  add("sv", /\b(mitt\s+namn\s+är|mitt\s+nummer\s+är|jag\s+(vill|ska|heter)|kl\s*\d{1,2}|klockan\s*\d{1,2}|ja\s+tack)\b/g, 5);
  add("fa", /\b(salam|bale|mikham|mikhastam|baraye|sate|saat|vaght|shomare|esm[eai]?|hast|mersi|merci|sepas|gozaram|khube|chi|cheghadr|doshanbe|seshanbe|chaharshanbe|panjshanbe|jome|shanbe|yekshanbe)\b/g, 4);
  add("es", /\b(mi\s+nombre\s+es|mi\s+n[uú]mero\s+es|quiero|me\s+gustar[ií]a|por\s+favor)\b/g, 5);

  if (/[áéíóúñ¿¡]/i.test(raw)) scores.es += 3;
  if (/[åäö]/i.test(raw)) scores.sv += 3;
  if (/[äöüß]/i.test(raw)) scores.de += 4;

  add("en", /\b(hi|hello|hey|thanks|thank you|yes|no|please|appointment|book|booking|available|today|tomorrow|friday|thursday|wednesday|tuesday|monday|saturday|sunday|treatment|bikini|phone|number)\b/g, 2);
  add("sv", /\b(hej|hejsan|tack|tusen tack|ja|nej|jag|vill|ska|ha|boka|bokning|tid|ledig|behandling|klockan|kl|mobilnummer|telefonnummer|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|idag|imorgon)\b/g, 2);
  add("de", /\b(hallo|guten|danke|bitte|termin|uhr|morgen|nachmittag|buchen|behandlung|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|nummer|telefonnummer|name)\b/g, 2);
  add("es", /\b(hola|gracias|cita|reservar|tratamiento|mañana|manana|hora|semana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/g, 2);
  add("fa", /\b(chetori|khubi|mamnoon|lotfan|bebakhshid|mitoni|mishe|farsi|telefonam|mobile|mobail|hastam|hast)\b/g, 2);
  add("ar", /\b(marhaba|shukran|maw3ed|hajz|bukra|alyawm)\b/g, 2);

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > 0) {
    console.log(`[LanguageDetect] text=${JSON.stringify(raw.slice(0, 80))}, scores=${JSON.stringify(scores)}, selected=${ranked[0][0]}`);
    return ranked[0][0];
  }

  return "en";
}

function getConversationLanguage(chatId: string, latestText?: string): string {
  const detected = detectUserLanguage(latestText || "");
  // Always allow the latest clear customer message to switch language.
  // This prevents an old Swedish "Hej" from locking a new English conversation into Swedish.
  if (latestText && String(latestText).trim()) {
    chatLanguages[chatId] = detected;
    return detected;
  }
  return chatLanguages[chatId] || detected || "en";
}

function getLanguageName(language: string): string {
  const map: Record<string, string> = {
    sv: "Swedish",
    en: "English",
    fa: "Persian/Farsi",
    de: "German",
    es: "Spanish",
    ar: "Arabic"
  };
  return map[language] || "English";
}

function buildLanguageLockInstruction(language: string): string {
  const name = getLanguageName(language);
  return `
ACTIVE CONVERSATION LANGUAGE: ${name} (${language}).
You MUST write the next customer-facing reply only in ${name}.
Do not answer in Swedish unless ACTIVE CONVERSATION LANGUAGE is Swedish.
Do not let the business location, calendar locale, service names, or previous messages override this.
If the latest customer message is in a different supported language, follow that latest customer language.
`;
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


function normalizePlatformUserId(platform: string, userId: string) {
  const raw = String(userId || "").trim();
  if (!raw) return "";
  if (platform === "telegram") return raw.replace(/^telegram_/, "");
  if (platform === "whatsapp") return raw.replace(/^wa_/, "");
  if (platform === "instagram") return raw.replace(/^ig_/, "");
  if (platform === "messenger") return raw.replace(/^ms_/, "");
  return raw;
}

function getAppointmentTimes(dateTime: string, durationMinutes: number = 60) {
  const safeDateTime = ensureStockholmOffset(String(dateTime || ""));
  const start = new Date(safeDateTime);
  const duration = Number(durationMinutes || 60);
  const end = new Date(start.getTime() + duration * 60 * 1000);
  return { start, end };
}

async function recordAppointmentFromBooking(params: {
  businessConfig: any;
  platform: string;
  userId: string;
  name: string;
  phone: string;
  service: string;
  dateTime: string;
  durationMinutes?: number;
}) {
  if (!supabase) {
    console.error("Appointment DB insert skipped: Supabase client is not configured.");
    return;
  }

  try {
    const { start, end } = getAppointmentTimes(params.dateTime, params.durationMinutes || 60);
    if (Number.isNaN(start.getTime())) {
      console.error("Appointment DB insert skipped: invalid start_time", params.dateTime);
      return;
    }

    const businessId = getBusinessIdFromConfig(params.businessConfig);
    const payload: any = {
      business_id: businessId,
      customer_name: params.name || null,
      phone_number: params.phone || null,
      platform: params.platform,
      user_id: params.userId ? String(params.userId) : null,
      service: params.service || null,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      status: "booked",
      reminder_24_sent: false,
      reminder_2_sent: false
    };

    console.log("Appointment DB insert attempt:", JSON.stringify(payload));
    if (!businessId) {
      console.error("Appointment DB insert warning: business_id is missing. Check tenant lookup before booking. businessConfig=", JSON.stringify({ businessName: params.businessConfig?.businessName || params.businessConfig?.business_name, googleCalendarId: params.businessConfig?.googleCalendarId, instagramAccountId: params.businessConfig?.instagramAccountId, messengerPageId: params.businessConfig?.messengerPageId, whatsappPhoneNumberId: params.businessConfig?.whatsappPhoneNumberId }));
    }

    const { data, error } = await supabase
      .from("appointments")
      .insert([payload])
      .select("id,business_id,customer_name,start_time")
      .single();

    if (error) {
      console.error("Supabase appointments insert error:", JSON.stringify(error));
      console.error("If this says RLS/policy/permission, add SUPABASE_SERVICE_ROLE_KEY to Render Environment or temporarily disable RLS on appointments while testing.");
    } else {
      console.log("Appointment saved to Supabase appointments:", JSON.stringify(data));
    }
  } catch (err) {
    console.error("recordAppointmentFromBooking error:", err);
  }
}

async function loadBusinessConfigById(businessId: any) {
  if (!supabase || !businessId) return { ...activeConfig };
  try {
    const { data, error } = await supabase.from("businesses").select("*").eq("id", businessId).maybeSingle();
    if (error) console.error("Reminder business lookup error:", JSON.stringify(error));
    if (data) return normalizeBusinessConfig(data);
  } catch (err) {
    console.error("Reminder business lookup crashed:", err);
  }
  return { ...activeConfig };
}

function formatReminderMessage(appointment: any, businessConfig: any, reminderType: "24h" | "2h") {
  const name = appointment.customer_name || "";
  const service = appointment.service || "din behandling";
  const businessName = businessConfig.businessName || businessConfig.business_name || "oss";
  const start = new Date(appointment.start_time);
  const dateText = start.toLocaleDateString("sv-SE", {
    timeZone: "Europe/Stockholm",
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const timeText = start.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit"
  });

  if (reminderType === "2h") {
    return `Hej ${name || ""}! En vänlig påminnelse från ${businessName}: du har tid för ${service} idag kl ${timeText}. Vi ses snart! 😊`.trim();
  }

  return `Hej ${name || ""}! En vänlig påminnelse från ${businessName}: du har tid för ${service} imorgon, ${dateText} kl ${timeText}. Varmt välkommen! 😊`.trim();
}

async function sendAppointmentReminder(appointment: any, reminderType: "24h" | "2h") {
  const businessConfig = await loadBusinessConfigById(appointment.business_id);
  const platform = String(appointment.platform || "").toLowerCase();
  const rawUserId = String(appointment.user_id || "");
  const recipient = normalizePlatformUserId(platform, rawUserId);
  const message = formatReminderMessage(appointment, businessConfig, reminderType);

  if (!recipient) {
    console.log(`[Reminder] Skipped appointment ${appointment.id}: missing recipient`);
    return false;
  }

  try {
    if (platform === "telegram") {
      const token = businessConfig.telegramToken || activeConfig.telegramToken || process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error("Missing Telegram token");
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: recipient, text: message })
      });
      return res.ok;
    }

    if (platform === "whatsapp") {
      return await sendWhatsAppMessage(recipient, message, businessConfig);
    }

    if (platform === "messenger") {
      return await sendMessengerMessage(recipient, message, businessConfig);
    }

    if (platform === "instagram") {
      const token = getBusinessInstagramToken(businessConfig);
      return await sendInstagramMessage(recipient, message, token);
    }

    console.log(`[Reminder] Unsupported platform for appointment ${appointment.id}: ${platform}`);
    return false;
  } catch (err) {
    console.error(`[Reminder] Send failed for appointment ${appointment.id}:`, err);
    return false;
  }
}

function setupDailyReminders() {
  // Runs every 5 minutes and sends reminders from the Supabase appointments table.
  cron.schedule("*/5 * * * *", async () => {
    if (!supabase) {
      console.log("[Reminder] Supabase not configured. Skipping reminder worker.");
      return;
    }

    const now = new Date();
    const in24hStart = new Date(now.getTime() + 23.5 * 60 * 60 * 1000);
    const in24hEnd = new Date(now.getTime() + 24.5 * 60 * 60 * 1000);
    const in2hStart = new Date(now.getTime() + 1.75 * 60 * 60 * 1000);
    const in2hEnd = new Date(now.getTime() + 2.25 * 60 * 60 * 1000);

    console.log("[Reminder] Checking appointments for 24h and 2h reminders...");

    const processWindow = async (reminderType: "24h" | "2h", from: Date, to: Date, sentColumn: string) => {
      const { data, error } = await supabase
        .from("appointments")
        .select("*")
        .eq("status", "booked")
        .eq(sentColumn, false)
        .gte("start_time", from.toISOString())
        .lte("start_time", to.toISOString())
        .limit(25);

      if (error) {
        console.error(`[Reminder] Query error for ${reminderType}:`, JSON.stringify(error));
        return;
      }

      for (const appointment of data || []) {
        const sent = await sendAppointmentReminder(appointment, reminderType);
        if (sent) {
          const { error: updateError } = await supabase
            .from("appointments")
            .update({ [sentColumn]: true })
            .eq("id", appointment.id);

          if (updateError) console.error(`[Reminder] Failed to mark ${reminderType} sent:`, JSON.stringify(updateError));
          else console.log(`[Reminder] ${reminderType} sent for appointment ${appointment.id}`);
        }
      }
    };

    try {
      await processWindow("24h", in24hStart, in24hEnd, "reminder_24_sent");
      await processWindow("2h", in2hStart, in2hEnd, "reminder_2_sent");
    } catch (err) {
      console.error("[Reminder] Worker crashed:", err);
    }
  }, { timezone: "Europe/Stockholm" });

  console.log("[Reminder] Appointment reminder worker scheduled every 5 minutes.");
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
  const userLanguage = getConversationLanguage(chatId, textMessage || "");

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, after an available slot is confirmed, ask for name and mobile number; do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. If the latest customer message is English, reply in English. If it is Swedish, reply in Swedish. If it is Persian, German, Spanish, or Arabic, reply in that same language. Never default to Swedish just because the business is in Sweden.
`;

    const swedenDate = new Date().toLocaleDateString("en-US", {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;

    let finalSystemInstruction = (businessConfig.systemPrompt || "") + currentDateContext + constraint + languageEngine + buildLanguageLockInstruction(userLanguage);

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
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(textMessage || ""));
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split("\n")
              .filter((s: string) => s.trim().length > 0 && !s.includes("No available slots"));

            const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(textMessage || ""), getConversationLanguage(chatId, textMessage || ""));
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === "insertAppointment" && args) {
          // Messenger bookings are finalized by deterministic server logic only.
          // Gemini may choose the wrong name/service/time, so we route this safely.
          const restoredPending = await loadPendingBooking(chatId, "messenger", businessConfig);
          const contactFromMessage = extractNameAndPhone(textMessage || "");
          if (restoredPending && contactFromMessage) {
            console.log(`[DeterministicBooking] Gemini tried insertAppointment, routing to deterministic booking. chatId=${chatId}`);
            adapterRes = await adapter.insertAppointment(contactFromMessage.name, contactFromMessage.phone, restoredPending.service, restoredPending.dateTime, restoredPending.durationMinutes, chatId);
            if (adapterRes && adapterRes.success) {
              await recordAppointmentFromBooking({
                businessConfig,
                platform: "messenger",
                userId: chatId,
                name: contactFromMessage.name,
                phone: contactFromMessage.phone,
                service: restoredPending.service,
                dateTime: restoredPending.dateTime,
                durationMinutes: restoredPending.durationMinutes
              });
              await clearPendingBooking(chatId);
              await notifyAdminAboutBooking(businessConfig, "Messenger", businessName, contactFromMessage.name, contactFromMessage.phone, restoredPending.dateTime);
            }
          } else {
            console.log(`[DeterministicBooking] Blocked Messenger Gemini insertAppointment. No reliable pending/contact found. args=${JSON.stringify(args)}`);
            adapterRes = { success: false, message: "Booking was not finalized. Ask the customer for name and mobile number after confirming the exact available time." };
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
      await postProcessMessage(chatId, platform, textMessage, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
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

function normalizeCommentText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function truncateWords(text: string, maxWords: number = 20): string {
  const cleaned = normalizeCommentText(text);
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length <= maxWords) return cleaned;
  return words.slice(0, maxWords).join(" ").replace(/[,.!?،؛:]+$/g, "") + "…";
}

function isSimplePositiveComment(text: string): boolean {
  const lower = normalizeCommentText(text).toLowerCase();

  if (!lower) return false;
  if (lower.length > 80) return false;
  if (/[?؟]/.test(lower)) return false;

  const positiveRegex = /\b(nice|great|good|amazing|perfect|love|thanks|thank you|well done|awesome|bra|snyggt|fint|tack|toppen|jättebra|super|grymt|خوب|عالی|مرسی|ممنون|قشنگ|زیبا|خیلی خوب)\b/i;
  return positiveRegex.test(lower) || /[👍😍❤️✨🔥👏]/u.test(lower);
}

function getQuickPositiveReply(commentText: string): string {
  const lang = detectUserLanguage(commentText);

  if (lang === "fa") return "خیلی ممنون! ✨";
  if (lang === "sv") return "Tusen tack! ✨";
  if (lang === "de") return "Vielen Dank! ✨";
  if (lang === "es") return "¡Muchas gracias! ✨";
  if (lang === "ar") return "شكرًا جزيلًا! ✨";

  return "Thank you so much! ✨";
}

function isProbablyBusinessOwnComment(username: string, fromId: string, ownerId: string, businessConfig: any): boolean {
  const user = normalizeCommentText(username).toLowerCase().replace(/^@/, "");
  const from = String(fromId || "").trim();
  const owner = String(ownerId || "").trim();

  const candidateIds = [
    owner,
    businessConfig?.instagramAccountId,
    businessConfig?.instagram_account_id,
    businessConfig?.instagramPageId,
    businessConfig?.instagram_page_id,
    businessConfig?.messengerPageId,
    businessConfig?.messenger_page_id,
    businessConfig?.facebook_page_id,
    businessConfig?.page_id
  ].filter(Boolean).map((v: any) => String(v).trim());

  if (from && candidateIds.includes(from)) return true;

  const candidateUsernames = [
    businessConfig?.instagramUsername,
    businessConfig?.instagram_username,
    businessConfig?.businessInstagramUsername,
    businessConfig?.business_instagram_username,
    businessConfig?.pageUsername,
    businessConfig?.page_username,
    businessConfig?.businessName,
    businessConfig?.business_name
  ]
    .filter(Boolean)
    .map((v: any) => String(v).toLowerCase().replace(/^@/, "").replace(/\s+/g, ""));

  const normalizedUser = user.replace(/\s+/g, "");
  if (normalizedUser && candidateUsernames.includes(normalizedUser)) return true;

  // Current test page handle used in this project. This prevents the bot from replying to its own public replies.
  if (normalizedUser === "admotionstudio.1" || normalizedUser === "laserluxury" || normalizedUser === "laser_luxury") return true;

  return false;
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
    instagram_access_token: row.instagram_access_token,
    instagramToken: row.instagram_access_token,
    instagramAccountId: row.instagram_account_id,
    instagramPageId: row.instagram_page_id,
    instagramUsername: row.instagram_username || row.page_username || row.business_instagram_username,
    instagram_username: row.instagram_username,
    pageUsername: row.page_username,
    instagramPageAccessToken: row.instagram_page_access_token || row.facebook_page_access_token || row.page_access_token,
    instagramCommentAccessToken: row.instagram_comment_access_token || row.instagram_page_access_token || row.facebook_page_access_token || row.page_access_token,
    messengerPageId: row.messenger_page_id || row.facebook_page_id || row.page_id,
    messengerPageAccessToken: cleanMetaToken(
      row.messenger_page_access_token ||
      row.facebook_page_access_token ||
      row.page_access_token ||
      row.instagram_access_token
    ),
    facebook_page_access_token: row.facebook_page_access_token,
    page_access_token: row.page_access_token,
    messenger_page_access_token: row.messenger_page_access_token,
    calendarProvider: "google"
  };
}

function uniqueNonEmpty(values: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = cleanMetaToken(value) || cleanInstagramToken(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function getCommentAccessTokens(source: "instagram" | "facebook", businessConfig: any): string[] {
  // Comment replies are sent through Meta Graph /{comment-id}/replies.
  // Depending on the app setup, Meta may require the Page access token, while DMs may work with the IG token.
  // So we try the business Page token first, then the Instagram token as fallback.
  if (source === "instagram") {
    return uniqueNonEmpty([
      businessConfig?.instagramCommentAccessToken,
      businessConfig?.instagram_comment_access_token,
      businessConfig?.instagramPageAccessToken,
      businessConfig?.instagram_page_access_token,
      businessConfig?.messengerPageAccessToken,
      businessConfig?.messenger_page_access_token,
      businessConfig?.facebook_page_access_token,
      businessConfig?.page_access_token,
      businessConfig?.instagramAccessToken,
      businessConfig?.instagram_access_token,
      businessConfig?.instagramToken,
      process.env.INSTAGRAM_COMMENT_ACCESS_TOKEN,
      process.env.INSTAGRAM_PAGE_ACCESS_TOKEN,
      process.env.MESSENGER_PAGE_ACCESS_TOKEN,
      process.env.INSTAGRAM_ACCESS_TOKEN
    ]);
  }

  return uniqueNonEmpty([
    businessConfig?.messengerPageAccessToken,
    businessConfig?.messenger_page_access_token,
    businessConfig?.facebook_page_access_token,
    businessConfig?.page_access_token,
    process.env.MESSENGER_PAGE_ACCESS_TOKEN
  ]);
}

async function sendMetaCommentReply(commentId: string, text: string, tokens: string[] | string, source: "instagram" | "facebook") {
  const tokenList = Array.isArray(tokens) ? tokens : uniqueNonEmpty([tokens]);
  if (!commentId || !text || tokenList.length === 0) {
    console.error(`Comment reply skipped: missing commentId/text/token. commentId=${commentId || "missing"}, hasText=${Boolean(text)}, tokenCount=${tokenList.length}`);
    return false;
  }

  const endpoints = source === "instagram"
    ? [
        `https://graph.facebook.com/v25.0/${encodeURIComponent(commentId)}/replies`,
        `https://graph.instagram.com/v25.0/${encodeURIComponent(commentId)}/replies`
      ]
    : [`https://graph.facebook.com/v25.0/${encodeURIComponent(commentId)}/comments`];

  let lastError: any = null;

  for (const endpoint of endpoints) {
    for (let i = 0; i < tokenList.length; i++) {
      const cleanToken = tokenList[i];
      try {
        console.log(`${source} comment reply attempt: endpoint=${endpoint.includes('instagram.com') ? 'graph.instagram' : 'graph.facebook'}, tokenIndex=${i}, token=${maskToken(cleanToken)}`);

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

        lastError = result;
        console.error(`${source} comment reply failed with tokenIndex=${i}:`, JSON.stringify(result));
      } catch (err) {
        lastError = err;
        console.error(`${source} comment reply error with tokenIndex=${i}:`, err);
      }
    }
  }

  console.error(`${source} comment reply failed after all token/endpoint attempts:`, JSON.stringify(lastError));
  return false;
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

  // Unified Meta comment engine:
  // Instagram comments usually use: value.id + value.text + value.from.username
  // Facebook Page feed comments usually use: value.comment_id + value.message + value.sender_id
  const itemType = String(value.item || change?.field || "").toLowerCase();
  const verb = String(value.verb || "").toLowerCase();

  // Facebook feed can send many event types. We only want comments.
  if (source === "facebook" && itemType && itemType !== "comment" && change?.field === "feed") {
    console.log("Facebook feed event ignored: not a comment.", { itemType, verb });
    return;
  }

  const commentId = value.comment_id || value.id;
  const commentText = normalizeCommentText(value.text || value.message || "");
  const from = value.from || value.sender || {};
  const username = from.username || from.name || value.sender_name || value.sender_id || from.id || "";
  const fromId = String(from.id || value.sender_id || "").trim();
  const ownerId = String(entry?.id || value?.owner_id || value?.page_id || value?.recipient_id || "").trim();
  const parentId = String(value.parent_id || value.parent_comment_id || "").trim();

  if (!commentId || !commentText || !ownerId) {
    console.log("Meta comment ignored: missing commentId/text/ownerId.");
    return;
  }

  const dedupeKey = `${source}:${commentId}`;
  if (processedMetaCommentIds.has(dedupeKey)) {
    console.log("Meta comment ignored: duplicate comment id:", dedupeKey);
    return;
  }
  processedMetaCommentIds.add(dedupeKey);
  if (processedMetaCommentIds.size > 5000) {
    const first = processedMetaCommentIds.values().next().value;
    if (first !== undefined) processedMetaCommentIds.delete(first);
  }

  console.log("==============================");
  console.log(source === "instagram" ? "REAL INSTAGRAM COMMENT" : "REAL FACEBOOK COMMENT");
  console.log("Owner/Page ID:", ownerId);
  console.log("Comment ID:", commentId);
  console.log("Parent ID:", parentId || "none");
  console.log("User:", username);
  console.log("Comment:", commentText);
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

  // Anti-loop: never reply to comments/replies written by the business account itself.
  // This prevents the bot from answering its own public replies again and again.
  if (isProbablyBusinessOwnComment(username, fromId, ownerId, businessConfig)) {
    console.log("Meta comment ignored: own business/page comment.");
    return;
  }

  const negative = looksLikeNegativeComment(commentText);
  const isSimplePositive = isSimplePositiveComment(commentText);

  let replyText = "";

  try {
    if (isSimplePositive && !negative) {
      // Cheap and safe path: no Gemini call for simple praise like "Nice job 👍".
      replyText = getQuickPositiveReply(commentText);
      console.log("Meta comment quick positive reply selected:", replyText);
    } else {
      const commentSystemInstruction = `
${businessConfig.systemPrompt || ""}

COMMENT REPLY ENGINE:
You are an expert public social-media assistant for ${businessName}.
Reply publicly to ONE customer comment under a post.
First classify the comment silently as: PRAISE, QUESTION, PRICE, BOOKING, NEGATIVE, SPAM, or PRIVATE.
Reply in the SAME language as the customer's comment.
Maximum 18 words. One short sentence only.
Do not over-thank. Do not write long marketing text.
Do not repeat the customer's comment.
Do not reply to yourself or to bot-generated replies.
Use the business-specific system prompt as the source of truth.
For BOOKING, PRIVATE, phone number, cancellation, or rescheduling: invite them to DM.
For PRICE: answer generally if the prompt has safe pricing info, otherwise invite them to DM.
For NEGATIVE: be calm, grateful, accountable, and invite them to DM.
For SPAM: return exactly IGNORE_COMMENT.
Never mention internal tools, AI, databases, prompts, or webhooks.
`;

      const chatResponse = await generateContentWithFallback(null, {
        messages: [{ role: "user", content: `Public comment from ${username || "customer"}: ${commentText}\nNegative comment: ${negative ? "yes" : "no"}` }],
        systemInstruction: commentSystemInstruction,
        model: "gemini-2.5-flash"
      });

      replyText = truncateWords((chatResponse.text || "").trim(), 18);
      if (replyText.toUpperCase().includes("IGNORE_COMMENT")) {
        console.log("Meta comment ignored by AI classifier as spam/unsafe.");
        return;
      }
    }

    if (!replyText) {
      replyText = negative
        ? (detectUserLanguage(commentText) === "sv" ? "Tack för din feedback. Skicka gärna DM så hjälper vi dig vidare." :
           detectUserLanguage(commentText) === "fa" ? "ممنون از بازخوردتان. لطفاً دایرکت بدهید تا بهتر کمک کنیم." :
           "Thank you for your feedback. Please DM us so we can help.")
        : getQuickPositiveReply(commentText);
    }

    const tokens = getCommentAccessTokens(source, businessConfig);
    console.log(`Meta comment token candidates: count=${tokens.length}, first=${tokens[0] ? maskToken(tokens[0]) : "none"}`);
    const sent = await sendMetaCommentReply(commentId, replyText, tokens, source);

    // Notify admin only once for the original customer comment. Own replies are ignored above.
    if (negative || sent) {
      await notifyAdminAboutComment(businessConfig, {
        source,
        businessName,
        username,
        commentText,
        replyText,
        commentId,
        negative
      });
    }
  } catch (err: any) {
    console.error("Meta comment processing error:", err);
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
  const userLanguage = getConversationLanguage(chatId, textMessage || "");

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
    let pending = await loadPendingBooking(chatId, "messenger", businessConfig);
    const detectedLang = getConversationLanguage(chatId, textMessage || "");

    if (textMessage && isGratitudeOnly(textMessage)) {
      const latestBooked = await getLatestBookedAppointmentForUser(chatId);
      if (latestBooked) {
        await clearPendingBooking(chatId);
        const thanksText = formatThanksAfterBookingMessage(detectedLang, latestBooked.customer_name);
        console.log(`[DeterministicBooking] Gratitude after completed booking. chatId=${chatId}`);
        await sendMessengerMessage(senderId, thanksText, businessConfig);
        await postProcessMessage(chatId, platform, textMessage, thanksText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
        return;
      }
    }

    if (pending && textMessage && isAffirmativeBookingText(textMessage) && pending.status === "awaiting_confirmation") {
      pending.status = "awaiting_contact";
      await savePendingBooking(chatId, "messenger", pending);
      const askText = formatAskContactMessage(detectedLang);
      console.log(`[DeterministicBooking] Messenger confirmation received. Awaiting contact. chatId=${chatId}`);
      await sendMessengerMessage(senderId, askText, businessConfig);
      await postProcessMessage(chatId, platform, textMessage, askText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

    const contact = extractNameAndPhone(textMessage || "");
    if (pending && contact && (pending.status === "awaiting_contact" || pending.status === "awaiting_confirmation")) {
      console.log(`[DeterministicBooking] Messenger contact received. Booking now. chatId=${chatId}, pending=${JSON.stringify({ service: pending.service, dateTime: pending.dateTime, durationMinutes: pending.durationMinutes })}`);
      const adapter = getCalendarAdapter(businessConfig);
      const adapterRes = await adapter.insertAppointment(contact.name, contact.phone, pending.service, pending.dateTime, pending.durationMinutes, chatId);

      if (adapterRes && adapterRes.success) {
        await recordAppointmentFromBooking({
          businessConfig,
          platform: "messenger",
          userId: chatId,
          name: contact.name,
          phone: contact.phone,
          service: pending.service,
          dateTime: pending.dateTime,
          durationMinutes: pending.durationMinutes
        });
        await clearPendingBooking(chatId);
        await notifyAdminAboutBooking(businessConfig, "Messenger", businessConfig.businessName || businessConfig.business_name || "business", contact.name, contact.phone, pending.dateTime);

        const bookedText = formatBookingSavedMessage(detectedLang, contact.name, pending.service, pending.dateTime);
        await sendMessengerMessage(senderId, bookedText, businessConfig);
        await postProcessMessage(chatId, platform, textMessage, bookedText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
        return;
      }

      console.error("[DeterministicBooking] Messenger calendar insert failed:", JSON.stringify(adapterRes));
      const failText = detectedLang === "sv"
        ? "Ursäkta, jag kunde inte slutföra bokningen just nu. Försök gärna igen om en liten stund."
        : getErrorMessageByLanguage(detectedLang);
      await sendMessengerMessage(senderId, failText, businessConfig);
      await postProcessMessage(chatId, platform, textMessage, failText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }
  } catch (bookingFallbackErr) {
    console.error("[DeterministicBooking] Messenger fallback crashed:", bookingFallbackErr);
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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, after an available slot is confirmed, ask for name and mobile number; do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. If the latest customer message is English, reply in English. If it is Swedish, reply in Swedish. If it is Persian, German, Spanish, or Arabic, reply in that same language. Never default to Swedish just because the business is in Sweden.
`;

    const swedenDate = new Date().toLocaleDateString("en-US", {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;

    let finalSystemInstruction = (businessConfig.systemPrompt || "") + currentDateContext + constraint + languageEngine + buildLanguageLockInstruction(userLanguage);

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
      console.log("[MessengerTools] functionCalls:", JSON.stringify(chatResponse.functionCalls.map((c: any) => ({ name: c.function?.name, arguments: c.function?.arguments }))));
      maxTurns--;
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: chatResponse.functionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(chatResponse.functionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === "checkSlots" && args) {
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(textMessage || ""));
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split("\n")
              .filter((s: string) => s.trim().length > 0 && !s.includes("No available slots"));

            const requestedTime = args.requestedTime || inferRequestedTimeFromText(textMessage || "");
            const exactIso = getExactSlotIso(slotsArray, requestedTime);
            if (requestedTime && exactIso && isExactRequestedSlotAvailable(slotsArray, requestedTime)) {
              const newPending = {
                businessConfig,
                platform: "messenger",
                service: args.service || inferServiceFromText(textMessage || ""),
                dateTime: exactIso,
                durationMinutes: Number(args.durationMinutes || 60),
                status: "awaiting_confirmation"
              };
              await savePendingBooking(chatId, "messenger", newPending);
              console.log(`[DeterministicBooking] Pending Messenger booking saved: ${JSON.stringify({ chatId, service: newPending.service, dateTime: exactIso, durationMinutes: newPending.durationMinutes, business_id: getBusinessIdFromConfig(businessConfig) })}`);
            }

            const replyMessage = formatSwedishTimeSlots(slotsArray, requestedTime, getConversationLanguage(chatId, textMessage || ""));
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig,
              platform: "messenger",
              userId: chatId,
              name: args.name,
              phone: args.phone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
          }

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
      await postProcessMessage(chatId, platform, userMessageForLog, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
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
Reply in the active conversation language injected by the server and in the same language as the customer’s latest message.

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
  let userLanguage = getConversationLanguage(chatId, textMessage || "");

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, after an available slot is confirmed, ask for name and mobile number; do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. If the latest customer message is English, reply in English. If it is Swedish, reply in Swedish. If it is Persian, German, Spanish, or Arabic, reply in that same language. Never default to Swedish just because the business is in Sweden.
`;

    const swedenDate = new Date().toLocaleDateString('en-US', {
      timeZone: 'Europe/Stockholm',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const currentDateContext = `\nCrucial Context: The client's current local date and time in Sweden (Europe/Stockholm) is dynamically: ${swedenDate}. Any reference by the user to 'idag', 'imorgon', or days of the week must be evaluated strictly using this dynamic date as the anchor. Note that for YYYY-MM-DD tools, June is '06' (index 5 in Javascript Date).`;

    let finalSystemInstruction = (businessConfig.systemPrompt || '') + currentDateContext + constraint + languageEngine + buildLanguageLockInstruction(userLanguage);

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
          adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(textMessage || ""));
          if (adapterRes.available_slots_string) {
            const slotsArray = adapterRes.available_slots_string
              .split('\n')
              .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));

            const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(textMessage || ""), getConversationLanguage(chatId, textMessage || ""));
            return { TERMINATE_EARLY: true, replyMessage };
          }
        } else if (call.function.name === 'insertAppointment' && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig,
              platform: "instagram",
              userId: chatId,
              name: args.name,
              phone: args.phone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
          }
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
  await postProcessMessage(chatId, platform, userMessageForLog, textResponse, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
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

      // Facebook Page comments may arrive on the same Page webhook as Messenger.
      // This makes /webhook/messenger work for both Messenger messages and Facebook comments.
      for (const change of entry.changes || []) {
        if (change.field === "feed" || change.field === "comments" || change.field === "live_comments") {
          processMetaCommentUpdate(entry, change, activeConfig, "facebook").catch(e =>
            console.error("Facebook comment messenger route error:", e)
          );
        }
      }
    }
  });

  app.get("/webhook/facebook", (req, res) => {
    const verifyToken = process.env.FACEBOOK_VERIFY_TOKEN || process.env.MESSENGER_VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN;

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken) {
      console.log("WEBHOOK_FACEBOOK_VERIFIED");
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  app.post("/webhook/facebook", async (req, res) => {
    const body = req.body;

    if (body.object !== "page") {
      return res.sendStatus(404);
    }

    res.status(200).send("EVENT_RECEIVED");

    console.log("========== FACEBOOK WEBHOOK /webhook/facebook ==========");
    console.log(JSON.stringify(body, null, 2));

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "feed" || change.field === "comments" || change.field === "live_comments") {
          processMetaCommentUpdate(entry, change, activeConfig, "facebook").catch(e =>
            console.error("Facebook comment route error:", e)
          );
        }
      }

      // Keep Messenger support here too in case Meta sends messaging events to this callback URL.
      for (const webhookEvent of entry.messaging || []) {
        processMessengerUpdate(webhookEvent, activeConfig).catch(e =>
          console.error("Messenger event on facebook route error:", e)
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

  console.log("========== INSTAGRAM WEBHOOK /webhook/instagram ==========");
  console.log(JSON.stringify(body, null, 2));

  if (body.entry) {
    for (const entry of body.entry) {
      if (entry.messaging) {
        for (const webhook_event of entry.messaging) {
          processInstagramUpdate(webhook_event, activeConfig).catch(e =>
            console.error("IG webhook instagram route error:", e)
          );
        }
      }

      // Instagram comment events from Meta arrive here as entry.changes.
      // Meta sample structure:
      // change.field === "comments"
      // change.value.id = comment id
      // change.value.text = comment text
      // change.value.media.id = post/media id
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === "comments" || change.field === "live_comments") {
            processMetaCommentUpdate(entry, change, activeConfig, "instagram").catch(e =>
              console.error("IG comment instagram route error:", e)
            );
          }
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
const userLanguage = getConversationLanguage(chatId, userText);

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, after an available slot is confirmed, ask for name and mobile number; do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. If the latest customer message is English, reply in English. If it is Swedish, reply in Swedish. If it is Persian, German, Spanish, or Arabic, reply in that same language. Never default to Swedish just because the business is in Sweden.
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
  languageEngine +
  buildLanguageLockInstruction(userLanguage);
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
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(userText || ""));
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\n')
                    .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(userText || ""), getConversationLanguage(chatId, userText || ""));
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
          else if (call.function.name === "insertAppointment" && args) {
          adapterRes = await adapter.insertAppointment(args.name, args.phone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig: activeConfig,
              platform: "web",
              userId: chatId.toString(),
              name: args.name,
              phone: args.phone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
          }
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
