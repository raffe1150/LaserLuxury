
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

// Simple in-process AI request queue. This prevents too many simultaneous Gemini calls
// when many customers message different businesses at the same time.
const MAX_CONCURRENT_AI_REQUESTS = Number(process.env.MAX_CONCURRENT_AI_REQUESTS || 3);
let activeAiRequests = 0;
const aiRequestQueue: Array<() => void> = [];

async function runWithAiQueue<T>(job: () => Promise<T>): Promise<T> {
  if (activeAiRequests >= MAX_CONCURRENT_AI_REQUESTS) {
    await new Promise<void>((resolve) => aiRequestQueue.push(resolve));
  }

  activeAiRequests++;
  try {
    return await job();
  } finally {
    activeAiRequests = Math.max(0, activeAiRequests - 1);
    const next = aiRequestQueue.shift();
    if (next) next();
  }
}

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
       response = await runWithAiQueue(() => activeAi.models.generateContent(params));
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
    const canonicalPlatform = normalizePlatformName(platform);
    const canonicalUserId = normalizePlatformUserId(canonicalPlatform, chatId.toString());

    const payload = [
  {
    user_id: canonicalUserId,
    platform: canonicalPlatform,
    sender: "user",
    message: userMessage,
    business_id: businessId || null,
    is_read: false
  },
  {
    user_id: canonicalUserId,
    platform: canonicalPlatform,
    sender: "bot",
    message: agentResponse,
    business_id: businessId || null,
    is_read: true
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
  const raw = String(text).trim().toLowerCase();

  // Prefer explicit clock words so phone numbers like 0738... are not mistaken for times.
  const patterns = [
    /(?:kl|klockan|clock|saat|saate|hora|las|at)\s*[\.:]?\s*(\d{1,2})(?:[\.:](\d{2}))?/i,
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

  // Accept a bare hour only when the wording clearly indicates slot selection.
  // Examples: "13 det går bra", "14 passar mig", "saat 13 khube".
  const bareHour = raw.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  if (
    bareHour &&
    /\b(passar|går bra|gar bra|funkar|fungerar|är bra|ar bra|khube|khob|ok|okej|works|good|fine| مناسب|خوبه|باشه)\b/i.test(raw)
  ) {
    const hour = Number(bareHour[1]);
    if (hour >= 0 && hour <= 23) {
      return `${String(hour).padStart(2, "0")}:00`;
    }
  }

  return null;
}

function parseSlotIso(slot: string): string | null {
  const match = slot.match(/\(ISO:\s(.*?)\)/);
  return match?.[1] || null;
}

function getStockholmTimeFromIso(dateTime?: string): string | null {
  const raw = String(dateTime || "").trim();
  if (!raw) return null;

  const date = new Date(ensureStockholmOffset(raw));
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit"
  });
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
      yes: (d: string, t: string) => `Ja, ${d} um ${t} Uhr ist verfügbar. Möchten Sie den Termin buchen?`,
      none: "Leider habe ich für diesen Zeitraum keine freien Zeiten gefunden. Haben Sie ein anderes Datum im Sinn? 😊",
      busyNone: (t: string) => `Leider ist ${t} Uhr nicht verfügbar und ich habe keine anderen freien Zeiten gefunden. Haben Sie ein anderes Datum im Sinn? 😊`,
      busyAlternatives: (t: string, slots: string) => `Leider ist ${t} Uhr nicht verfügbar. Ich habe diese freien Zeiten gefunden: ${slots}. Welche passt Ihnen am besten? 😊`,
      found: (slots: string) => `Ich habe diese freien Zeiten gefunden: ${slots}. Welche passt Ihnen am besten? 😊`,
      at: "um", and: "und", also: "sowie"
    },
    ar: {
      months: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
      days: ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
      yes: (d: string, t: string) => `نعم، ${d} الساعة ${t} متاح. هل تريد أن أحجزه لك؟`,
      none: "للأسف لم أجد مواعيد متاحة في هذه الفترة. هل لديك تاريخ آخر؟ 😊",
      busyNone: (t: string) => `للأسف الساعة ${t} غير متاحة ولم أجد مواعيد أخرى. هل لديك تاريخ آخر؟ 😊`,
      busyAlternatives: (t: string, slots: string) => `للأسف الساعة ${t} غير متاحة. هذه المواعيد متاحة: ${slots}. أي وقت يناسبك؟ 😊`,
      found: (slots: string) => `هذه المواعيد متاحة: ${slots}. أي وقت يناسبك؟ 😊`,
      at: "الساعة", and: "و", also: "وأيضًا"
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
  const normalizedRequestedTime = normalizeRequestedTime(requestedTime || "");
  const endString = endDateStr || startDateStr;

  // ClinicPilot availability window.
  // Keep this dynamic later from the business dashboard/businesses table.
  const BUSINESS_OPEN_MINUTES = 9 * 60;
  const BUSINESS_CLOSE_MINUTES = 20 * 60;

  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false });
  const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'long' });

  const makeSlot = (dStr: string, hour: number, minute: number) => {
    const isoString = `${dStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${getStockholmUtcOffset(dStr)}`;
    const slotD = new Date(isoString);
    let weekday = dayFormatter.format(slotD);
    weekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return {
      isoString,
      slotD,
      totalMin: hour * 60 + minute,
      label: `${weekday} kl ${formatter.format(slotD)} (ISO: ${isoString})`
    };
  };

  const parseDateUtc = (dateStr: string) => {
    const parts = dateStr.split('-');
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  };

  const getAllFreeCandidates = () => {
    const candidates: Array<{ isoString: string; slotD: Date; totalMin: number; label: string; dayIndex: number }> = [];
    const startD = parseDateUtc(startDateStr);
    const endD = parseDateUtc(endString);

    let dayIndex = 0;
    for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1), dayIndex++) {
      // Do not suggest weekends unless the business later explicitly enables them.
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const dStr = `${y}-${m}-${day}`;

      // Alternative slots every 15 minutes, but every candidate is still checked against
      // real calendar events. Nothing is suggested without isSlotFree() returning true.
      for (let totalMin = BUSINESS_OPEN_MINUTES; totalMin <= BUSINESS_CLOSE_MINUTES - 15; totalMin += 15) {
        const endTotal = totalMin + durationMinutes;
        if (endTotal > BUSINESS_CLOSE_MINUTES) continue;

        const h = Math.floor(totalMin / 60);
        const min = totalMin % 60;
        const slot = makeSlot(dStr, h, min);
        if (isSlotFree(slot.slotD.getTime(), durationMinutes, events)) {
          candidates.push({ ...slot, dayIndex });
        }
      }
    }
    return candidates;
  };

  const allCandidates = getAllFreeCandidates();

  // If the customer requested an exact time, that exact time must win if it is actually free.
  if (normalizedRequestedTime) {
    const [reqH, reqM] = normalizedRequestedTime.split(':').map(Number);
    const reqTotal = reqH * 60 + reqM;
    const exact = allCandidates.find(c => c.totalMin === reqTotal);
    if (exact) return exact.label;

    // If exact time is busy, do NOT fall back to the first morning slots.
    // Offer closest real free slots around the requested time instead.
    const alternatives = allCandidates
      .map(c => ({ ...c, score: Math.abs(c.totalMin - reqTotal) + c.dayIndex * 1000 }))
      .sort((a, b) => a.score - b.score || a.slotD.getTime() - b.slotD.getTime())
      .slice(0, 3)
      .map(c => c.label);

    if (alternatives.length === 0) return "No available slots found for this period.";
    return alternatives.join("\n");
  }

  // If no exact time was requested, do not always suggest 09:00/09:15/09:30.
  // Suggest more human-friendly times first, while still only returning slots that are actually free.
  const preferredMinutes = [
    14 * 60,        // 14:00
    14 * 60 + 30,   // 14:30
    15 * 60,        // 15:00
    13 * 60,        // 13:00
    16 * 60,        // 16:00
    12 * 60 + 30,   // 12:30
    11 * 60,        // 11:00
    17 * 60,        // 17:00
    10 * 60,        // 10:00
    18 * 60,        // 18:00
    9 * 60          // 09:00, only as a later fallback
  ];

  const ranked = allCandidates
    .map(c => {
      const preferenceScore = Math.min(...preferredMinutes.map((p, i) => Math.abs(c.totalMin - p) + i * 20));
      return { ...c, score: preferenceScore + c.dayIndex * 1000 };
    })
    .sort((a, b) => a.score - b.score || a.slotD.getTime() - b.slotD.getTime())
    .slice(0, 3)
    .map(c => c.label);

  if (ranked.length === 0) return "No available slots found for this period.";
  return ranked.join("\n");
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
      const rawDateTime = String(dateTime || "").trim();
      if (!rawDateTime) {
        console.error("Google Calendar insertAppointment blocked: missing dateTime", {
          name,
          phone,
          service,
          chatId
        });
        return { success: false, code: "MISSING_DATETIME", message: "Booking date and time are missing." };
      }

      // Container runs in UTC, so parsing "T15:00:00" assumes UTC, which is 17:00 in Sweden.
      // We explicitly append Europe/Stockholm offset if not provided.
      const safeDateTime = ensureStockholmOffset(rawDateTime);
      const startTime = new Date(safeDateTime);

      if (Number.isNaN(startTime.getTime())) {
        console.error("Google Calendar insertAppointment blocked: invalid dateTime", {
          rawDateTime,
          safeDateTime,
          name,
          phone,
          service,
          chatId
        });
        return { success: false, code: "INVALID_DATETIME", message: "Booking date and time are invalid." };
      }

      const safeDuration = Number(durationMinutes);
      if (!Number.isFinite(safeDuration) || safeDuration <= 0) {
        return { success: false, code: "INVALID_DURATION", message: "Booking duration is invalid." };
      }

      const endTime = new Date(startTime.getTime() + safeDuration * 60 * 1000);

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


function normalizeLookupText(value?: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}+]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLookupDigits(value?: string): string {
  return String(value || "").replace(/\D/g, "");
}

function stockholmDateString(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDaysToStockholmDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getEventStartIso(event: any): string {
  return String(event?.start?.dateTime || event?.start?.date || event?.startTime || "");
}

function getEventEndIso(event: any): string {
  return String(event?.end?.dateTime || event?.end?.date || event?.endTime || "");
}

function eventMatchesCustomer(event: any, identifiers: {
  customerId?: string;
  phone?: string;
  name?: string;
}): boolean {
  const summary = String(event?.summary || event?.title || "");
  const description = String(event?.description || "");
  const location = String(event?.location || "");
  const attendees = Array.isArray(event?.attendees)
    ? event.attendees.map((item: any) => `${item?.displayName || ""} ${item?.email || ""}`).join(" ")
    : "";

  const haystackRaw = `${summary} ${description} ${location} ${attendees}`;
  const haystack = normalizeLookupText(haystackRaw);
  const haystackDigits = normalizeLookupDigits(haystackRaw);

  const rawCustomerId = String(identifiers.customerId || "").trim();
  const rawPhone = String(identifiers.phone || "").trim();
  const normalizedName = normalizeLookupText(identifiers.name);

  const digitCandidates = [
    normalizeLookupDigits(rawCustomerId),
    normalizeLookupDigits(rawPhone)
  ].filter((value) => value.length >= 7);

  if (digitCandidates.some((digits) => haystackDigits.includes(digits))) return true;

  // Channel IDs are written into event descriptions as TelegramChatId for legacy reasons,
  // even when the source is WhatsApp, Messenger, Instagram or web.
  if (rawCustomerId && haystack.includes(normalizeLookupText(rawCustomerId))) return true;

  if (normalizedName && normalizedName.length >= 2 && haystack.includes(normalizedName)) return true;

  return false;
}

async function findCustomerAppointments(
  adapter: CalendarAdapter,
  args: any,
  customerId: string,
  platform: string
) {
  const today = stockholmDateString(new Date());
  const startDate = String(args?.startDate || today);
  const endDate = String(args?.endDate || addDaysToStockholmDate(startDate, 180));
  const phone = String(args?.phone || "");
  const name = String(args?.name || "");

  const events = await adapter.getEvents(startDate, endDate);
  const now = Date.now();

  const appointments = (Array.isArray(events) ? events : [])
    .filter((event: any) => {
      const startIso = getEventStartIso(event);
      const startMs = new Date(startIso).getTime();
      if (!startIso || Number.isNaN(startMs) || startMs < now) return false;
      if (String(event?.status || "").toLowerCase() === "cancelled") return false;
      if (isLikelyWorkingHoursMarker(event)) return false;
      return eventMatchesCustomer(event, { customerId, phone, name });
    })
    .sort((a: any, b: any) =>
      new Date(getEventStartIso(a)).getTime() - new Date(getEventStartIso(b)).getTime()
    )
    .slice(0, 5)
    .map((event: any) => ({
      id: event?.id || null,
      summary: String(event?.summary || event?.title || "Appointment"),
      description: String(event?.description || ""),
      start: getEventStartIso(event),
      end: getEventEndIso(event),
      platform
    }));

  const hasReliableIdentity =
    normalizeLookupDigits(phone).length >= 7 ||
    normalizeLookupDigits(customerId).length >= 7 ||
    normalizeLookupText(name).length >= 2 ||
    String(customerId || "").trim().length >= 5;

  return {
    success: true,
    found: appointments.length > 0,
    needsContactDetails: appointments.length === 0 && !hasReliableIdentity,
    searchedFrom: startDate,
    searchedTo: endDate,
    appointments
  };
}

function formatAppointmentLookupReply(result: any, language: string = "en"): string {
  const lang = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";

  if (result?.needsContactDetails) {
    const ask: Record<string, string> = {
      sv: "Jag kan kontrollera det åt dig. Skicka namnet eller mobilnumret som bokningen gjordes med. 📅",
      fa: "می‌توانم بررسی کنم. لطفاً نام یا شماره موبایلی را که رزرو با آن انجام شده بفرستید. 📅",
      de: "Ich kann das prüfen. Bitte senden Sie den Namen oder die Mobilnummer, unter der gebucht wurde. 📅",
      es: "Puedo comprobarlo. Envíame el nombre o número de móvil usado para la reserva. 📅",
      ar: "يمكنني التحقق. أرسل الاسم أو رقم الهاتف المستخدم في الحجز. 📅",
      en: "I can check that. Please send the name or mobile number used for the booking. 📅"
    };
    return ask[lang];
  }

  if (!result?.found || !Array.isArray(result?.appointments) || result.appointments.length === 0) {
    const none: Record<string, string> = {
      sv: "Jag hittade ingen kommande bokning kopplad till dina uppgifter. Vill du att jag söker med ett annat namn eller mobilnummer? 📅",
      fa: "هیچ رزرو آینده‌ای مرتبط با اطلاعات شما پیدا نکردم. می‌خواهید با نام یا شماره موبایل دیگری بررسی کنم؟ 📅",
      de: "Ich habe keine kommende Buchung zu Ihren Angaben gefunden. Soll ich mit einem anderen Namen oder einer anderen Mobilnummer suchen? 📅",
      es: "No encontré ninguna reserva próxima asociada a tus datos. ¿Quieres que busque con otro nombre o número? 📅",
      ar: "لم أجد حجزًا قادمًا مرتبطًا ببياناتك. هل تريد أن أبحث باسم أو رقم آخر؟ 📅",
      en: "I couldn’t find an upcoming booking linked to your details. Would you like me to check another name or mobile number? 📅"
    };
    return none[lang];
  }

  const localeMap: Record<string, string> = {
    sv: "sv-SE",
    fa: "fa-IR",
    de: "de-DE",
    es: "es-ES",
    ar: "ar",
    en: "en-GB"
  };

  const formatted = result.appointments.slice(0, 3).map((appointment: any) => {
    const date = new Date(appointment.start);
    return new Intl.DateTimeFormat(localeMap[lang], {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  });

  const joined = formatted.join(", ");
  const found: Record<string, string> = {
    sv: `Ja, jag hittade din bokning: ${joined}. 📅`,
    fa: `بله، رزرو شما را پیدا کردم: ${joined}. 📅`,
    de: `Ja, ich habe Ihre Buchung gefunden: ${joined}. 📅`,
    es: `Sí, encontré tu reserva: ${joined}. 📅`,
    ar: `نعم، وجدت حجزك: ${joined}. 📅`,
    en: `Yes, I found your booking: ${joined}. 📅`
  };
  return found[lang];
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
      name: "findCustomerAppointments",
      description: "Looks up the current customer's existing future appointment(s). MUST be used when the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they have an appointment. Do not escalate these requests to a human before using this tool. The server automatically uses the current channel identity; pass phone or name only when the customer explicitly provides them.",
      parameters: {
        type: "OBJECT",
        properties: {
          startDate: { type: "STRING", description: "Optional start date in YYYY-MM-DD. Use the relevant date when the customer mentions today, tomorrow, next week, or a specific day." },
          endDate: { type: "STRING", description: "Optional end date in YYYY-MM-DD. If omitted, the server searches future appointments for the next 180 days." },
          phone: { type: "STRING", description: "Customer phone number only if explicitly provided in the conversation." },
          name: { type: "STRING", description: "Customer name only if explicitly provided in the conversation." }
        }
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

// Daily customer message limit. One counter per business + platform + customer + Stockholm date.
const DAILY_CUSTOMER_MESSAGE_LIMIT = Number(process.env.DAILY_CUSTOMER_MESSAGE_LIMIT || 15);

function getStockholmUsageDate(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function formatDailyLimitMessage(language: string = 'en'): string {
  if (language === 'sv') return 'Dagens samtalsgräns är nådd 😊 Skriv gärna igen imorgon så hjälper vi dig vidare.';
  if (language === 'fa') return 'ظرفیت گفتگوی امروز شما پر شده است 😊 لطفاً فردا دوباره پیام بدهید تا ادامه بدهیم.';
  if (language === 'de') return 'Das heutige Gesprächslimit ist erreicht 😊 Schreiben Sie uns bitte morgen wieder, dann helfen wir Ihnen weiter.';
  if (language === 'es') return 'El límite de conversación de hoy se ha alcanzado 😊 Escríbenos de nuevo mañana y seguimos ayudándote.';
  if (language === 'ar') return 'تم الوصول إلى حد المحادثة لهذا اليوم 😊 يرجى مراسلتنا غدًا وسنكمل مساعدتك.';
  return 'Today’s chat limit has been reached 😊 Please message us again tomorrow and we’ll continue helping you.';
}

async function checkAndIncrementDailyUsage(params: { businessId?: string | number | null; platform: string; userId: string; language?: string; limit?: number; }) {
  const limit = Number(params.limit || DAILY_CUSTOMER_MESSAGE_LIMIT || 15);
  const businessId = params.businessId ? String(params.businessId) : '0';
  const platform = String(params.platform || 'unknown');
  const userId = String(params.userId || 'unknown');
  const usageDate = getStockholmUsageDate();

  if (!supabase) {
    return { allowed: true, count: 0, limit, reason: 'supabase_not_configured' };
  }

  try {
    const { data, error } = await supabase
      .from('message_usage')
      .select('id,message_count')
      .eq('business_id', businessId)
      .eq('platform', platform)
      .eq('user_id', userId)
      .eq('usage_date', usageDate)
      .maybeSingle();

    if (error) {
      console.error('[UsageLimit] lookup error. Allowing message so production does not break:', JSON.stringify(error));
      return { allowed: true, count: 0, limit, reason: 'lookup_error' };
    }

    const currentCount = Number(data?.message_count || 0);
    if (currentCount >= limit) {
      console.log(`[UsageLimit] blocked business=${businessId}, platform=${platform}, user=${userId}, date=${usageDate}, count=${currentCount}, limit=${limit}`);
      return { allowed: false, count: currentCount, limit, reason: 'limit_reached' };
    }

    if (data?.id) {
      const { error: updateError } = await supabase
        .from('message_usage')
        .update({ message_count: currentCount + 1, updated_at: new Date().toISOString() })
        .eq('id', data.id);
      if (updateError) console.error('[UsageLimit] update error:', JSON.stringify(updateError));
      return { allowed: true, count: currentCount + 1, limit };
    }

    const { error: insertError } = await supabase.from('message_usage').insert([{
      business_id: businessId,
      platform,
      user_id: userId,
      usage_date: usageDate,
      message_count: 1
    }]);
    if (insertError) console.error('[UsageLimit] insert error:', JSON.stringify(insertError));
    return { allowed: true, count: 1, limit };
  } catch (err) {
    console.error('[UsageLimit] crashed. Allowing message so production does not break:', err);
    return { allowed: true, count: 0, limit, reason: 'crashed' };
  }
}

const pendingBookings: Record<string, any> = {};
const recentlyCompletedBookings: Record<string, { completedAt: number; language: string; name?: string }> = {};

// Pending bookings must be short-lived. Otherwise a customer can start a new request
// and accidentally finalize an old slot from a previous test/conversation.
const PENDING_BOOKING_TTL_MS = Number(process.env.PENDING_BOOKING_TTL_MINUTES || 45) * 60 * 1000;

function isPendingBookingExpired(pending: any): boolean {
  const createdAt = Number(pending?.createdAt || pending?.created_at || 0);
  if (!createdAt) return false;
  return Date.now() - createdAt > PENDING_BOOKING_TTL_MS;
}

function isNewBookingRequestText(text?: string): boolean {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return false;
  if (extractNameAndPhone(raw)) return false;
  if (isThanksOnlyText(raw) || isAffirmativeBookingText(raw) || isAmbiguousShortReply(raw)) return false;

  const hasBookingWord = /\b(boka|bokning|tid|appointment|book|booking|termin|cita|reservar|موعد|حجز|vaght|وقت)\b/i.test(lower);
  const hasServiceWord = /\b(helkropp|full\s*body|fullbody|bikini|laser|manikyr|pedikyr|pedicure|manicure|behandling|treatment|ganzk[oö]rper|tratamiento|علاج|جلسة)\b/i.test(lower);
  const hasDateWord = /\b(nästa|nasta|tisdag|måndag|onsdag|torsdag|fredag|lördag|söndag|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|miércoles|martes|jueves|viernes|1shanbe|2shanbe|3shanbe|4shanbe|5shanbe|6shanbe|doshanbe|seshanbe|chaharshanbe|panjshanbe|jome|دوشنبه|سه\s*شنبه|چهارشنبه|پنجشنبه|الثلاثاء|الخميس)\b/i.test(lower);
  return (hasBookingWord && (hasServiceWord || hasDateWord)) || (hasServiceWord && hasDateWord);
}

function inferServiceFromRecentContext(currentText: string, history: any[] = []): string {
  const recent = history
    .slice(-8)
    .map((m: any) => typeof m.content === "string" ? m.content : "")
    .join(" ");
  return inferServiceFromText(`${recent} ${currentText || ""}`);
}

function rememberCompletedBooking(chatId: string, language: string, name?: string) {
  recentlyCompletedBookings[chatId] = { completedAt: Date.now(), language, name };
}

function getRecentCompletedBooking(chatId: string) {
  const item = recentlyCompletedBookings[chatId];
  if (!item) return null;
  // Keep this short: it is only used so a post-booking “thanks/merci/tack” does not restart booking.
  if (Date.now() - item.completedAt > 30 * 60 * 1000) {
    delete recentlyCompletedBookings[chatId];
    return null;
  }
  return item;
}

function inferServiceFromText(text?: string): string {
  const raw = String(text || "").toLowerCase();

  const compactService = raw
    .normalize("NFKD")
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "");

  if (
    /\b(konsultation|consultation|consulting|consult|konsultasjon|konsultasion|konsiltation|konstitution|knstilution|konstlution|konstultion|konslutation|moshavere|moshavereh|mashavere|mashavereh|مشاوره)\b/i.test(raw) ||
    /^(?:kons|cons|konst|knst).*(?:ult|lult|lut).*(?:ation|tion|ion)?$/i.test(compactService) ||
    /^m[ao]sh?aver(?:e|eh)?$/i.test(compactService)
  ) return "Konsultation";

  if (raw.includes("bikini")) return "Bikinilinjebehandling";
  if (raw.includes("helkropp") || raw.includes("hel kropp") || raw.includes("full body") || raw.includes("fullbody") || raw.includes("full-body") || raw.includes("hellkropp") || raw.includes("helkrop")) return "Helkropp laserbehandling";
  if (raw.includes("laser")) return "Laserbehandling";
  if (raw.includes("ansikte")) return "Ansiktsbehandling";
  if (raw.includes("ben")) return "Benbehandling";
  if (raw.includes("arm")) return "Armbehandling";
  return "Bokning";
}

function isAffirmativeBookingText(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  // Important: pure thanks words (tack, tusen tack, merci, mersi, thanks) must NOT restart booking.
  if (isThanksOnlyText(raw)) return false;
  return /\b(ja|japp|yes|yep|ok|okej|absolut|boka|boka den|gör det|ja tack|bale|baleh|are|آره|بله|باشه|حتما|حتماً)\b/i.test(raw);
}

function isThanksOnlyText(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  const compact = raw.replace(/[!?.،,؛\s]+/g, " ").trim();
  return /^(tack|tusen tack|tack så mycket|thanks|thank you|merci|mersi|mamnoon|mamnun|sepas|sepas gozar|sepas gozaram|مرسی|ممنون|سپاس|تشکر)$/.test(compact);
}


function isGreetingOnlyText(text?: string): boolean {
  const raw = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.،,؛]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return false;

  return /^(hej|hejsan|hallå|halla|hello|hi|hey|salam|salaam|slm|سلام|درود|god morgon|god kväll|god kvall|good morning|good evening|khob hastin|khoobi|خوب هستین|خوبی)$/.test(raw);
}

function getDefaultBookingServiceForBusiness(config: any): string | null {
  const explicit = String(
    config?.defaultBookingService ||
    config?.default_booking_service ||
    ""
  ).trim();

  if (explicit) return normalizeBookingService(explicit, explicit);

  const businessName = String(
    config?.businessName ||
    config?.business_name ||
    ""
  ).toLowerCase();

  // AdMotion Studio currently offers one bookable meeting type.
  if (businessName.includes("admotion")) return "Konsultation";

  return null;
}

function getDefaultBookingDurationForService(service?: string): number | null {
  return normalizeBookingService(service, service) === "Konsultation" ? 30 : null;
}

function formatThanksReply(language: string = "en", name?: string): string {
  if (language === "fa") return name ? `خواهش می‌کنم ${name} جان! روز خوبی داشته باشید 😊` : "خواهش می‌کنم! روز خوبی داشته باشید 😊";
  if (language === "sv") return name ? `Varsågod ${name}! Ha en fin dag 😊` : "Varsågod! Ha en fin dag 😊";
  if (language === "de") return name ? `Sehr gern, ${name}! Ich wünsche Ihnen einen schönen Tag 😊` : "Sehr gern! Ich wünsche Ihnen einen schönen Tag 😊";
  if (language === "es") return name ? `De nada, ${name}. Que tengas un buen día 😊` : "De nada. Que tengas un buen día 😊";
  if (language === "ar") return name ? `على الرحب والسعة ${name}! أتمنى لك يومًا جميلًا 😊` : "على الرحب والسعة! أتمنى لك يومًا جميلًا 😊";
  return name ? `You're welcome, ${name}! Have a lovely day 😊` : "You're welcome! Have a lovely day 😊";
}

function appendLocalHistory(chatId: string, userMessage: string, botMessage: string) {
  if (!chatSessions[chatId]) chatSessions[chatId] = [];
  chatSessions[chatId].push({ role: "user", content: userMessage || "" });
  chatSessions[chatId].push({ role: "assistant", content: botMessage || "" });
}

function cleanCustomerNameCandidate(candidate?: string): string {
  let s = String(candidate || "").trim();
  if (!s) return "";

  s = s
    .replace(/^[\s:,\-.؛،]+|[\s:,\-.؛،]+$/g, "")
    .replace(/\b(och|and|und|y|و|va)\b.*$/i, " ")
    .replace(/\b(my|mein|meine|mitt|min|mi|esme|esm|esmam|namn|name|nombre|نام|اسم)\b/ig, " ")
    .replace(/\b(is|ist|är|hast|hastam|am|is)\b/ig, " ")
    .replace(/\b(phone|telefon|telephone|telefonam|telefonnummer|number|nummer|numret|shomare|shomaram|mobile|mobil|mobilesh)\b.*$/ig, " ")
    .replace(/(?:^|\s)(?:و?رقم(?:ي)?|و?هاتفي|و?الهاتف|و?الجوال|هاتف(?:ي)?|رقم(?:ي)?|المحمول)\b.*$/u, " ")
    .replace(/[0-9+()\-]/g, " ")
    .replace(/[,:;.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stop = new Set([
    "mitt","min","namn","name","mein","meine","nombre","är","ist","is","hast","hastam","man","my",
    "telefon","telefonam","phone","nummer","number","shomare","shomaram","mobile","mobil","och","and","und","va","اسمي","إسمي","انا","أنا","رقمي","هاتفي","الهاتف","الجوال","هو"
  ]);

  const words = s
    .split(" ")
    .map(w => w.trim())
    .filter(Boolean)
    .filter(w => /^[A-Za-zÅÄÖåäöÉéÜüÖöÄäÁáÍíÓóÚúÑñÇçŞşĞğ'\-\u0600-\u06FF]+$/.test(w))
    .filter(w => !stop.has(w.toLowerCase()));

  return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").trim();
}

function extractNameAndPhone(text?: string): { name: string; phone: string } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const phoneMatch = raw.match(/(?:\+?\d[\d\s\-()]{6,}\d)/);
  if (!phoneMatch) return null;

  const phone = phoneMatch[0].replace(/[^\d+]/g, "");
  if (phone.replace(/\D/g, "").length < 7) return null;

  const beforePhone = raw.slice(0, phoneMatch.index).trim();

  // Strong pattern extraction, in priority order. This avoids names like
  // "shumare ham" or "meine ist" being saved from contact phrases.
  const patterns: RegExp[] = [
    /(?:mitt\s+namn\s+är|jag\s+heter)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:my\s+name\s+is|name\s+is)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:mein\s+name\s+ist|ich\s+hei(?:ß|ss)e)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:mi\s+nombre\s+es|me\s+llamo)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,})?)/i,
    /(?:esme?\s+man|esmam|namam|name\s+man)\s+(?:hast|e|ast)?\s*([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:نام(?:م)?|اسم(?:م)?)\s+([\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,})?)/u,
    /(?:اسمي|إسمي|انا اسمي|أنا اسمي|الاسم)\s+([\u0600-\u06FF]{2,})(?=\s+(?:و|ورقم|وهاتفي|رقمي|هاتفي|هو)|\s*$)/u
  ];

  for (const pattern of patterns) {
    const match = beforePhone.match(pattern) || raw.match(pattern);
    if (match?.[1]) {
      const cleaned = cleanCustomerNameCandidate(match[1]);
      if (cleaned) return { name: cleaned, phone };
      if (/[\u0600-\u06FF]/.test(match[1])) return { name: match[1].trim(), phone };
    }
  }

  // Fallback: remove common contact words and use the remaining person-like word before phone.
  const fallback = cleanCustomerNameCandidate(beforePhone);
  if (fallback) return { name: fallback, phone };

  return null;
}


function extractPhoneOnly(text?: string): string | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const match = raw.match(/(?:\+?\d[\d\s\-()]{6,}\d)/);
  if (!match) return null;

  const phone = match[0].replace(/[^\d+]/g, "");
  return phone.replace(/\D/g, "").length >= 7 ? phone : null;
}

function extractNameOnly(text?: string): string | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const patterns: RegExp[] = [
    /(?:mitt\s+namn\s+är|jag\s+heter)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:my\s+name\s+is|name\s+is)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:mein\s+name\s+ist|ich\s+hei(?:ß|ss)e)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:mi\s+nombre\s+es|me\s+llamo)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,})?)/i,
    /(?:esme?\s+man|esmam|namam|name\s+man)\s+(?:hast|ast|e)?\s*([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:نام(?:م)?|اسم(?:م)?)\s+([\u0600-\u06FF]{2,}(?:\s+[\u0600-\u06FF]{2,})?)/u,
    /(?:اسمي|إسمي|انا اسمي|أنا اسمي|الاسم)\s+([\u0600-\u06FF]{2,})(?=\s+(?:و|ورقم|وهاتفي|رقمي|هاتفي|هو)|\s*$)/u
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const cleaned = cleanCustomerNameCandidate(match[1]);
    if (cleaned) return cleaned;
    if (/[\u0600-\u06FF]/.test(match[1])) return match[1].trim();
  }

  // Accept a short standalone person name while collecting contact details.
  if (
    /^[A-Za-zÅÄÖåäöÉéÜüÖöÄäÁáÍíÓóÚúÑñÇçŞşĞğ'\-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄäÁáÍíÓóÚúÑñÇçŞşĞğ'\-]{2,})?$/.test(raw)
  ) {
    const blocked = /^(konsultation|consultation|konsultasion|konstitution|knstilution|konstlution|moshavere|moshavereh|mashavere|bokning|booking|laser|bikini|ja|nej|yes|no|tack|thanks)$/i;
    if (!blocked.test(raw)) {
      return raw
        .split(/\s+/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
    }
  }

  return null;
}

function normalizeBookingService(text?: string, fallback?: string): string {
  const inferred = inferServiceFromText(text);
  if (inferred !== "Bokning") return inferred;

  const existing = String(fallback || "").trim();
  return existing || "Bokning";
}

function getWhatsAppConversationPhone(
  platformName: string,
  recipientUserId: string,
  sessionId?: string
): string | null {
  if (platformName !== "whatsapp") return null;

  const candidates = [recipientUserId, sessionId];
  for (const candidate of candidates) {
    const digits = String(candidate || "").replace(/\D/g, "");
    if (digits.length >= 7) return `+${digits}`;
  }

  return null;
}

function formatMissingBookingDetailsMessage(
  language: string,
  missing: Array<"name" | "phone" | "service">
): string {
  const needsName = missing.includes("name");
  const needsPhone = missing.includes("phone");
  const needsService = missing.includes("service");

  if (language === "fa") {
    if (needsName && needsPhone) return "برای نهایی‌کردن رزرو فقط نام و شماره موبایل‌تان را بفرستید. 😊";
    if (needsName) return "فقط نام‌تان را بفرستید تا رزرو را نهایی کنم. 😊";
    if (needsPhone) return "فقط شماره موبایل‌تان را بفرستید تا رزرو را نهایی کنم. 😊";
    if (needsService) return "لطفاً بفرمایید کدام خدمت را می‌خواهید رزرو کنید. 😊";
  }

  if (language === "en") {
    if (needsName && needsPhone) return "To finish the booking, I only need your name and mobile number. 😊";
    if (needsName) return "I only need your name to finish the booking. 😊";
    if (needsPhone) return "I only need your mobile number to finish the booking. 😊";
    if (needsService) return "Which service would you like to book? 😊";
  }

  if (language === "de") {
    if (needsName && needsPhone) return "Zum Abschluss brauche ich nur Ihren Namen und Ihre Mobilnummer. 😊";
    if (needsName) return "Ich brauche nur noch Ihren Namen. 😊";
    if (needsPhone) return "Ich brauche nur noch Ihre Mobilnummer. 😊";
    if (needsService) return "Welche Behandlung möchten Sie buchen? 😊";
  }

  if (language === "es") {
    if (needsName && needsPhone) return "Para finalizar, solo necesito tu nombre y número de móvil. 😊";
    if (needsName) return "Solo necesito tu nombre para finalizar la reserva. 😊";
    if (needsPhone) return "Solo necesito tu número de móvil para finalizar la reserva. 😊";
    if (needsService) return "¿Qué servicio quieres reservar? 😊";
  }

  if (language === "ar") {
    if (needsName && needsPhone) return "لإتمام الحجز، أحتاج فقط اسمك ورقم هاتفك. 😊";
    if (needsName) return "أحتاج فقط اسمك لإتمام الحجز. 😊";
    if (needsPhone) return "أحتاج فقط رقم هاتفك لإتمام الحجز. 😊";
    if (needsService) return "ما الخدمة التي تريد حجزها؟ 😊";
  }

  if (needsName && needsPhone) return "För att slutföra bokningen behöver jag bara ditt namn och mobilnummer. 😊";
  if (needsName) return "Jag behöver bara ditt namn för att slutföra bokningen. 😊";
  if (needsPhone) return "Jag behöver bara ditt mobilnummer för att slutföra bokningen. 😊";
  if (needsService) return "Vilken tjänst vill du boka? 😊";

  return "Jag har allt jag behöver för att slutföra bokningen. 😊";
}

async function savePendingBooking(chatId: string, platform: string, pending: any) {
  pending.createdAt = pending.createdAt || Date.now();
  pendingBookings[chatId] = pending;
  if (!supabase) return;
  try {
    const minimal = {
      type: "pending_booking",
      platform,
      service: pending.service,
      dateTime: pending.dateTime || null,
      selectedDate: pending.selectedDate || null,
      offeredSlots: Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
      language: pending.language || null,
      customerName: pending.customerName || null,
      customerPhone: pending.customerPhone || null,
      durationMinutes: pending.durationMinutes,
      status: pending.status,
      createdAt: pending.createdAt || Date.now(),
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
  if (pendingBookings[chatId]) {
    if (isPendingBookingExpired(pendingBookings[chatId])) {
      console.log(`[DeterministicBooking] Expired in-memory pending booking cleared. chatId=${chatId}`);
      await clearPendingBooking(chatId);
      return null;
    }
    return pendingBookings[chatId];
  }
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
      dateTime: parsed.dateTime || null,
      selectedDate: parsed.selectedDate || null,
      offeredSlots: Array.isArray(parsed.offeredSlots) ? parsed.offeredSlots : [],
      language: parsed.language || null,
      customerName: parsed.customerName || null,
      customerPhone: parsed.customerPhone || null,
      durationMinutes: Number(parsed.durationMinutes || 60),
      status: parsed.status || "awaiting_contact",
      createdAt: Number(parsed.createdAt || parsed.created_at || 0)
    };
    if (!pending.dateTime && !pending.selectedDate) return null;
    if (isPendingBookingExpired(pending)) {
      console.log(`[DeterministicBooking] Expired DB pending booking cleared. chatId=${chatId}, dateTime=${pending.dateTime}`);
      await clearPendingBooking(chatId);
      return null;
    }
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



function resolveExplicitBookingDate(text?: string): string | null {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const numeric = raw.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](20\d{2}))?\b/);
  if (numeric) {
    const year = Number(numeric[3] || new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Stockholm",
      year: "numeric"
    }).format(new Date()));
    return `${year}-${String(Number(numeric[2])).padStart(2, "0")}-${String(Number(numeric[1])).padStart(2, "0")}`;
  }

  const weekdayMap: Array<[RegExp, number]> = [
    [/\b(söndag|sunday|yekshanbe|1shanbe|یکشنبه)\b/i, 0],
    [/\b(måndag|mandag|monday|doshanbe|2shanbe|دوشنبه)\b/i, 1],
    [/\b(tisdag|tuesday|seshanbe|3shanbe|سه.?شنبه)\b/i, 2],
    [/\b(onsdag|wednesday|chaharshanbe|4shanbe|چهارشنبه)\b/i, 3],
    [/\b(torsdag|thursday|panjshanbe|5shanbe|پنجشنبه)\b/i, 4],
    [/\b(fredag|friday|jome|jomeh|6shanbe|جمعه)\b/i, 5],
    [/\b(lördag|lordag|saturday|shanbe|شنبه)\b/i, 6]
  ];

  const matched = weekdayMap.find(([pattern]) => pattern.test(raw));
  if (!matched) return null;

  const targetDay = matched[1];
  const todayStr = stockholmDateString(new Date());
  const [year, month, day] = todayStr.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(year, month - 1, day));
  const currentDay = todayUtc.getUTCDay();

  let daysAhead = (targetDay - currentDay + 7) % 7;
  if (daysAhead === 0 && !/\b(idag|today|امروز)\b/i.test(raw)) daysAhead = 7;

  todayUtc.setUTCDate(todayUtc.getUTCDate() + daysAhead);
  return todayUtc.toISOString().slice(0, 10);
}

function inferBookingDurationFromContext(text: string, history: any[]): number {
  const combined = [
    ...(history || []).slice(-10).map((item: any) =>
      typeof item?.content === "string" ? item.content : ""
    ),
    text || ""
  ].join(" ").toLowerCase();

  // AdMotion Studio consultations always have a fixed 30-minute duration.
  // This rule intentionally wins over any generic duration question or guessed value.
  if (
    /\b(konsultation|consultation|consulting|consult|konsultasjon|konsultasion|konsiltation|konstitution|knstilution|moshavere|mashavere|مشاوره)\b/i.test(combined)
  ) return 30;

  const minuteMatch = combined.match(/(\d{1,3})\s*(?:min|minuter|minutes|دقیقه)/i);
  if (minuteMatch) {
    const value = Number(minuteMatch[1]);
    if (value >= 10 && value <= 240) return value;
  }

  return 60;
}

function isBookingConversationContext(text: string, history: any[]): boolean {
  const combined = [
    ...(history || []).slice(-10).map((item: any) =>
      typeof item?.content === "string" ? item.content : ""
    ),
    text || ""
  ].join(" ").toLowerCase();

  return /\b(boka|bokning|tid|appointment|book|booking|konsultation|consultation|vaght|رزرو|وقت|مشاوره|moshavere)\b/i.test(combined);
}

function getSlotsArray(result: any): string[] {
  return String(result?.available_slots_string || "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value && !value.includes("No available slots"));
}

function findOfferedSlotIso(offeredSlots: string[], selectedTime?: string): string | null {
  const normalized = normalizeRequestedTime(selectedTime || "");
  if (!normalized) return null;

  for (const slot of offeredSlots || []) {
    const iso = parseSlotIso(slot);
    if (!iso) continue;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) continue;
    const time = date.toLocaleTimeString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      minute: "2-digit"
    });
    if (time === normalized) return iso;
  }
  return null;
}

function isExistingAppointmentLookupIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;

  const lookupPatterns = [
    /\b(do i|did i|have i|can you check|check if i).*(appointment|booking|booked)\b/i,
    /\b(when is|what time is).*(appointment|booking)\b/i,
    /\b(jag har|har jag|kan du kolla|kan du kontrollera).*(tid|bokning|bokat)\b/i,
    /\b(har jag en tid|har jag bokat|när är min tid|när är min bokning)\b/i,
    /\b(aya|آیا|میشه|می‌شود|میتونی|می‌تونی|mitoni|mishe).*(vaght|وقت|رزرو|booking|boka).*(daram|دارم|kardam|کردم|ya na|یا نه)\b/i,
    /\b(nemidonam|نمی.?دونم|motmaen nistam|مطمئن نیستم).*(vaght|وقت|رزرو|booking|boka)\b/i,
    /\b(habe ich|kannst du prüfen|wann ist).*(termin|buchung)\b/i,
    /\b(tengo|puedes comprobar|cuándo es).*(cita|reserva)\b/i,
    /(هل لدي|هل حجزت|متى موعدي|تحقق من موعدي)/i
  ];

  return lookupPatterns.some((pattern) => pattern.test(raw));
}

function isPendingSlotConfirmation(text: string | undefined, pending: any): boolean {
  if (!pending || pending.status !== "awaiting_confirmation") return false;

  const raw = String(text || "").trim();
  if (!raw) return false;

  if (isAffirmativeBookingText(raw)) return true;

  const selectedTime = inferRequestedTimeFromText(raw);
  if (!selectedTime) return false;

  const pendingDate = new Date(ensureStockholmOffset(pending.dateTime));
  if (Number.isNaN(pendingDate.getTime())) return false;

  const pendingTime = pendingDate.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit"
  });

  if (selectedTime !== pendingTime) return false;

  // A customer repeating the offered time with normal confirmation wording
  // must count as confirmation, even without words such as "yes" or "ok".
  return /\b(khube|khob|good|works|fine|passar|bra|går bra|okej|ok|mitonam|می.?تونم|خوبه|مناسبه|باشه|بله|آره|yes|ja|vale|bien|gut)\b/i.test(raw)
    || raw.replace(/\s+/g, "") === selectedTime.replace(":", "");
}


function formatAskContactMessageForPlatform(
  language: string,
  platformName: string
): string {
  if (platformName !== "whatsapp") return formatAskContactMessage(language);

  if (language === "fa") return "عالیه 😊 برای نهایی‌کردن رزرو فقط نام‌تان را بفرستید.";
  if (language === "es") return "Perfecto 😊 Para finalizar la reserva, solo necesito tu nombre.";
  if (language === "de") return "Perfekt 😊 Für den Abschluss brauche ich nur Ihren Namen.";
  if (language === "ar") return "ممتاز 😊 لإتمام الحجز أحتاج فقط اسمك.";
  if (language === "en") return "Perfect 😊 To finish the booking, I only need your name.";
  return "Toppen! 😊 För att slutföra bokningen behöver jag bara ditt namn.";
}

function formatAskContactMessage(language: string = "sv"): string {
  if (language === "fa") return "حتماً 😊 برای رزرو، لطفاً نام و شماره موبایل‌تان را بفرستید.";
  if (language === "es") return "Perfecto 😊 Para reservar, necesito tu nombre y número de móvil.";
  if (language === "de") return "Sehr gern 😊 Für die Buchung brauche ich bitte Ihren Namen und Ihre Mobilnummer.";
  if (language === "ar") return "تمام 😊 لإتمام الحجز، أحتاج اسمك ورقم هاتفك.";
  if (language === "en") return "Perfect 😊 To book it, I just need your name and mobile number.";
  return "Toppen! Innan jag bokar din tid behöver jag ditt namn och mobilnummer. 😊";
}

function localizeServiceName(service: string, language: string): string {
  const raw = String(service || "").toLowerCase();
  const isBikini = raw.includes("bikini");
  const isFullBody = raw.includes("helkropp") || raw.includes("fullbody") || raw.includes("full body");
  if (language === "fa") {
    if (isBikini) return "بیکینی";
    if (isFullBody) return "لیزر فول بادی";
    if (raw.includes("laser")) return "لیزر";
    return "وقت";
  }
  if (language === "en") {
    if (isBikini) return "bikini treatment";
    if (isFullBody) return "full body laser treatment";
    return service || "appointment";
  }
  if (language === "sv") return service || "bokning";
  if (language === "de") {
    if (isBikini) return "Bikini-Behandlung";
    if (isFullBody) return "Ganzkörper-Laserbehandlung";
    return service || "Termin";
  }
  if (language === "es") {
    if (isBikini) return "tratamiento de bikini";
    if (isFullBody) return "tratamiento láser de cuerpo completo";
    return service || "cita";
  }
  if (language === "ar") {
    if (isBikini) return "علاج البكيني";
    if (isFullBody) return "ليزر الجسم الكامل";
    return "موعد";
  }
  return service || "appointment";
}

function formatLocalizedDateTime(dateTime: string, language: string) {
  const start = new Date(ensureStockholmOffset(dateTime));
  const localeMap: Record<string, string> = { fa: "fa-IR", sv: "sv-SE", en: "en-GB", de: "de-DE", es: "es-ES", ar: "ar-SA" };
  const locale = localeMap[language] || "en-GB";
  const dateText = start.toLocaleDateString(locale, { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long" });
  const timeText = start.toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" });
  return { dateText, timeText };
}

function formatBookingSavedMessage(language: string, name: string, service: string, dateTime: string): string {
  const { dateText, timeText } = formatLocalizedDateTime(dateTime, language);
  const localizedService = localizeServiceName(service, language);
  if (language === "fa") return `عالی ${name}! وقت شما برای ${localizedService} در ${dateText} ساعت ${timeText} رزرو شد. 😊`;
  if (language === "es") return `Perfecto ${name}! Tu cita para ${localizedService} está reservada el ${dateText} a las ${timeText}. 😊`;
  if (language === "de") return `Perfekt ${name}! Ihr Termin für ${localizedService} ist am ${dateText} um ${timeText} gebucht. 😊`;
  if (language === "ar") return `تمام ${name}! تم حجز موعدك لـ ${localizedService} يوم ${dateText} الساعة ${timeText}. 😊`;
  if (language === "en") return `Perfect ${name}! Your appointment for ${localizedService} is booked on ${dateText} at ${timeText}. 😊`;
  return `Härligt ${name}! Din tid för ${localizedService} är nu bokad ${dateText} kl ${timeText}. Vi ser fram emot att träffa dig! 😊`;
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
    business_id: row.id,
    id: row.id,
    businessName: row.business_name,
    business_name: row.business_name,
    telegramToken: row.telegram_bot_token,
    adminTelegramChatId: row.admin_telegram_chat_id || row.adminTelegramChatId || activeConfig.adminTelegramChatId,
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

const businessConfigVersions: Record<string, string> = {};

function makeBusinessConfigVersion(config: any): string {
  const businessId = getBusinessIdFromConfig(config) || "no-business";
  const businessName = config?.businessName || config?.business_name || "";
  const prompt = config?.systemPrompt || "";
  const calendarId = config?.googleCalendarId || "";
  return crypto.createHash("sha1").update(`${businessId}|${businessName}|${calendarId}|${prompt}`).digest("hex");
}

function resetSessionIfBusinessConfigChanged(sessionId: string, config: any) {
  const nextVersion = makeBusinessConfigVersion(config);
  const previousVersion = businessConfigVersions[sessionId];
  if (previousVersion && previousVersion !== nextVersion) {
    console.log(`[BusinessConfig] Config changed for session=${sessionId}. Clearing in-memory chat history so old business identity cannot leak.`);
    chatSessions[sessionId] = [];
    delete pendingBookings[sessionId];
    delete recentlyCompletedBookings[sessionId];
  }
  businessConfigVersions[sessionId] = nextVersion;
}

async function loadFreshBusinessConfigByTelegramToken(token: string, fallbackConfig: any = {}) {
  let freshConfig = { ...activeConfig, ...(fallbackConfig || {}), telegramToken: token };
  if (!supabase || !token) return freshConfig;

  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("*")
      .eq("telegram_bot_token", token)
      .maybeSingle();

    if (error) {
      console.error("Telegram business live lookup error:", JSON.stringify(error));
      return freshConfig;
    }

    if (data) {
      freshConfig = normalizeBusinessConfig(data);
      console.log(`[BusinessConfig] Fresh Telegram config loaded: business=${freshConfig.businessName || "unknown"}, business_id=${getBusinessIdFromConfig(freshConfig)}, calendar_id=${freshConfig.googleCalendarId || "missing"}`);
    } else {
      console.warn(`[BusinessConfig] No Supabase business found for Telegram token ${maskToken(token)}. Using fallback config.`);
    }
  } catch (err) {
    console.error("Telegram business live lookup crashed:", err);
  }

  return freshConfig;
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


type UnifiedBookingSend = (text: string) => Promise<any>;

async function handleUnifiedBookingEngine(params: {
  sessionId: string;
  platformName: "whatsapp" | "messenger" | "instagram" | "telegram";
  platformLogName: string;
  recipientUserId: string;
  text: string;
  history: any[];
  businessConfig: any;
  send: UnifiedBookingSend;
  postProcessPlatform: string;
}): Promise<boolean> {
  const {
    sessionId,
    platformName,
    platformLogName,
    recipientUserId,
    text,
    history,
    businessConfig,
    send,
    postProcessPlatform
  } = params;

  if (!text) return false;

  const language = getConversationLanguage(sessionId, text);
  let pending = await loadPendingBooking(sessionId, platformName, businessConfig);

  const replyAndRecord = async (reply: string) => {
    await send(reply);
    appendLocalHistory(sessionId, text, reply);
    await postProcessMessage(
      recipientUserId,
      postProcessPlatform,
      text,
      reply,
      businessConfig?.telegramToken,
      businessConfig?.apiKey,
      getBusinessIdFromConfig(businessConfig)
    );
  };

  try {
    if (pending && isGreetingOnlyText(text)) {
      console.log(
        `[UnifiedBooking] Fresh greeting cleared stale pending platform=${platformName}, session=${sessionId}, status=${pending.status || "unknown"}`
      );
      await clearPendingBooking(sessionId);
      pending = null;
      return false;
    }

    if (pending && isNewBookingRequestText(text)) {
      console.log(`[UnifiedBooking] Clearing stale pending platform=${platformName}, session=${sessionId}`);
      await clearPendingBooking(sessionId);
      pending = null;
    }

    if (!pending && isExistingAppointmentLookupIntent(text)) {
      const adapter = getCalendarAdapter(businessConfig);
      const lookupResult = await findCustomerAppointments(
        adapter,
        {},
        recipientUserId,
        platformName
      );
      const reply = formatAppointmentLookupReply(lookupResult, language);
      console.log(`[UnifiedBooking] Lookup platform=${platformName}, found=${Boolean(lookupResult?.found)}`);
      await replyAndRecord(reply);
      return true;
    }

    const completed = getRecentCompletedBooking(sessionId);
    if (!pending && completed && isThanksOnlyText(text)) {
      await replyAndRecord(formatThanksReply(completed.language || language, completed.name));
      return true;
    }

    const explicitDate = resolveExplicitBookingDate(text);
    if (explicitDate && isBookingConversationContext(text, history)) {
      const adapter = getCalendarAdapter(businessConfig);
      const durationMinutes = inferBookingDurationFromContext(text, history);
      const requestedTime = inferRequestedTimeFromText(text) || undefined;

      console.log(
        `[UnifiedBooking] Date resolved platform=${platformName}, text=${JSON.stringify(text)}, date=${explicitDate}, duration=${durationMinutes}, time=${requestedTime || "none"}`
      );

      const result = await adapter.checkSlots(
        explicitDate,
        explicitDate,
        durationMinutes,
        requestedTime
      );
      const slots = getSlotsArray(result);
      const reply = formatSwedishTimeSlots(slots, requestedTime, language);

      if (slots.length > 0) {
        const exactIso = requestedTime ? findOfferedSlotIso(slots, requestedTime) : null;
        const contextText = [
          text,
          ...(history || []).slice(-10).map((item: any) => item?.content || "")
        ].join(" ");

        const detectedService = normalizeBookingService(contextText, "Bokning");
        const defaultService = getDefaultBookingServiceForBusiness(businessConfig);
        const finalService =
          detectedService !== "Bokning"
            ? detectedService
            : (defaultService || "Bokning");

        const fixedDuration = getDefaultBookingDurationForService(finalService);

        await savePendingBooking(sessionId, platformName, {
          businessConfig,
          platform: platformName,
          service: finalService,
          selectedDate: explicitDate,
          offeredSlots: slots,
          dateTime: exactIso,
          durationMinutes: fixedDuration || durationMinutes,
          language: detectStrongLatestLanguage(text) || language,
          customerPhone: getWhatsAppConversationPhone(
            platformName,
            recipientUserId,
            sessionId
          ),
          status: exactIso ? "awaiting_confirmation" : "awaiting_time_selection"
        });
      } else {
        await clearPendingBooking(sessionId);
      }

      await replyAndRecord(reply);
      return true;
    }

    if (pending?.status === "awaiting_time_selection") {
      const selectedTime = inferRequestedTimeFromText(text);
      const selectedIso = findOfferedSlotIso(
        Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
        selectedTime || undefined
      );

      if (selectedTime && selectedIso) {
        const adapter = getCalendarAdapter(businessConfig);
        const selectedDate = String(pending.selectedDate || selectedIso.slice(0, 10));
        const fresh = await adapter.checkSlots(
          selectedDate,
          selectedDate,
          Number(pending.durationMinutes || 60),
          selectedTime
        );
        const freshSlots = getSlotsArray(fresh);
        const freshIso = findOfferedSlotIso(freshSlots, selectedTime);

        if (!freshIso) {
          pending.offeredSlots = freshSlots;
          await savePendingBooking(sessionId, platformName, pending);
          await replyAndRecord(
            formatSwedishTimeSlots(
              freshSlots,
              selectedTime,
              pending.language || language
            )
          );
          return true;
        }

        pending.dateTime = freshIso;
        pending.offeredSlots = freshSlots;
        pending.language = pending.language || language;
        pending.status = "awaiting_contact";
        await savePendingBooking(sessionId, platformName, pending);

        console.log(`[UnifiedBooking] Slot revalidated platform=${platformName}, iso=${freshIso}`);
        await replyAndRecord(
          formatAskContactMessageForPlatform(
            pending.language || language,
            platformName
          )
        );
        return true;
      }
    }

    if (pending && isPendingSlotConfirmation(text, pending)) {
      // Recheck once more before requesting personal details.
      const dateTime = String(pending.dateTime || "");
      const selectedTime = getStockholmTimeFromIso(dateTime);
      const selectedDate = String(pending.selectedDate || dateTime.slice(0, 10));

      if (dateTime && selectedTime && selectedDate) {
        const adapter = getCalendarAdapter(businessConfig);
        const fresh = await adapter.checkSlots(
          selectedDate,
          selectedDate,
          Number(pending.durationMinutes || 60),
          selectedTime
        );
        const freshIso = findOfferedSlotIso(getSlotsArray(fresh), selectedTime);

        if (!freshIso) {
          const freshSlots = getSlotsArray(fresh);
          pending.status = "awaiting_time_selection";
          pending.offeredSlots = freshSlots;
          pending.dateTime = null;
          await savePendingBooking(sessionId, platformName, pending);
          await replyAndRecord(
            formatSwedishTimeSlots(
              freshSlots,
              selectedTime,
              pending.language || language
            )
          );
          return true;
        }

        pending.dateTime = freshIso;
      }

      pending.status = "awaiting_contact";
      pending.language = pending.language || language;
      if (!pending.customerPhone) {
        pending.customerPhone = getWhatsAppConversationPhone(
          platformName,
          recipientUserId,
          sessionId
        );
      }

      await savePendingBooking(sessionId, platformName, pending);
      await replyAndRecord(
        formatAskContactMessageForPlatform(
          pending.language || language,
          platformName
        )
      );
      return true;
    }

    if (pending?.status === "awaiting_contact") {
      const combinedContact = extractNameAndPhone(text);
      const nameFromMessage = combinedContact?.name || extractNameOnly(text);
      const phoneFromMessage = combinedContact?.phone || extractPhoneOnly(text);
      const serviceFromMessage = normalizeBookingService(text, pending.service);
      const phoneFromChannel = getWhatsAppConversationPhone(
        platformName,
        recipientUserId,
        sessionId
      );

      if (nameFromMessage) pending.customerName = nameFromMessage;
      if (phoneFromMessage) pending.customerPhone = phoneFromMessage;
      if (!pending.customerPhone && phoneFromChannel) pending.customerPhone = phoneFromChannel;
      if (serviceFromMessage !== "Bokning") pending.service = serviceFromMessage;

      // Consultation is a fixed product: service and duration are deterministic.
      const contextService = normalizeBookingService(
        [
          ...(history || []).slice(-10).map((item: any) =>
            typeof item?.content === "string" ? item.content : ""
          ),
          text
        ].join(" "),
        pending.service
      );

      if (contextService === "Konsultation") {
        pending.service = "Konsultation";
        pending.durationMinutes = 30;
      }

      if (!pending.service || pending.service === "Bokning") {
        const defaultService = getDefaultBookingServiceForBusiness(businessConfig);
        if (defaultService) {
          pending.service = defaultService;
          const fixedDuration = getDefaultBookingDurationForService(defaultService);
          if (fixedDuration) pending.durationMinutes = fixedDuration;
        }
      }

      const missing: Array<"name" | "phone" | "service"> = [];
      if (!pending.customerName) missing.push("name");
      if (!pending.customerPhone) missing.push("phone");
      if (!pending.service || pending.service === "Bokning") missing.push("service");

      if (missing.length > 0) {
        await savePendingBooking(sessionId, platformName, pending);
        await replyAndRecord(
          formatMissingBookingDetailsMessage(
            pending.language || language,
            missing
          )
        );
        return true;
      }

      if (!pending.dateTime) {
        console.error(`[UnifiedBooking] Missing dateTime before insert platform=${platformName}`);
        await clearPendingBooking(sessionId);
        await replyAndRecord(getErrorMessageByLanguage(pending.language || language));
        return true;
      }

      const adapter = getCalendarAdapter(businessConfig);
      const selectedTime = getStockholmTimeFromIso(pending.dateTime);
      const selectedDate = String(
        pending.selectedDate || String(pending.dateTime).slice(0, 10)
      );

      // Final race-condition check immediately before insert.
      const fresh = await adapter.checkSlots(
        selectedDate,
        selectedDate,
        Number(pending.durationMinutes || 30),
        selectedTime || undefined
      );
      const freshSlots = getSlotsArray(fresh);
      const revalidatedIso = selectedTime
        ? findOfferedSlotIso(freshSlots, selectedTime)
        : null;

      const lockedIso = String(pending.dateTime || "").trim();
      const lockedTime = getStockholmTimeFromIso(lockedIso);
      const lockedDate = lockedIso.slice(0, 10);

      const finalIso =
        revalidatedIso ||
        (
          lockedIso &&
          lockedTime === selectedTime &&
          lockedDate === selectedDate &&
          isExactRequestedSlotAvailable(
            Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
            selectedTime || undefined
          )
            ? lockedIso
            : null
        );

      if (!finalIso) {
        console.error("[UnifiedBooking] Exact slot failed final revalidation", {
          platform: platformName,
          sessionId,
          selectedDate,
          selectedTime,
          pendingDateTime: pending.dateTime,
          previousOfferedSlots: pending.offeredSlots,
          freshSlots
        });

        pending.status = "awaiting_time_selection";
        pending.offeredSlots = freshSlots;
        pending.dateTime = null;
        await savePendingBooking(sessionId, platformName, pending);
        await replyAndRecord(
          formatSwedishTimeSlots(
            pending.offeredSlots,
            selectedTime || undefined,
            pending.language || language
          )
        );
        return true;
      }

      const result = await adapter.insertAppointment(
        pending.customerName,
        pending.customerPhone,
        pending.service,
        finalIso,
        Number(pending.durationMinutes || 30),
        recipientUserId
      );

      if (!result?.success) {
        console.error(
          `[UnifiedBooking] Calendar insert failed platform=${platformName}:`,
          JSON.stringify(result)
        );
        await replyAndRecord(getErrorMessageByLanguage(pending.language || language));
        return true;
      }

      await recordAppointmentFromBooking({
        businessConfig,
        platform: platformName,
        userId: recipientUserId,
        name: pending.customerName,
        phone: pending.customerPhone,
        service: pending.service,
        dateTime: finalIso,
        durationMinutes: Number(pending.durationMinutes || 30)
      });

      await clearPendingBooking(sessionId);
      rememberCompletedBooking(
        sessionId,
        pending.language || language,
        pending.customerName
      );
      await notifyAdminAboutBooking(
        businessConfig,
        platformLogName,
        businessConfig.businessName || businessConfig.business_name || "business",
        pending.customerName,
        pending.customerPhone,
        finalIso
      );

      await replyAndRecord(
        formatBookingSavedMessage(
          pending.language || language,
          pending.customerName,
          pending.service,
          finalIso
        )
      );
      return true;
    }

    return false;
  } catch (error) {
    console.error(`[UnifiedBooking] crashed platform=${platformName}:`, error);

    const languageAfterError =
      pending?.language ||
      getConversationLanguage(sessionId, text);

    await replyAndRecord(getErrorMessageByLanguage(languageAfterError));
    return true;
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

  if (!update.message) return;
  if (!update.message.chat) return;

  const chatId = update.message.chat.id;
  const telegramSessionId = `${telegramToken}:${chatId}`;

  // Always load the latest business config directly from Supabase for this token.
  // Do not use old chat_history to decide the tenant; history can be stale after a business edits its name/prompt.
  config = await loadFreshBusinessConfigByTelegramToken(telegramToken, config);
  resetSessionIfBusinessConfigChanged(telegramSessionId, config);

  const { apiKey } = config;
  console.log(`Processing Telegram message for ${config.businessName || "business"} (${maskToken(telegramToken)}), chatId=${chatId}`);

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
    
    if (text) {
      const unifiedHandled = await handleUnifiedBookingEngine({
        sessionId: telegramSessionId,
        platformName: "telegram",
        platformLogName: "Telegram",
        recipientUserId: chatId.toString(),
        text,
        history,
        businessConfig: config,
        send: async (reply) => {
          const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: reply })
          });
          return response.ok;
        },
        postProcessPlatform: platform
      });
      if (unifiedHandled) return;
    }

    const completedBooking = getRecentCompletedBooking(telegramSessionId);
    if (text && completedBooking && isThanksOnlyText(text || "")) {
      const thanksText = formatThanksReply(completedBooking.language || getLockedReplyLanguage(telegramSessionId, text), completedBooking.name);
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: thanksText })
      });
      appendLocalHistory(telegramSessionId, text || "", thanksText);
      await postProcessMessage(chatId.toString(), platform, text || "", thanksText, telegramToken, apiKey, getBusinessIdFromConfig(config));
      return;
    }

    const usageLanguage = getConversationLanguage(telegramSessionId, text || "");
    const usage = await checkAndIncrementDailyUsage({
      businessId: getBusinessIdFromConfig(config),
      platform,
      userId: telegramSessionId,
      language: usageLanguage
    });
    if (!usage.allowed) {
      const limitText = formatDailyLimitMessage(usageLanguage);
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: limitText })
      });
      appendLocalHistory(telegramSessionId, text || '[voice]', limitText);
      await postProcessMessage(chatId.toString(), platform, text || '[voice]', limitText, telegramToken, apiKey, getBusinessIdFromConfig(config));
      return;
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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
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
  buildLanguageLockInstruction(getConversationLanguage(telegramSessionId, text || ""));
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
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(text || ""), getLockedReplyLanguage(telegramSessionId, text || ""));
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
        else if (call.function.name === "findCustomerAppointments" && args) {
          adapterRes = await findCustomerAppointments(adapter, args, chatId.toString(), "telegram");
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            getLockedReplyLanguage(telegramSessionId, text || "")
          );
          return { TERMINATE_EARLY: true, replyMessage };
        }
        else if (call.function.name === "insertAppointment" && args) {
          const contactOverride = extractNameAndPhone(text || "");
          const safeName = contactOverride?.name || cleanCustomerNameCandidate(args.name) || args.name;
          const safePhone = contactOverride?.phone || args.phone;
          adapterRes = await adapter.insertAppointment(safeName, safePhone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig: config,
              platform: "telegram",
              userId: chatId.toString(),
              name: safeName,
              phone: safePhone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
            rememberCompletedBooking(telegramSessionId, getLockedReplyLanguage(telegramSessionId, text || ""), safeName);
          }
          const notifyToken = config?.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = config?.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
             try {
                const notifyText = `🔔 Ny bokning mottagen!\n👤 Namn: ${safeName}\n📞 Mobil: ${safePhone}\n📅 Tid: ${args.dateTime}`;
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
    
    const textResponse = String(chatResponse.text || "").trim() ||
      getErrorMessageByLanguage(getLockedReplyLanguage(telegramSessionId, text || ""));
    if (!String(chatResponse.text || "").trim()) {
      console.error("[AIEmptyResponse] Telegram returned no text after tool processing.", {
        sessionId: telegramSessionId,
        hadFunctionCalls: Boolean(chatResponse.functionCalls?.length),
      });
    }

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
  if (!text) return "en";

  const raw = String(text).trim();
  if (!raw) return "en";
  const lower = raw.toLowerCase();

  // Explicit Arabic/Persian script checks first.
  // Important: Arabic and Persian share Unicode ranges, so we must not default all Arabic-script
  // messages to Persian. This was causing Arabic conversations to flip into Persian after tool calls.
  if (/[\u0600-\u06FF]/.test(raw)) {
    const hasPersianSpecificChars = /[پچژگۀک‌ی]/u.test(raw);
    const hasPersianWords = /(سلام|ممنون|مرسی|سپاس|میخوام|می‌خوام|رزرو|وقت|شنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه|شماره|موبایل|اسمم|نامم|برای|خوبه|بله|آره)/u.test(raw);
    const hasArabicSpecificWords = /(مرحب|أهلا|اهلا|السلام|شكرا|شكرًا|موعد|حجز|احجز|أحجز|علاج|جلسة|الجسم|كامل|الساعة|مساء|صباح|نعم|لا|الخميس|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الجمعة|السبت|الأحد|الاحد|القادم|هاتفي|رقمي|اسمي|إسمي|اسمه|جوال|المحمول)/u.test(raw);

    if (hasArabicSpecificWords && !hasPersianSpecificChars) return "ar";
    if (hasPersianSpecificChars || hasPersianWords) return "fa";
    // If the text is Arabic-script but not clearly Persian, prefer Arabic.
    // The conversation lock will preserve Persian for existing Persian chats.
    return "ar";
  }

  const scores: Record<string, number> = { en: 0, sv: 0, de: 0, es: 0, fa: 0, ar: 0 };
  const add = (lang: string, pattern: RegExp, weight = 1) => {
    const matches = lower.match(pattern);
    if (matches) scores[lang] += matches.length * weight;
  };

  // Character signals. Important: ä/ö are also German, so they must NOT force Swedish.
  if (/[å]/i.test(raw)) scores.sv += 3;
  if (/[ñáéíóú¿¡]/i.test(raw)) scores.es += 3;
  if (/[ßü]/i.test(raw)) scores.de += 3;

  // Strong phrase signals.
  add("fa", /\b(salam|khubi|khub|khubam|khub hastin|mikham|mikhastam|baraye|vaght|saat|sate|doshanbe|seshanbe|chaharshanbe|panjshanbe|jome|shanbe|yekshanbe|emrooz|farda|bale|baleh|are|khube|chi|che|migin|migirin|shohar|shoharam|esm|esme|esmam|nam|name|shomare|shomaram|telefon|telefonam|mobail|mobile|mobilesh|ham hast|hastam|hast|sepas|mersi|merci|mamnoon|mamnun)\b/g, 3);
  add("de", /\b(hallo|guten|danke|bitte|termin|uhr|morgen|nachmittag|buchen|buchung|behandlung|ganzkörper|ganzkoerper|körper|koerper|ich möchte|ich moechte|ich will|mein name|meine nummer|telefonnummer|nummer ist|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/g, 4);
  add("en", /\b(hi|hello|hey|thanks|thank you|yes|no|please|appointment|book|booking|available|next week|today|tomorrow|friday|thursday|wednesday|tuesday|monday|saturday|sunday|treatment|bikini|fullbody|full body|my name is|my phone is|phone|number|i want|i would like|i can|can i|could i)\b/g, 2);
  add("sv", /\b(hej|hejsan|tack|tusen tack|ja tack|nej|jag|vill|ska|ha|boka|bokning|tid|ledig|behandling|klockan|kl|mitt namn|mitt nummer|mobilnummer|telefonnummer|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|idag|imorgon)\b/g, 2);
  add("es", /\b(hola|gracias|por favor|quiero|cita|reservar|reserva|tratamiento|mañana|manana|hora|semana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|mi nombre|mi teléfono|telefono)\b/g, 3);
  add("ar", /\b(marhaba|salam|shukran|maw3ed|maw'ed|hajz|bukra|alyawm|naam|la)\b/g, 2);

  // Some short replies are ambiguous. Do not let a single "ja" beat an existing language elsewhere.
  if (/^\s*(ja|ok|okej|yes|bale|si|sí|bitte|merci|mersi|thanks|tack|danke|gracias)\s*[!.؟?]*\s*$/i.test(raw)) {
    if (/\b(bittee?|danke)\b/i.test(lower)) return "de";
    if (/\b(si|sí|gracias)\b/i.test(lower)) return "es";
    if (/\b(bale|merci|mersi|mamnoon|sepas)\b/i.test(lower)) return "fa";
  }

  // If the text is clearly Persian transliteration, do not let English filler words win.
  if (scores.fa >= 3 && scores.fa >= Math.max(scores.en, scores.sv, scores.de, scores.es, scores.ar)) return "fa";

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > 0) {
    console.log(`[LanguageDetect] text=${JSON.stringify(raw)}, scores=${JSON.stringify(scores)}, selected=${ranked[0][0]}`);
    return ranked[0][0];
  }

  return "en";
}

function isAmbiguousShortReply(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase().replace(/[!?.،,؛\s]+/g, " ");
  return /^(ja|ja tack|ok|okej|yes|yep|bale|baleh|are|si|sí|bitte|merci|mersi|thanks|thank you|tack|tusen tack|danke|gracias|mamnoon|mamnun|sepas|مرسی|ممنون|سپاس|شكرا|شكرًا|نعم)$/.test(raw);
}

function isExplicitLanguageSwitch(text?: string): string | null {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  if (/\b(english|in english|speak english|reply in english|can we continue in english)\b/.test(raw)) return "en";
  if (/\b(svenska|på svenska|prata svenska|svara på svenska)\b/.test(raw)) return "sv";
  if (/\b(deutsch|auf deutsch|sprechen sie deutsch|bitte deutsch)\b/.test(raw)) return "de";
  if (/\b(español|espanol|en español|habla español|responde en español)\b/.test(raw)) return "es";
  if (/\b(farsi|persian|فارسی|به فارسی|فارسی صحبت کنیم)\b/u.test(raw)) return "fa";
  if (/\b(arabic|عربي|العربية|بالعربية|تكلم عربي|تحدث العربية)\b/u.test(raw)) return "ar";

  return null;
}


function hasStrongLanguageEvidence(language: string, text?: string): boolean {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return false;

  // These patterns are intentionally stronger than the normal detector. They are used
  // to allow a new real message to override an old chat language, even when the message
  // also contains a time like 16:30. Short replies like "yes", "ok", "tack", "merci"
  // are handled elsewhere and must not switch the conversation language.
  if (language === "en") {
    return /\b(hi|hello|hey|i\s+want|i\s+would\s+like|i\s+can|can\s+i|could\s+i|appointment|book|booking|available|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|my\s+name\s+is|my\s+phone\s+is|pedicure|treatment|quick\s+refresh)\b/i.test(lower);
  }
  if (language === "sv") {
    return /\b(hej|hejsan|jag\s+vill|jag\s+ska|jag\s+kan|boka|bokning|ledig|behandling|nästa\s+(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)|mitt\s+namn|mitt\s+nummer|mobilnummer)\b/i.test(lower);
  }
  if (language === "de") {
    return /\b(hallo|guten|ich\s+möchte|ich\s+moechte|ich\s+will|termin|buchen|buchung|behandlung|ganzkörper|ganzkoerper|mein\s+name|meine\s+nummer|telefonnummer|nächsten|naechsten)\b/i.test(lower);
  }
  if (language === "es") {
    return /\b(hola|quiero|me\s+gustaría|me\s+gustaria|cita|reservar|reserva|tratamiento|mi\s+nombre|mi\s+teléfono|mi\s+telefono|la\s+próxima|la\s+proxima)\b/i.test(lower);
  }
  if (language === "fa") {
    return /[پچژگۀک‌ی]/u.test(raw) || /\b(salam|mikham|mikhastam|baraye|vaght|saat|sate|doshanbe|seshanbe|chaharshanbe|panjshanbe|jome|shanbe|yekshanbe|esme|esmam|shomare|shomaram|telefonam)\b/i.test(lower);
  }
  if (language === "ar") {
    return /(مرحب|أهلا|اهلا|السلام|موعد|حجز|احجز|أحجز|علاج|جلسة|الساعة|الخميس|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الجمعة|السبت|الأحد|الاحد|اسمي|هاتفي|رقمي)/u.test(raw);
  }
  return false;
}

function shouldAllowLatestLanguageOverride(chatId: string, previous: string | undefined, detected: string, latestText?: string): boolean {
  const text = String(latestText || "").trim();
  if (!previous || !detected || detected === previous || !text) return false;
  if (isAmbiguousShortReply(text)) return false;
  if (isThanksOnlyText(text)) return false;
  if (isAffirmativeBookingText(text)) return false;

  // While a booking is waiting for name/phone, keep the already chosen language.
  // A customer may provide contact info in English even if the conversation started in Swedish.
  if (pendingBookings[chatId]) return false;
  if (getRecentCompletedBooking(chatId)) return false;
  if (extractNameAndPhone(text)) return false;

  return hasStrongLanguageEvidence(detected, text);
}

function shouldKeepPreviousConversationLanguage(chatId: string, latestText?: string): boolean {
  const text = String(latestText || "").trim();
  if (!text) return true;

  // During an active booking, keep the language stable. Name/phone messages,
  // confirmations, thanks, and time-only changes are not language-switch requests.
  if (pendingBookings[chatId]) return true;
  if (getRecentCompletedBooking(chatId)) return true;
  if (isThanksOnlyText(text)) return true;
  if (isAffirmativeBookingText(text)) return true;
  if (isAmbiguousShortReply(text)) return true;
  if (inferRequestedTimeFromText(text)) return true;
  if (extractNameAndPhone(text)) return true;

  // If previous language is Arabic/Persian and the new message uses Arabic script,
  // don't flip between ar/fa unless the user explicitly asks for it.
  if (/[\u0600-\u06FF]/.test(text)) return true;

  return false;
}


function detectStrongLatestLanguage(text?: string): string | null {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return null;

  if (/[\u0600-\u06FF]/.test(raw)) {
    if (/[پچژگ]|(?:می|نمی|برای|وقت|مشاوره|شماره|اسم)/.test(raw)) return "fa";
    return "ar";
  }

  if (
    /\b(kan jag|jag vill|jag behöver|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|klockan|vilken tid|konsultation|boka|ledig|passar|mitt namn)\b/i.test(raw)
  ) return "sv";

  if (
    /\b(man|mikham|mikhastam|baraye|vaght|moshavere|moshavereh|esmam|esme man|khobe|bale|lotfan|2shanbe|3shanbe|4shanbe|5shanbe)\b/i.test(raw)
  ) return "fa";

  if (/\b(i want|can i|monday|tuesday|wednesday|appointment|consultation|book|booking|my name)\b/i.test(raw)) return "en";
  if (/\b(ich|möchte|termin|montag|dienstag|beratung)\b/i.test(raw)) return "de";
  if (/\b(quiero|cita|lunes|martes|consulta)\b/i.test(raw)) return "es";

  return null;
}

function getConversationLanguage(chatId: string, latestText?: string): string {
  const text = String(latestText || "").trim();
  const previous = chatLanguages[chatId];
  const completed = getRecentCompletedBooking(chatId);
  const explicitSwitch = isExplicitLanguageSwitch(text);

  if (explicitSwitch) {
    chatLanguages[chatId] = explicitSwitch;
    return explicitSwitch;
  }

  if (completed && isThanksOnlyText(text)) return completed.language || previous || "en";

  const strongLatest = detectStrongLatestLanguage(text);
  const detected = strongLatest || detectUserLanguage(text || "");

  if (strongLatest && strongLatest !== previous) {
    chatLanguages[chatId] = strongLatest;
    console.log(
      `[LanguageLock] strong latest message override previous=${previous || "none"} with=${strongLatest} chatId=${chatId}`
    );
    return strongLatest;
  }

  // Important production fix:
  // Old Telegram/Instagram chats can already have a previous language locked from an older test.
  // If the next message is a full, strong message in another language AND includes a time,
  // the old code kept the previous language because inferRequestedTimeFromText(text) returned true.
  // That caused English conversations to receive Swedish deterministic replies like:
  // "Ja, fredag 17 juli kl 16:30 är ledig".
  // Strong new messages must be allowed to reset/override the old session language.
  if (shouldAllowLatestLanguageOverride(chatId, previous, detected, text)) {
    chatLanguages[chatId] = detected;
    console.log(`[LanguageLock] overriding previous=${previous} with detected=${detected} for chatId=${chatId}`);
    return detected;
  }

  if (previous && shouldKeepPreviousConversationLanguage(chatId, text)) {
    return previous;
  }

  if (text) {
    chatLanguages[chatId] = detected;
    return detected;
  }
  return previous || detected || "en";
}

function getEffectiveReplyLanguage(chatId: string, latestText?: string): string {
  return getConversationLanguage(chatId, latestText);
}

function getLockedReplyLanguage(chatId: string, fallbackText?: string): string {
  if (chatLanguages[chatId]) return chatLanguages[chatId];
  return getConversationLanguage(chatId, fallbackText || "");
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


function normalizePlatformName(platform: string): string {
  const raw = String(platform || "").trim().toLowerCase();

  if (
    raw === "facebook" ||
    raw === "facebook_messenger" ||
    raw === "messenger-api" ||
    raw.startsWith("messenger")
  ) return "messenger";

  if (
    raw === "telegram-polling" ||
    raw === "telegram_webhook" ||
    raw === "telegram-webhook" ||
    raw.startsWith("telegram")
  ) return "telegram";

  if (raw.startsWith("instagram")) return "instagram";
  if (raw.startsWith("whatsapp") || raw === "wa") return "whatsapp";

  return raw || "unknown";
}

function normalizePlatformUserId(platform: string, userId: string) {
  const channel = normalizePlatformName(platform);
  let raw = String(userId || "").trim();
  if (!raw) return "";

  const prefixes = [
    `${channel}_`,
    `${channel}-`,
    channel === "telegram" ? "tg_" : "",
    channel === "telegram" ? "telegram_" : "",
    channel === "whatsapp" ? "wa_" : "",
    channel === "whatsapp" ? "whatsapp_" : "",
    channel === "whatsapp" ? "whatsapp:" : "",
    channel === "instagram" ? "ig_" : "",
    channel === "instagram" ? "instagram_" : "",
    channel === "instagram" ? "instagram:" : "",
    channel === "messenger" ? "ms_" : "",
    channel === "messenger" ? "messenger_" : "",
    channel === "messenger" ? "messenger:" : "",
  ].filter(Boolean);

  let lowered = raw.toLowerCase();
  for (const prefix of prefixes) {
    if (lowered.startsWith(prefix)) {
      raw = raw.slice(prefix.length);
      lowered = raw.toLowerCase();
      break;
    }
  }

  if (channel === "whatsapp") {
    const digits = raw.replace(/\D/g, "");
    return digits || raw;
  }

  return raw.trim();
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

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);

  try {
    if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
    const history = chatSessions[chatId as any];

    const usage = await checkAndIncrementDailyUsage({
      businessId: getBusinessIdFromConfig(businessConfig),
      platform,
      userId: chatId,
      language: userLanguage
    });
    if (!usage.allowed) {
      const limitText = formatDailyLimitMessage(userLanguage);
      await sendWhatsAppMessage(from, limitText, businessConfig);
      appendLocalHistory(chatId, textMessage, limitText);
      await postProcessMessage(chatId, platform, textMessage, limitText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

    const unifiedHandled = await handleUnifiedBookingEngine({
      sessionId: chatId,
      platformName: "whatsapp",
      platformLogName: "WhatsApp",
      recipientUserId: from,
      text: textMessage,
      history,
      businessConfig,
      send: (reply) => sendWhatsAppMessage(from, reply, businessConfig),
      postProcessPlatform: platform
    });
    if (unifiedHandled) return;

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
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
        } else if (call.function.name === "findCustomerAppointments" && args) {
          adapterRes = await findCustomerAppointments(adapter, args, chatId.toString(), "whatsapp");
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            getConversationLanguage(chatId, textMessage || "")
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === "insertAppointment" && args) {
          // Safety fallback only. Normal WhatsApp bookings must be completed by UnifiedBooking.
          const restoredPending = await loadPendingBooking(chatId, "whatsapp", businessConfig);
          const contactFromMessage = extractNameAndPhone(textMessage || "");
          const pendingDateTime = String(restoredPending?.dateTime || "").trim();
          const validPendingDate =
            pendingDateTime &&
            !Number.isNaN(new Date(ensureStockholmOffset(pendingDateTime)).getTime());

          if (
            restoredPending &&
            restoredPending.status === "awaiting_contact" &&
            contactFromMessage &&
            validPendingDate
          ) {
            console.log(
              `[UnifiedBookingFallback] WhatsApp Gemini attempted insert; using validated WhatsApp pending. chatId=${chatId}, dateTime=${pendingDateTime}`
            );

            // Recheck the exact slot immediately before insertion.
            const selectedTime = inferRequestedTimeFromText(pendingDateTime);
            const selectedDate = String(
              restoredPending.selectedDate || pendingDateTime.slice(0, 10)
            );
            const fresh = await adapter.checkSlots(
              selectedDate,
              selectedDate,
              Number(restoredPending.durationMinutes || 60),
              selectedTime || undefined
            );
            const freshIso = selectedTime
              ? findOfferedSlotIso(getSlotsArray(fresh), selectedTime)
              : null;

            if (!freshIso) {
              adapterRes = {
                success: false,
                code: "SLOT_NO_LONGER_AVAILABLE",
                message: "The selected slot is no longer available."
              };
            } else {
              adapterRes = await adapter.insertAppointment(
                contactFromMessage.name,
                contactFromMessage.phone,
                restoredPending.service || "Bokning",
                freshIso,
                Number(restoredPending.durationMinutes || 60),
                from
              );

              if (adapterRes?.success) {
                await recordAppointmentFromBooking({
                  businessConfig,
                  platform: "whatsapp",
                  userId: from,
                  name: contactFromMessage.name,
                  phone: contactFromMessage.phone,
                  service: restoredPending.service || "Bokning",
                  dateTime: freshIso,
                  durationMinutes: Number(restoredPending.durationMinutes || 60)
                });
                await clearPendingBooking(chatId);
                rememberCompletedBooking(
                  chatId,
                  restoredPending.language || getConversationLanguage(chatId, textMessage || ""),
                  contactFromMessage.name
                );
                await notifyAdminAboutBooking(
                  businessConfig,
                  "WhatsApp",
                  businessName,
                  contactFromMessage.name,
                  contactFromMessage.phone,
                  freshIso
                );
              }
            }
          } else {
            console.error("[UnifiedBookingFallback] Blocked unsafe WhatsApp insertAppointment", {
              chatId,
              hasPending: Boolean(restoredPending),
              pendingStatus: restoredPending?.status || null,
              pendingDateTime: restoredPending?.dateTime || null,
              hasContact: Boolean(contactFromMessage),
              args
            });
            adapterRes = {
              success: false,
              code: "UNSAFE_GEMINI_INSERT_BLOCKED",
              message: "Booking was not finalized because the verified booking state was incomplete."
            };
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

    const textResponse = String(chatResponse.text || "").trim() ||
      getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || ""));
    if (!String(chatResponse.text || "").trim()) {
      console.error("[AIEmptyResponse] WhatsApp returned no text after tool processing.", {
        chatId,
        businessId: getBusinessIdFromConfig(businessConfig),
        hadFunctionCalls: Boolean(chatResponse.functionCalls?.length),
      });
    }

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

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);

  try {
    if (textMessage) {
      if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
      const unifiedHandled = await handleUnifiedBookingEngine({
        sessionId: chatId,
        platformName: "messenger",
        platformLogName: "Messenger",
        recipientUserId: senderId,
        text: textMessage,
        history: chatSessions[chatId as any],
        businessConfig,
        send: (reply) => sendMessengerMessage(senderId, reply, businessConfig),
        postProcessPlatform: platform
      });
      if (unifiedHandled) return;
    }

    let pending = await loadPendingBooking(chatId, "messenger", businessConfig);
    const detectedLang = getConversationLanguage(chatId, textMessage || "");

    // If the customer starts a new booking request while an old pending slot exists,
    // clear the old pending slot. This prevents a name/phone message from finalizing
    // a stale Thursday/18:00 appointment when the customer has now asked for Tuesday.
    if (pending && textMessage && isNewBookingRequestText(textMessage)) {
      console.log(`[DeterministicBooking] New booking request detected; clearing old pending. chatId=${chatId}, old=${JSON.stringify({ dateTime: pending.dateTime, status: pending.status })}`);
      await clearPendingBooking(chatId);
      pending = null;
    }

    // Existing-booking questions are handled deterministically.
    // This prevents the assistant from sending "please wait" and then never delivering
    // the calendar result until the customer messages again.
    if (!pending && textMessage && isExistingAppointmentLookupIntent(textMessage)) {
      const adapter = getCalendarAdapter(businessConfig);
      const lookupResult = await findCustomerAppointments(
        adapter,
        {},
        chatId.toString(),
        "messenger"
      );
      const lookupReply = formatAppointmentLookupReply(lookupResult, detectedLang);

      console.log(
        `[AppointmentLookup] Messenger deterministic result chatId=${chatId}, found=${Boolean(lookupResult?.found)}, count=${lookupResult?.appointments?.length || 0}`
      );

      await sendMessengerMessage(senderId, lookupReply, businessConfig);
      appendLocalHistory(chatId, textMessage || "", lookupReply);
      await postProcessMessage(
        chatId,
        platform,
        textMessage,
        lookupReply,
        businessConfig?.telegramToken,
        businessConfig?.apiKey,
        getBusinessIdFromConfig(businessConfig)
      );
      return;
    }

    const completedBooking = getRecentCompletedBooking(chatId);
    if (!pending && completedBooking && isThanksOnlyText(textMessage || "")) {
      const thanksText = formatThanksReply(completedBooking.language || detectedLang, completedBooking.name);
      await sendMessengerMessage(senderId, thanksText, businessConfig);
      appendLocalHistory(chatId, textMessage || "", thanksText);
      await postProcessMessage(chatId, platform, textMessage, thanksText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

    if (
      pending &&
      textMessage &&
      pending.status === "awaiting_time_selection"
    ) {
      const selectedTime = inferRequestedTimeFromText(textMessage || "");
      const selectedIso = findOfferedSlotIso(
        Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
        selectedTime || undefined
      );

      if (selectedTime && selectedIso) {
        // Re-check Google Calendar at the exact selected date/time immediately
        // before accepting it. This prevents stale or cross-day slot reuse.
        const adapter = getCalendarAdapter(businessConfig);
        const selectedDate = String(pending.selectedDate || selectedIso.slice(0, 10));
        const freshResult = await adapter.checkSlots(
          selectedDate,
          selectedDate,
          Number(pending.durationMinutes || 60),
          selectedTime
        );
        const freshSlots = getSlotsArray(freshResult);
        const freshIso = findOfferedSlotIso(freshSlots, selectedTime);

        if (freshIso) {
          pending.dateTime = freshIso;
          pending.offeredSlots = freshSlots;
          pending.language = pending.language || detectedLang;
          pending.status = "awaiting_contact";
          await savePendingBooking(chatId, "messenger", pending);

          const askText = formatAskContactMessage(
            pending.language || detectedLang
          );
          console.log(
            `[DeterministicBooking] Messenger selected slot revalidated. chatId=${chatId}, dateTime=${freshIso}`
          );
          await sendMessengerMessage(senderId, askText, businessConfig);
          appendLocalHistory(chatId, textMessage || "", askText);
          await postProcessMessage(
            chatId,
            platform,
            textMessage,
            askText,
            businessConfig?.telegramToken,
            businessConfig?.apiKey,
            getBusinessIdFromConfig(businessConfig)
          );
          return;
        }

        const unavailableReply = formatSwedishTimeSlots(
          freshSlots,
          selectedTime,
          pending.language || detectedLang
        );
        pending.offeredSlots = freshSlots;
        await savePendingBooking(chatId, "messenger", pending);
        await sendMessengerMessage(senderId, unavailableReply, businessConfig);
        appendLocalHistory(chatId, textMessage || "", unavailableReply);
        await postProcessMessage(
          chatId,
          platform,
          textMessage,
          unavailableReply,
          businessConfig?.telegramToken,
          businessConfig?.apiKey,
          getBusinessIdFromConfig(businessConfig)
        );
        return;
      }
    }

    if (pending && textMessage && isPendingSlotConfirmation(textMessage, pending)) {
      pending.status = "awaiting_contact";
      await savePendingBooking(chatId, "messenger", pending);
      const askText = formatAskContactMessage(pending.language || detectedLang);
      console.log(`[DeterministicBooking] Messenger slot confirmed. Awaiting contact. chatId=${chatId}, dateTime=${pending.dateTime}`);
      await sendMessengerMessage(senderId, askText, businessConfig);
      appendLocalHistory(chatId, textMessage || "", askText);
      await postProcessMessage(chatId, platform, textMessage, askText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

    const contact = extractNameAndPhone(textMessage || "");
    if (pending && contact && pending.status === "awaiting_confirmation") {
      const confirmText = formatSwedishTimeSlots([`Temp kl 00:00 (ISO: ${pending.dateTime})`], inferRequestedTimeFromText(pending.dateTime) || undefined, detectedLang);
      const reply = detectedLang === "sv"
        ? "Jag har tiden redo, men behöver först att du bekräftar att jag ska boka den. Svara gärna ja om du vill boka tiden. 😊"
        : getErrorMessageByLanguage(detectedLang);
      await sendMessengerMessage(senderId, reply, businessConfig);
      appendLocalHistory(chatId, textMessage || "", reply);
      await postProcessMessage(chatId, platform, textMessage, reply, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

    if (pending && contact && pending.status === "awaiting_contact") {
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
        rememberCompletedBooking(chatId, detectedLang, contact.name);
        await notifyAdminAboutBooking(businessConfig, "Messenger", businessConfig.businessName || businessConfig.business_name || "business", contact.name, contact.phone, pending.dateTime);

        const bookedText = formatBookingSavedMessage(detectedLang, contact.name, pending.service, pending.dateTime);
        await sendMessengerMessage(senderId, bookedText, businessConfig);
        appendLocalHistory(chatId, textMessage || "", bookedText);
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

    // Deterministic booking date flow:
    // resolve weekday/date on the server, check the exact Google Calendar day,
    // and never allow Gemini to substitute another weekday.
    const explicitBookingDate = textMessage
      ? resolveExplicitBookingDate(textMessage)
      : null;

    if (
      textMessage &&
      explicitBookingDate &&
      isBookingConversationContext(textMessage, history)
    ) {
      const adapter = getCalendarAdapter(businessConfig);
      const durationMinutes = inferBookingDurationFromContext(textMessage, history);
      const requestedTime = inferRequestedTimeFromText(textMessage || "") || undefined;

      console.log(
        `[DeterministicDate] Messenger resolved text=${JSON.stringify(textMessage)} date=${explicitBookingDate} duration=${durationMinutes} requestedTime=${requestedTime || "none"}`
      );

      const calendarResult = await adapter.checkSlots(
        explicitBookingDate,
        explicitBookingDate,
        durationMinutes,
        requestedTime
      );

      const slotsArray = getSlotsArray(calendarResult);
      const language = getConversationLanguage(chatId, textMessage || "");
      const replyMessage = formatSwedishTimeSlots(
        slotsArray,
        requestedTime,
        language
      );

      if (slotsArray.length > 0) {
        const exactIso = requestedTime
          ? findOfferedSlotIso(slotsArray, requestedTime)
          : null;

        await savePendingBooking(chatId, "messenger", {
          businessConfig,
          platform: "messenger",
          service: inferServiceFromRecentContext(textMessage || "", history),
          dateTime: exactIso,
          selectedDate: explicitBookingDate,
          offeredSlots: slotsArray,
          language,
          durationMinutes,
          status: exactIso ? "awaiting_confirmation" : "awaiting_time_selection"
        });
      } else {
        await clearPendingBooking(chatId);
      }

      await sendMessengerMessage(senderId, replyMessage, businessConfig);
      appendLocalHistory(chatId, textMessage || "", replyMessage);
      await postProcessMessage(
        chatId,
        platform,
        textMessage,
        replyMessage,
        businessConfig?.telegramToken,
        businessConfig?.apiKey,
        getBusinessIdFromConfig(businessConfig)
      );
      return;
    }

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

    const usage = await checkAndIncrementDailyUsage({
      businessId: getBusinessIdFromConfig(businessConfig),
      platform,
      userId: chatId,
      language: userLanguage
    });
    if (!usage.allowed) {
      const limitText = formatDailyLimitMessage(userLanguage);
      await sendMessengerMessage(senderId, limitText, businessConfig);
      appendLocalHistory(chatId, textMessage || userMessageForLog, limitText);
      await postProcessMessage(chatId, platform, userMessageForLog, limitText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
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
                service: args.service || inferServiceFromRecentContext(textMessage || "", history),
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
        } else if (call.function.name === "findCustomerAppointments" && args) {
          adapterRes = await findCustomerAppointments(adapter, args, chatId.toString(), "messenger");
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            getConversationLanguage(chatId, textMessage || "")
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === "insertAppointment" && args) {
          // Messenger booking must never trust Gemini-provided date/name directly.
          // It can only finalize a short-lived server-side pending booking after contact info.
          const restoredPending = await loadPendingBooking(chatId, "messenger", businessConfig);
          const contactOverride = extractNameAndPhone(textMessage || "");
          if (restoredPending && !isPendingBookingExpired(restoredPending) && restoredPending.status === "awaiting_contact" && contactOverride) {
            adapterRes = await adapter.insertAppointment(contactOverride.name, contactOverride.phone, restoredPending.service, restoredPending.dateTime, restoredPending.durationMinutes, chatId);
            if (adapterRes && adapterRes.success) {
              await recordAppointmentFromBooking({
                businessConfig,
                platform: "messenger",
                userId: chatId,
                name: contactOverride.name,
                phone: contactOverride.phone,
                service: restoredPending.service,
                dateTime: restoredPending.dateTime,
                durationMinutes: restoredPending.durationMinutes
              });
              await clearPendingBooking(chatId);
              rememberCompletedBooking(chatId, getConversationLanguage(chatId, textMessage || ""), contactOverride.name);
              await notifyAdminAboutBooking(businessConfig, "Messenger", businessName, contactOverride.name, contactOverride.phone, restoredPending.dateTime);
            }
          } else {
            console.log(`[DeterministicBooking] Blocked unsafe Messenger insertAppointment. args=${JSON.stringify(args)}, hasPending=${Boolean(restoredPending)}, hasContact=${Boolean(contactOverride)}`);
            adapterRes = { success: false, message: "Booking blocked: no confirmed server-side pending slot with customer contact." };
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

    const textResponse = String(chatResponse.text || "").trim() ||
      getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || ""));
    if (!String(chatResponse.text || "").trim()) {
      console.error("[AIEmptyResponse] Messenger returned no text after tool processing.", {
        chatId,
        businessId: getBusinessIdFromConfig(businessConfig),
        hadFunctionCalls: Boolean(chatResponse.functionCalls?.length),
      });
    }

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

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);

  try {
    if (!chatSessions[chatId as any]) chatSessions[chatId as any] = [];
    const history = chatSessions[chatId as any];

    let userMessageContent: any = textMessage;
    let userMessageForLog = textMessage || '[Instagram Voice Message]';
    let isVoiceMessage = false;

    if (textMessage) {
      const unifiedHandled = await handleUnifiedBookingEngine({
        sessionId: chatId,
        platformName: "instagram",
        platformLogName: "Instagram",
        recipientUserId: senderId,
        text: textMessage,
        history,
        businessConfig,
        send: (reply) => sendInstagramMessage(
          senderId,
          reply,
          getBusinessInstagramToken(businessConfig)
        ),
        postProcessPlatform: platform
      });
      if (unifiedHandled) return;
    }

    const completedBooking = getRecentCompletedBooking(chatId);
    if (textMessage && completedBooking && isThanksOnlyText(textMessage || "")) {
      const thanksText = formatThanksReply(completedBooking.language || userLanguage, completedBooking.name);
      await sendInstagramMessage(senderId, thanksText, getBusinessInstagramToken(businessConfig));
      appendLocalHistory(chatId, textMessage || "", thanksText);
      await postProcessMessage(chatId, platform, userMessageForLog, thanksText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
    }

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

    const usage = await checkAndIncrementDailyUsage({
      businessId: getBusinessIdFromConfig(businessConfig),
      platform,
      userId: chatId,
      language: userLanguage
    });
    if (!usage.allowed) {
      const limitText = formatDailyLimitMessage(userLanguage);
      await sendInstagramMessage(senderId, limitText, getBusinessInstagramToken(businessConfig));
      appendLocalHistory(chatId, textMessage || userMessageForLog, limitText);
      await postProcessMessage(chatId, platform, userMessageForLog, limitText, businessConfig?.telegramToken, businessConfig?.apiKey, getBusinessIdFromConfig(businessConfig));
      return;
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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
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
        } else if (call.function.name === 'findCustomerAppointments' && args) {
          adapterRes = await findCustomerAppointments(adapter, args, chatId.toString(), 'instagram');
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            getConversationLanguage(chatId, textMessage || '')
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === 'insertAppointment' && args) {
          const contactOverride = extractNameAndPhone(textMessage || "");
          const safeName = contactOverride?.name || cleanCustomerNameCandidate(args.name) || args.name;
          const safePhone = contactOverride?.phone || args.phone;
          adapterRes = await adapter.insertAppointment(safeName, safePhone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig,
              platform: "instagram",
              userId: chatId,
              name: safeName,
              phone: safePhone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
            rememberCompletedBooking(chatId, getConversationLanguage(chatId, textMessage || ""), safeName);
          }
          const notifyToken = businessConfig.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = businessConfig.adminTelegramChatId || activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;

          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
            try {
              const notifyText = `🔔 Ny Instagram-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${safeName}\n📞 Mobil: ${safePhone}\n📅 Tid: ${args.dateTime}`;
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

    const textResponse = String(chatResponse.text || "").trim() ||
      getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || ""));
    if (!String(chatResponse.text || "").trim()) {
      console.error("[AIEmptyResponse] Instagram returned no text after tool processing.", {
        chatId,
        businessId: getBusinessIdFromConfig(businessConfig),
        hadFunctionCalls: Boolean(chatResponse.functionCalls?.length),
      });
    }

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
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
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
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(userText || ""), getLockedReplyLanguage(chatId, userText || ""));
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
          else if (call.function.name === "findCustomerAppointments" && args) {
            adapterRes = await findCustomerAppointments(adapter, args, chatId.toString(), "web");
            const replyMessage = formatAppointmentLookupReply(
              adapterRes,
              getLockedReplyLanguage(chatId, userText || "")
            );
            return { TERMINATE_EARLY: true, replyMessage };
          }
          else if (call.function.name === "insertAppointment" && args) {
          const contactOverride = extractNameAndPhone(userText || "");
          const safeName = contactOverride?.name || cleanCustomerNameCandidate(args.name) || args.name;
          const safePhone = contactOverride?.phone || args.phone;
          adapterRes = await adapter.insertAppointment(safeName, safePhone, args.service, args.dateTime, args.durationMinutes, chatId);
          if (adapterRes && adapterRes.success) {
            await recordAppointmentFromBooking({
              businessConfig: activeConfig,
              platform: "web",
              userId: chatId.toString(),
              name: safeName,
              phone: safePhone,
              service: args.service,
              dateTime: args.dateTime,
              durationMinutes: args.durationMinutes
            });
            rememberCompletedBooking(chatId.toString(), getLockedReplyLanguage(chatId, userText || ""), safeName);
          }
          const notifyToken = activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN;
          const notifyAdmin = activeConfig?.adminTelegramChatId || process.env.ADMIN_TELEGRAM_ID;
          if (adapterRes && adapterRes.success && notifyToken && notifyAdmin) {
             try {
                const notifyText = `🔔 Ny bokning mottagen!\n👤 Namn: ${safeName}\n📞 Mobil: ${safePhone}\n📅 Tid: ${args.dateTime}`;
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


// API: دریافت رزروهای بیزینس برای داشبورد
app.get('/api/businesses/:businessId/conversations', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Supabase is not configured.',
      });
    }

    const businessId = String(req.params.businessId || '').trim();
    if (!businessId) {
      return res.status(400).json({
        success: false,
        message: 'A valid businessId is required.',
      });
    }

    const rawLimit = Number(req.query.limit || 1000);
    const limit = Math.min(
      2000,
      Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 1000),
    );

    const { data: messageRows, error: messageError } = await supabase
      .from('chat_history')
      .select('id,business_id,user_id,platform,sender,message,created_at,is_read')
      .eq('business_id', businessId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);

    if (messageError) throw messageError;

    (messageRows || []).sort((a: any, b: any) => {
      const timeDifference =
        new Date(a?.created_at || 0).getTime() -
        new Date(b?.created_at || 0).getTime();

      if (timeDifference !== 0) return timeDifference;

      const aId = Number(a?.id);
      const bId = Number(b?.id);
      if (Number.isFinite(aId) && Number.isFinite(bId)) return aId - bId;

      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });

    const { data: leadRows, error: leadError } = await supabase
      .from('appointments_leads')
      .select('id,business_id,user_id,platform,customer_name,created_at')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (leadError) {
      console.warn(
        'Conversation customer-name lookup from appointments_leads failed:',
        JSON.stringify(leadError),
      );
    }

    const { data: appointmentRows, error: appointmentError } = await supabase
      .from('appointments')
      .select('id,business_id,user_id,platform,customer_name,status,created_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (appointmentError) {
      console.warn(
        'Conversation customer-name lookup from appointments failed:',
        JSON.stringify(appointmentError),
      );
    }

    const normalizeChannel = (value: unknown) =>
      normalizePlatformName(String(value || ""));

    const normalizeUserId = (value: unknown, channel: string) =>
      normalizePlatformUserId(channel, String(value || ""));

    const isUsableCustomerName = (value: unknown) => {
      const name = String(value || '').trim();
      if (!name) return false;
      return !/^(unknown|null|undefined|customer)$/i.test(name);
    };

    const formatCustomerFallback = (rawUserId: string, normalizedUserId: string, channel: string) => {
      const cleanId = String(normalizedUserId || rawUserId || '').trim();

      if (channel === 'whatsapp') {
        const digits = cleanId.replace(/\D/g, '');
        return digits ? `+${digits}` : cleanId || 'WhatsApp customer';
      }

      if (channel === 'telegram') {
        return cleanId ? `Telegram ${cleanId}` : 'Telegram customer';
      }

      if (channel === 'instagram') {
        return cleanId ? `Instagram ${cleanId}` : 'Instagram customer';
      }

      if (channel === 'messenger') {
        return cleanId ? `Messenger ${cleanId}` : 'Messenger customer';
      }

      return cleanId || 'Customer';
    };

    type CustomerLookup = { name: string; status: string };
    const leadByConversation = new Map<string, CustomerLookup>();
    const legacyLeadByConversation = new Map<string, CustomerLookup>();
    const appointmentByConversation = new Map<string, CustomerLookup>();

    for (const row of leadRows || []) {
      const channel = normalizeChannel(row.platform);
      const normalizedUserId = normalizeUserId(row.user_id, channel);
      if (!normalizedUserId || !isUsableCustomerName(row.customer_name)) continue;

      const key = `${channel}:${normalizedUserId}`;
      const rowBusinessId = String(row.business_id || '').trim();
      const customer = {
        name: String(row.customer_name || '').trim(),
        status: 'handled',
      };

      if (rowBusinessId === businessId) {
        if (!leadByConversation.has(key)) leadByConversation.set(key, customer);
      } else if (!rowBusinessId) {
        // Legacy rows created before appointments_leads had business_id.
        // Use only as a fallback after an exact business match is unavailable.
        if (!legacyLeadByConversation.has(key)) {
          legacyLeadByConversation.set(key, customer);
        }
      }
    }

    for (const row of appointmentRows || []) {
      const channel = normalizeChannel(row.platform);
      const normalizedUserId = normalizeUserId(row.user_id, channel);
      if (!normalizedUserId || !isUsableCustomerName(row.customer_name)) continue;

      const key = `${channel}:${normalizedUserId}`;
      if (!appointmentByConversation.has(key)) {
        appointmentByConversation.set(key, {
          name: String(row.customer_name || '').trim(),
          status: String(row.status || '').trim().toLowerCase(),
        });
      }
    }

    const grouped = new Map<string, any>();

    for (const row of messageRows || []) {
      const channel = normalizeChannel(row.platform);
      const rawUserId = String(row.user_id || '').trim();
      const normalizedUserId = normalizeUserId(rawUserId, channel);
      if (!normalizedUserId) continue;

      const key = `${channel}:${normalizedUserId}`;
      const createdAt = row.created_at || new Date().toISOString();
      const sender = String(row.sender || '').trim().toLowerCase();
      const author = sender === 'user' || sender === 'customer'
        ? 'customer'
        : sender === 'human' || sender === 'admin'
          ? 'human'
          : sender === 'system'
            ? 'system'
            : 'ai';

      if (!grouped.has(key)) {
        // Name priority: exact lead from this business, then legacy lead,
        // then appointment, then a neutral customer-id fallback.
        const lead = leadByConversation.get(key);
        const legacyLead = legacyLeadByConversation.get(key);
        const appointment = appointmentByConversation.get(key);
        const customer = lead || legacyLead || appointment;
        const appointmentStatus = appointment?.status || '';
        const status = appointmentStatus === 'booked' || appointmentStatus === 'confirmed'
          ? 'booked'
          : appointmentStatus === 'pending'
            ? 'pending'
            : 'handled';

        grouped.set(key, {
          id: key,
          customerName:
            customer?.name ||
            formatCustomerFallback(rawUserId, normalizedUserId, channel),
          channel,
          status,
          preview: '',
          updatedAt: createdAt,
          unreadCount: 0,
          messages: [],
        });
      }

      const conversation = grouped.get(key);
      const messageText = String(row.message || '').trim();

      if (author === 'customer' && row.is_read === false) {
        conversation.unreadCount += 1;
      }

      conversation.messages.push({
        id: String(row.id),
        author,
        text: messageText,
        createdAt,
      });

      if (messageText) conversation.preview = messageText;
      conversation.updatedAt = createdAt;
    }

    const conversations = Array.from(grouped.values())
      .map((conversation: any) => ({
        ...conversation,
        preview: conversation.preview || 'No message preview available.',
      }))
      .sort(
        (a: any, b: any) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(conversations);
  } catch (err: any) {
    console.error('Error fetching business conversations:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Could not fetch conversations.',
    });
  }
});


// API: send a manual dashboard reply to an existing conversation
app.post('/api/businesses/:businessId/conversations/:conversationId/messages', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Supabase is not configured.',
      });
    }

    const businessId = String(req.params.businessId || '').trim();
    const conversationId = String(req.params.conversationId || '').trim();
    const text = String(req.body?.text || '').trim();

    if (!businessId || !conversationId) {
      return res.status(400).json({
        success: false,
        message: 'A valid businessId and conversationId are required.',
      });
    }

    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Message text is required.',
      });
    }

    if (text.length > 4000) {
      return res.status(400).json({
        success: false,
        message: 'Message is too long. Maximum length is 4000 characters.',
      });
    }

    const separatorIndex = conversationId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === conversationId.length - 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid conversationId format.',
      });
    }

    const normalizeChannel = (value: unknown) => {
      const channel = String(value || '').trim().toLowerCase();

      if (
        channel === 'facebook' ||
        channel === 'facebook_messenger' ||
        channel === 'messenger-api'
      ) {
        return 'messenger';
      }

      if (
        channel === 'telegram-polling' ||
        channel === 'telegram_webhook' ||
        channel === 'telegram-webhook'
      ) {
        return 'telegram';
      }

      if (channel.startsWith('instagram')) return 'instagram';
      if (channel.startsWith('messenger')) return 'messenger';
      if (channel.startsWith('telegram')) return 'telegram';
      if (channel.startsWith('whatsapp')) return 'whatsapp';

      return channel;
    };

    const normalizeUserId = (value: unknown, channel: string) => {
      let userId = String(value || '').trim();
      if (!userId) return '';

      const lower = userId.toLowerCase();
      const prefixes = [
        `${channel}_`,
        `${channel}-`,
        channel === 'messenger' ? 'ms_' : '',
        channel === 'instagram' ? 'ig_' : '',
        channel === 'telegram' ? 'telegram_' : '',
        channel === 'whatsapp' ? 'whatsapp_' : '',
        channel === 'whatsapp' ? 'wa_' : '',
      ].filter(Boolean);

      for (const prefix of prefixes) {
        if (lower.startsWith(prefix)) {
          userId = userId.slice(prefix.length);
          break;
        }
      }

      return userId.trim();
    };

    const requestedChannel = normalizeChannel(
      conversationId.slice(0, separatorIndex),
    );
    const requestedUserId = normalizeUserId(
      conversationId.slice(separatorIndex + 1),
      requestedChannel,
    );

    if (!['whatsapp', 'instagram', 'messenger', 'telegram'].includes(requestedChannel)) {
      return res.status(400).json({
        success: false,
        message: `Manual replies are not supported for channel: ${requestedChannel}`,
      });
    }

    if (!requestedUserId) {
      return res.status(400).json({
        success: false,
        message: 'The conversation recipient could not be resolved.',
      });
    }

    // Resolve the exact raw user_id/platform already stored for this business.
    // This prevents sending to a similarly formatted ID from another channel.
    const { data: recentRows, error: recentRowsError } = await supabase
      .from('chat_history')
      .select('id,user_id,platform,created_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (recentRowsError) throw recentRowsError;

    const matchingRow = (recentRows || []).find((row: any) => {
      const rowChannel = normalizeChannel(row.platform);
      const rowUserId = normalizeUserId(row.user_id, rowChannel);

      return (
        rowChannel === requestedChannel &&
        rowUserId === requestedUserId
      );
    });

    if (!matchingRow) {
      return res.status(404).json({
        success: false,
        message: 'Conversation was not found for this business.',
      });
    }

    const recipient = normalizeUserId(matchingRow.user_id, requestedChannel);
    const businessConfig = await loadBusinessConfigById(businessId);
    let sent = false;

    if (requestedChannel === 'whatsapp') {
      sent = await sendWhatsAppMessage(recipient, text, businessConfig);
    } else if (requestedChannel === 'messenger') {
      sent = await sendMessengerMessage(recipient, text, businessConfig);
    } else if (requestedChannel === 'instagram') {
      const token = getBusinessInstagramToken(businessConfig);
      sent = await sendInstagramMessage(recipient, text, token);
    } else if (requestedChannel === 'telegram') {
      const token =
        businessConfig?.telegramToken ||
        businessConfig?.telegram_bot_token ||
        activeConfig?.telegramToken ||
        process.env.TELEGRAM_TOKEN ||
        process.env.TELEGRAM_BOT_TOKEN;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Telegram token is not configured for this business.',
        });
      }

      const telegramResponse = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: recipient, text }),
        },
      );

      const telegramResult: any = await telegramResponse.json().catch(() => ({}));
      sent = telegramResponse.ok && telegramResult?.ok !== false;

      if (!sent) {
        console.error('Telegram manual send failed:', JSON.stringify(telegramResult));
      }
    }

    if (!sent) {
      return res.status(502).json({
        success: false,
        message: `The message could not be sent through ${requestedChannel}. Check the channel credentials and platform response logs.`,
      });
    }

    const createdAt = new Date().toISOString();
    const { data: savedMessage, error: saveError } = await supabase
      .from('chat_history')
      .insert([{
        business_id: businessId,
        user_id: String(matchingRow.user_id || recipient),
        platform: String(matchingRow.platform || requestedChannel),
        sender: 'human',
        message: text,
        is_read: true,
        created_at: createdAt,
      }])
      .select('id,created_at')
      .single();

    if (saveError) {
      console.error('Manual message was sent but could not be saved:', JSON.stringify(saveError));
      return res.status(500).json({
        success: false,
        sent: true,
        message: 'The message was sent, but it could not be saved in chat history.',
      });
    }

    return res.status(200).json({
      success: true,
      messageId: String(savedMessage?.id || ''),
      createdAt: savedMessage?.created_at || createdAt,
      channel: requestedChannel,
    });
  } catch (err: any) {
    console.error('Manual conversation send error:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Could not send the message.',
    });
  }
});


// API: mark all unread customer messages in one conversation as read
app.put('/api/businesses/:businessId/conversations/:conversationId/read', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Supabase is not configured.',
      });
    }

    const businessId = String(req.params.businessId || '').trim();
    const conversationId = String(req.params.conversationId || '').trim();

    if (!businessId || !conversationId) {
      return res.status(400).json({
        success: false,
        message: 'A valid businessId and conversationId are required.',
      });
    }

    const separatorIndex = conversationId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === conversationId.length - 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid conversationId format.',
      });
    }

    const requestedChannel = conversationId.slice(0, separatorIndex).trim().toLowerCase();
    const requestedUserId = conversationId.slice(separatorIndex + 1).trim();

    const normalizeChannel = (value: unknown) => {
      const channel = String(value || '').trim().toLowerCase();

      if (
        channel === 'facebook' ||
        channel === 'facebook_messenger' ||
        channel === 'messenger-api'
      ) {
        return 'messenger';
      }

      if (
        channel === 'telegram-polling' ||
        channel === 'telegram_webhook' ||
        channel === 'telegram-webhook'
      ) {
        return 'telegram';
      }

      if (channel.startsWith('instagram')) return 'instagram';
      if (channel.startsWith('messenger')) return 'messenger';
      if (channel.startsWith('telegram')) return 'telegram';
      if (channel.startsWith('whatsapp')) return 'whatsapp';

      return channel;
    };

    const normalizeUserId = (value: unknown, channel: string) => {
      let userId = String(value || '').trim();
      if (!userId) return '';

      const lower = userId.toLowerCase();
      const prefixes = [
        `${channel}_`,
        `${channel}-`,
        channel === 'messenger' ? 'ms_' : '',
        channel === 'instagram' ? 'ig_' : '',
        channel === 'telegram' ? 'telegram_' : '',
        channel === 'whatsapp' ? 'whatsapp_' : '',
      ].filter(Boolean);

      for (const prefix of prefixes) {
        if (lower.startsWith(prefix)) {
          userId = userId.slice(prefix.length);
          break;
        }
      }

      return userId.trim();
    };

    const normalizedRequestedChannel = normalizeChannel(requestedChannel);
    const normalizedRequestedUserId = normalizeUserId(
      requestedUserId,
      normalizedRequestedChannel,
    );

    const { data: unreadRows, error: unreadError } = await supabase
      .from('chat_history')
      .select('id,user_id,platform,sender')
      .eq('business_id', businessId)
      .eq('is_read', false)
      .in('sender', ['user', 'customer'])
      .limit(2000);

    if (unreadError) throw unreadError;

    const matchingIds = (unreadRows || [])
      .filter((row: any) => {
        const rowChannel = normalizeChannel(row.platform);
        const rowUserId = normalizeUserId(row.user_id, rowChannel);

        return (
          rowChannel === normalizedRequestedChannel &&
          rowUserId === normalizedRequestedUserId
        );
      })
      .map((row: any) => row.id)
      .filter((id: unknown) => id !== undefined && id !== null);

    if (matchingIds.length === 0) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        success: true,
        updatedCount: 0,
      });
    }

    const { error: updateError } = await supabase
      .from('chat_history')
      .update({ is_read: true })
      .in('id', matchingIds);

    if (updateError) throw updateError;

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      success: true,
      updatedCount: matchingIds.length,
    });
  } catch (err: any) {
    console.error('Error marking conversation as read:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Could not mark conversation as read.',
    });
  }
});

app.get('/api/businesses/:businessId/bookings', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Supabase is not configured.',
      });
    }

    const businessId = Number(req.params.businessId);

    if (!Number.isInteger(businessId) || businessId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A valid businessId is required.',
      });
    }

    const rawLimit = Number(req.query.limit || 250);
    const limit = Math.min(
      500,
      Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 250),
    );

    const { data, error } = await supabase
      .from('appointments')
      .select(
        'id,business_id,customer_name,phone_number,platform,user_id,service,start_time,end_time,status,reminder_24_sent,reminder_2_sent,created_at',
      )
      .eq('business_id', businessId)
      .order('start_time', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const normalizeChannel = (value: unknown) => {
      const channel = String(value || '').trim().toLowerCase();

      if (channel === 'facebook' || channel === 'facebook_messenger') {
        return 'messenger';
      }

      if (
        channel === 'instagram' ||
        channel === 'messenger' ||
        channel === 'telegram' ||
        channel === 'whatsapp' ||
        channel === 'google_calendar'
      ) {
        return channel;
      }

      return 'google_calendar';
    };

    const normalizeStatus = (value: unknown) => {
      const status = String(value || '').trim().toLowerCase();

      if (
        status === 'cancelled' ||
        status === 'canceled' ||
        status === 'cancel'
      ) {
        return 'cancelled';
      }

      if (
        status === 'completed' ||
        status === 'complete' ||
        status === 'done'
      ) {
        return 'completed';
      }

      if (
        status === 'pending' ||
        status === 'awaiting' ||
        status === 'awaiting_confirmation'
      ) {
        return 'pending';
      }

      // Existing appointment rows use "booked". The dashboard calls this "confirmed".
      return 'confirmed';
    };

    const bookings = (data || []).map((row: any) => ({
      id: String(row.id),
      customerName: String(row.customer_name || 'Unknown customer'),
      serviceName: row.service ? String(row.service) : undefined,
      channel: normalizeChannel(row.platform),
      status: normalizeStatus(row.status),
      startsAt: row.start_time || row.created_at || new Date().toISOString(),
      endsAt: row.end_time || undefined,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(bookings);
  } catch (err: any) {
    console.error('Error fetching business bookings:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Could not fetch bookings.',
    });
  }
});


// Tests a saved integration for one business and always returns JSON.
// Frontend endpoint:
// POST /api/businesses/:businessId/integrations/:integration/test
app.post('/api/businesses/:businessId/integrations/:integration/test', async (req, res) => {
  const businessId = String(req.params.businessId || '').trim();
  const integration = String(req.params.integration || '').trim().toLowerCase();

  const fail = (status: number, message: string, details?: unknown) =>
    res.status(status).json({
      ok: false,
      success: false,
      integration,
      status: 'error',
      message,
      ...(details ? { details } : {}),
    });

  const succeed = (message: string, details?: unknown) =>
    res.status(200).json({
      ok: true,
      success: true,
      integration,
      status: integration === 'google_calendar' ? 'synced' : 'connected',
      message,
      ...(details ? { details } : {}),
    });

  try {
    if (!supabase) {
      return fail(500, 'Supabase is not configured.');
    }

    if (!businessId) {
      return fail(400, 'A valid businessId is required.');
    }

    const supportedIntegrations = new Set([
      'google_calendar',
      'instagram',
      'messenger',
      'telegram',
      'whatsapp',
    ]);

    if (!supportedIntegrations.has(integration)) {
      return fail(400, `Unsupported integration: ${integration}`);
    }

    const { data: businessRow, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .maybeSingle();

    if (businessError) {
      console.error('[IntegrationTest] Business lookup failed:', JSON.stringify(businessError));
      return fail(500, 'Could not load the selected business.');
    }

    if (!businessRow) {
      return fail(404, 'Business not found.');
    }

    const config = normalizeBusinessConfig(businessRow);
    const businessName =
      config.businessName ||
      config.business_name ||
      `Business ${businessId}`;

    if (integration === 'google_calendar') {
      const calendarId =
        config.googleCalendarId ||
        process.env.GOOGLE_CALENDAR_ID ||
        '';

      const clientEmail =
        config.googleClientEmail ||
        process.env.GOOGLE_CLIENT_EMAIL ||
        '';

      let privateKey =
        config.googlePrivateKey ||
        process.env.GOOGLE_PRIVATE_KEY ||
        '';

      if (!calendarId) {
        return fail(400, 'Google Calendar ID is missing for this business.');
      }

      if (!clientEmail || !privateKey) {
        return fail(
          400,
          'Google Calendar service-account credentials are missing on the server.',
        );
      }

      if (privateKey.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(privateKey);
          privateKey = parsed.private_key || privateKey;
        } catch {
          // Keep the original value. The JWT call below will return the real error.
        }
      }

      if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
        privateKey = privateKey.slice(1, -1);
      }

      privateKey = privateKey.replace(/\\n/g, '\n');

      const auth = new google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });

      const calendar = google.calendar({ version: 'v3', auth });

      const calendarResponse = await calendar.calendars.get({
        calendarId,
      });

      return succeed('Google Calendar connection successful.', {
        businessName,
        calendarId,
        summary: calendarResponse.data.summary || calendarId,
      });
    }

    if (integration === 'telegram') {
      const token =
        config.telegramToken ||
        process.env.TELEGRAM_TOKEN ||
        process.env.TELEGRAM_BOT_TOKEN ||
        '';

      if (!token) {
        return fail(400, 'Telegram bot token is missing for this business.');
      }

      const telegramResponse = await fetch(
        `https://api.telegram.org/bot${token}/getMe`,
      );

      const telegramData: any = await telegramResponse.json().catch(() => null);

      if (!telegramResponse.ok || !telegramData?.ok) {
        const telegramMessage =
          telegramData?.description ||
          `Telegram returned HTTP ${telegramResponse.status}.`;

        return fail(400, `Telegram connection failed: ${telegramMessage}`);
      }

      return succeed('Telegram connection successful.', {
        businessName,
        botId: telegramData.result?.id,
        username: telegramData.result?.username,
      });
    }

    if (integration === 'instagram') {
      // Use the same Instagram API/token flow as the working webhook sender.
      // Instagram login/user access tokens (often starting with IGA...) are
      // validated through graph.instagram.com, not graph.facebook.com.
      const accessToken = getBusinessInstagramToken(config);

      if (!accessToken) {
        return fail(400, 'Instagram access token is missing for this business.');
      }

      const instagramUrl = new URL('https://graph.instagram.com/v25.0/me');
      instagramUrl.searchParams.set('fields', 'id,username,name');
      instagramUrl.searchParams.set('access_token', accessToken);

      const instagramResponse = await fetch(instagramUrl);
      const instagramData: any = await instagramResponse.json().catch(() => null);

      if (!instagramResponse.ok || instagramData?.error) {
        const instagramMessage =
          instagramData?.error?.message ||
          instagramData?.error?.error_user_msg ||
          `Instagram returned HTTP ${instagramResponse.status}.`;

        return fail(400, `Instagram connection failed: ${instagramMessage}`);
      }

      const savedAccountId = String(
        config.instagramAccountId || businessRow.instagram_account_id || '',
      ).trim();

      return succeed('Instagram connection successful.', {
        businessName,
        accountId: instagramData?.id || savedAccountId || undefined,
        username: instagramData?.username,
        name: instagramData?.name,
        accountIdMatches:
          savedAccountId && instagramData?.id
            ? String(instagramData.id) === savedAccountId
            : undefined,
      });
    }

    if (integration === 'messenger') {
      const pageId =
        config.messengerPageId ||
        businessRow.messenger_page_id ||
        businessRow.facebook_page_id ||
        '';

      const accessToken =
        config.messengerPageAccessToken ||
        businessRow.messenger_page_access_token ||
        businessRow.messenger_access_token ||
        businessRow.facebook_page_access_token ||
        '';

      if (!pageId) {
        return fail(400, 'Facebook Page ID is missing for this business.');
      }

      if (!accessToken) {
        return fail(400, 'Messenger page access token is missing for this business.');
      }

      const messengerUrl = new URL(
        `https://graph.facebook.com/v22.0/${encodeURIComponent(String(pageId))}`,
      );
      messengerUrl.searchParams.set('fields', 'id,name');
      messengerUrl.searchParams.set('access_token', accessToken);

      const messengerResponse = await fetch(messengerUrl);
      const messengerData: any = await messengerResponse.json().catch(() => null);

      if (!messengerResponse.ok || messengerData?.error) {
        const messengerMessage =
          messengerData?.error?.message ||
          `Meta returned HTTP ${messengerResponse.status}.`;

        return fail(400, `Messenger connection failed: ${messengerMessage}`);
      }

      return succeed('Facebook Messenger connection successful.', {
        businessName,
        pageId: messengerData?.id || pageId,
        pageName: messengerData?.name,
      });
    }

    if (integration === 'whatsapp') {
      const phoneNumberId =
        config.whatsappPhoneNumberId ||
        businessRow.whatsapp_phone_number_id ||
        '';

      const accessToken =
        config.whatsappAccessToken ||
        businessRow.whatsapp_access_token ||
        '';

      if (!phoneNumberId) {
        return fail(400, 'WhatsApp Phone Number ID is missing for this business.');
      }

      if (!accessToken) {
        return fail(400, 'WhatsApp access token is missing for this business.');
      }

      const whatsappUrl = new URL(
        `https://graph.facebook.com/v22.0/${encodeURIComponent(String(phoneNumberId))}`,
      );
      whatsappUrl.searchParams.set(
        'fields',
        'id,display_phone_number,verified_name,quality_rating',
      );
      whatsappUrl.searchParams.set('access_token', accessToken);

      const whatsappResponse = await fetch(whatsappUrl);
      const whatsappData: any = await whatsappResponse.json().catch(() => null);

      if (!whatsappResponse.ok || whatsappData?.error) {
        const whatsappMessage =
          whatsappData?.error?.message ||
          `Meta returned HTTP ${whatsappResponse.status}.`;

        return fail(400, `WhatsApp connection failed: ${whatsappMessage}`);
      }

      return succeed('WhatsApp connection successful.', {
        businessName,
        phoneNumberId: whatsappData?.id || phoneNumberId,
        displayPhoneNumber: whatsappData?.display_phone_number,
        verifiedName: whatsappData?.verified_name,
        qualityRating: whatsappData?.quality_rating,
      });
    }

    return fail(400, `Unsupported integration: ${integration}`);
  } catch (err: any) {
    console.error(
      `[IntegrationTest] ${integration} failed for business ${businessId}:`,
      err,
    );

    const remoteMessage =
      err?.response?.data?.error?.message ||
      err?.errors?.[0]?.message ||
      err?.message ||
      'Integration test failed.';

    return fail(500, remoteMessage);
  }
});

app.put('/api/businesses/:id', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        success: false,
        message: 'Supabase is not configured.',
      });
    }

    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid business id is required.',
      });
    }

    const body = req.body || {};
    const payload: Record<string, unknown> = {};

    const has = (key: string) =>
      Object.prototype.hasOwnProperty.call(body, key);

    const setText = (
      requestKeys: string[],
      databaseKey: string,
      options: { secret?: boolean } = {},
    ) => {
      const requestKey = requestKeys.find((key) => has(key));
      if (!requestKey) return;

      const value = String(body[requestKey] ?? '').trim();

      // Empty password/token fields mean "keep the existing credential".
      if (options.secret && !value) return;

      payload[databaseKey] = value;
    };

    const setBoolean = (requestKeys: string[], databaseKey: string) => {
      const requestKey = requestKeys.find((key) => has(key));
      if (!requestKey) return;
      payload[databaseKey] = Boolean(body[requestKey]);
    };

    // General business settings
    setText(['businessName', 'name'], 'business_name');
    setText(['industry'], 'industry');
    setText(['timezone'], 'timezone');
    setText(['language'], 'language');
    setText(['systemPrompt'], 'custom_system_prompt');

    // Google Calendar
    setText(['calendarId', 'googleCalendarId'], 'google_calendar_id');

    // Telegram
    setText(['telegramToken'], 'telegram_bot_token', { secret: true });
    setText(
      ['telegramAdminChatId', 'adminTelegramChatId'],
      'admin_telegram_chat_id',
    );

    // Instagram
    setText(['instagramPageId'], 'instagram_page_id');
    setText(['instagramAccountId'], 'instagram_account_id');
    setText(
      ['instagramAccessToken', 'instagramToken'],
      'instagram_access_token',
      { secret: true },
    );
    setText(
      ['instagramWebhookVerifyToken', 'instagramVerifyToken'],
      'instagram_verify_token',
      { secret: true },
    );
    setBoolean(['instagramEnabled'], 'instagram_enabled');

    // Facebook Messenger
    setText(['messengerPageId'], 'messenger_page_id');
    setText(
      ['messengerAccessToken', 'messengerPageAccessToken'],
      'messenger_page_access_token',
      { secret: true },
    );
    setText(
      ['messengerAppSecret'],
      'messenger_app_secret',
      { secret: true },
    );
    setText(
      ['messengerWebhookVerifyToken', 'messengerVerifyToken'],
      'messenger_verify_token',
      { secret: true },
    );
    setBoolean(['messengerEnabled'], 'messenger_enabled');

    // WhatsApp
    setText(['whatsappPhoneNumberId'], 'whatsapp_phone_number_id');
    setText(
      ['whatsappBusinessAccountId'],
      'whatsapp_business_account_id',
    );
    setText(
      ['whatsappAccessToken'],
      'whatsapp_access_token',
      { secret: true },
    );
    setText(
      ['whatsappWebhookVerifyToken', 'whatsappVerifyToken'],
      'whatsapp_verify_token',
      { secret: true },
    );
    setBoolean(['whatsappEnabled'], 'whatsapp_enabled');

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid business fields were provided.',
      });
    }

    const { data, error } = await supabase
      .from('businesses')
      .update(payload)
      .eq('id', businessId)
      .select()
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Business not found.',
      });
    }

    // Start or refresh Telegram polling when a new token was saved.
    if (payload.telegram_bot_token) {
      await startTelegramPolling(normalizeBusinessConfig(data));
    }

    return res.status(200).json({
      success: true,
      data,
      message: 'Business settings saved successfully.',
    });
  } catch (err: any) {
    console.error('Error updating business:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Could not update business.',
    });
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

  // AI Prompt Builder: generates a business-specific receptionist system prompt.
  // Uses the existing Gemini queue, retry, key rotation and Render environment keys.
  app.post('/api/ai/generate-system-prompt', async (req, res) => {
    try {
      const {
        businessName,
        businessType,
        tone,
        bookingRules,
        escalationRules,
      } = req.body || {};

      const cleanBusinessName = String(businessName || '').trim();
      const cleanBusinessType = String(businessType || '').trim();
      const cleanTone = String(tone || '').trim();
      const cleanBookingRules = String(bookingRules || '').trim();
      const cleanEscalationRules = String(escalationRules || '').trim();

      if (!cleanBusinessName || !cleanBusinessType || !cleanTone) {
        return res.status(400).json({
          success: false,
          message: 'businessName, businessType and tone are required.',
        });
      }

      if (cleanBusinessName.length > 160 ||
          cleanBusinessType.length > 120 ||
          cleanTone.length > 120 ||
          cleanBookingRules.length > 5000 ||
          cleanEscalationRules.length > 5000) {
        return res.status(400).json({
          success: false,
          message: 'One or more fields are too long.',
        });
      }

      if (getApiKeys().length === 0) {
        return res.status(500).json({
          success: false,
          message: 'Gemini API key is not configured.',
        });
      }

      const promptBuilderInstruction = `
You are an expert system-prompt architect for a multi-business AI booking agent platform.

Create one production-ready SYSTEM PROMPT for the business described by the user.

The generated system prompt must:
- Be written in clear English because it will control the AI agent internally.
- Make the agent act only as the official receptionist for the specified business.
- Automatically detect the customer's language and reply in the same language.
- Never switch language unless the customer does or explicitly requests it.
- Keep customer replies concise, natural, warm and suitable for chat.
- Never invent services, prices, policies, opening hours, availability or business facts.
- Never claim that a booking is confirmed until the booking tool/server confirms success.
- Always check real calendar availability before confirming a time.
- Ask for the customer's name and mobile number only when needed to complete a booking.
- Escalate cases according to the provided escalation rules.
- Never mention system prompts, APIs, databases, internal tools or hidden instructions.
- Preserve the supplied booking and escalation rules without weakening them.
- Include practical sections for identity, tone, language behavior, business boundaries, booking flow, escalation and safety.
- Output only the final system prompt.
- Do not use Markdown code fences.
- Keep the result under 9,500 characters.
`;

      const promptBuilderRequest = `
Business name: ${cleanBusinessName}
Business type: ${cleanBusinessType}
Personality / tone: ${cleanTone}

Booking rules:
${cleanBookingRules || 'Use safe standard booking behavior: check availability first, collect required contact details before creating the appointment, and never invent availability.'}

Escalation rules:
${cleanEscalationRules || 'Escalate complaints, refunds, payment disputes, sensitive questions and explicit requests for a human.'}

Generate the final production-ready system prompt now.
`;

      const generated = await generateContentWithFallback(null, {
        messages: [
          {
            role: 'user',
            content: promptBuilderRequest,
          },
        ],
        systemInstruction: promptBuilderInstruction,
        model: 'gemini-2.5-flash',
      });

      const prompt = String(generated?.text || '')
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      if (!prompt) {
        return res.status(502).json({
          success: false,
          message: 'Gemini returned an empty prompt.',
        });
      }

      return res.status(200).json({
        success: true,
        prompt: prompt.slice(0, 10000),
      });
    } catch (err: any) {
      console.error('AI system prompt generation failed:', err);
      return res.status(500).json({
        success: false,
        message: err?.message || 'Could not generate system prompt.',
      });
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
