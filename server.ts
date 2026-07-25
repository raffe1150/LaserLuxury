
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
import {
  InMemoryKnowledgeStorage,
  KnowledgeService,
  SupabaseKnowledgeStorage,
  isKnowledgeSourceStatus,
  isKnowledgeSourceType,
} from "./knowledge";
import type {
  AppointmentLookupMode,
  AppointmentStateOwner,
} from "./booking-security";
import {
  appointmentIdentityKeyConflicts,
  appointmentStateOwnerMatches,
  detectAppointmentLookupMode,
  isActiveAppointmentStatus,
  isAppointmentLookupFollowUp,
  isDirectAppointmentLookupPhrase,
  isDirectReschedulePhrase,
  isExplicitNewBookingRequest,
  selectSecureAppointmentRows,
  selectSecureCalendarEvents,
} from "./booking-security";

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

const knowledgeService = new KnowledgeService(
  supabase && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseKnowledgeStorage(supabase)
    : new InMemoryKnowledgeStorage()
);

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

async function transcribeVoiceMessageForFlow(audioContent: any): Promise<string | null> {
  try {
    const response = await generateContentWithFallback(null, {
      messages: [{ role: "user", content: audioContent }],
      systemInstruction:
        "Transcribe the customer's spoken message exactly in its spoken language. " +
        "Return only the transcript, without a label, translation, explanation, markdown, or quotation marks.",
      model: "gemini-2.5-flash"
    });
    const transcript = String(response?.text || "")
      .trim()
      .replace(/^(?:transcript|transcription)\s*:\s*/i, "")
      .replace(/^["“]|["”]$/g, "")
      .trim();
    return transcript ? transcript.slice(0, 2000) : null;
  } catch (error) {
    console.error("[VoiceLanguage] transcription failed; continuing with the existing language lock:", error);
    return null;
  }
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
  insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes?: number, chatId?: string, skipConflictCheck?: boolean): Promise<any> | any;
  updateAppointment?(eventId: string, dateTime: string, durationMinutes?: number): Promise<any> | any;
  cancelAppointment?(eventId: string): Promise<any> | any;
  getEventById?(eventId: string): Promise<any | null> | any | null;
  verifyEventDeleted?(eventId: string): Promise<boolean> | boolean;
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

function getAppointmentBusinessScope(config: any): string {
  const businessId = getBusinessIdFromConfig(config);
  if (businessId) return String(businessId);

  const calendarId = String(config?.googleCalendarId || config?.google_calendar_id || "").trim();
  return calendarId ? `calendar:${calendarId}` : "";
}

function normalizeLocalizedDigits(value?: string): string {
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  return String(value || "")
    .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)));
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
  const raw = normalizeLocalizedDigits(String(input)).trim().toLowerCase();
  const match = raw.match(/(\d{1,2})\s*[\.:]?\s*(\d{2})?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function inferRequestedTimeFromText(text?: string): string | null {
  if (!text) return null;
  const raw = normalizeLocalizedDigits(String(text)).trim().toLowerCase();

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

type RescheduleTimeFollowUp = {
  explicitTime: string | null;
  rejectedTimes: string[];
  rejectsCurrentSelection: boolean;
  afterTime: string | null;
  boundary: TimeBoundary | null;
};

type TimeBoundaryKind =
  | "exclusive_lower"
  | "inclusive_lower"
  | "exclusive_upper"
  | "inclusive_upper"
  | "approximate";

type TimeBoundary = {
  kind: TimeBoundaryKind;
  time: string;
};

function parseRescheduleTimeFollowUp(text?: string): RescheduleTimeFollowUp {
  const raw = normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .replace(/\u200c/g, " ")
    .replace(/\s+/g, " ");
  if (!raw) {
    return {
      explicitTime: null,
      rejectedTimes: [],
      rejectsCurrentSelection: false,
      afterTime: null,
      boundary: null
    };
  }

  const normalizeToken = (
    hourValue?: string,
    minuteValue?: string,
    meridiemValue?: string
  ): string | null => {
    let hour = Number(hourValue);
    const minute = Number(minuteValue || 0);
    if (!hourValue || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const meridiem = String(meridiemValue || "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };
  const timeToken = String.raw`([01]?\d|2[0-3])(?:[\.:](\d{2}))?\s*(am|pm)?`;
  const rejectedTimes: string[] = [];
  const negativePatterns = [
    new RegExp(String.raw`(?:not|don['’]?t\s+want|do\s+not\s+want|cannot|can['’]?t|inte|vill\s+inte\s+ha|kan\s+inte|nicht|lieber\s+nicht|kann\s+ich\s+nicht|no\s+(?:a\s+las|quiero)|no\s+puedo|ليس|لا\s+(?:أريد|استطيع|أستطيع)|نمی[\u200c\s]?(?:خوام|خواهم|تونم|توانم)|نمي\s*(?:خوام|تونم)|اون\s+ساعت\s+نه|آن\s+ساعت\s+نه)[^\d]{0,24}${timeToken}`, "giu"),
    new RegExp(String.raw`${timeToken}[^\d]{0,24}(?:doesn['’]?t\s+work|won['’]?t\s+work|går\s+inte|gar\s+inte|passar\s+inte|geht\s+nicht|no\s+me\s+va|no\s+puedo|مناسب\s+نیست|نمی[\u200c\s]?(?:شه|خوام|خواهم|تونم|توانم)|nemikham|nemitonam|لا\s+يناسب|لا\s+أريده)`, "giu")
  ];
  for (const pattern of negativePatterns) {
    for (const match of raw.matchAll(pattern)) {
      const normalized = normalizeToken(match[1], match[2], match[3]);
      if (normalized && !rejectedTimes.includes(normalized)) rejectedTimes.push(normalized);
    }
  }

  const allTimes: string[] = [];
  for (const match of raw.matchAll(/(?:^|[^\d])([01]?\d|2[0-3])[\.:](\d{2})\s*(am|pm)?(?!\d)/gu)) {
    const normalized = normalizeToken(match[1], match[2], match[3]);
    if (normalized && !allTimes.includes(normalized)) allTimes.push(normalized);
  }
  const inferred = inferRequestedTimeFromText(raw);
  if (inferred && !allTimes.includes(inferred)) allTimes.push(inferred);
  const positiveBare = raw.match(
    new RegExp(String.raw`(?:want|prefer|instead|vill\s+ha|hellre|istället|lieber|besser|prefiero|mejor|أريد|أفضل|می[\u200c\s]?خوام|ترجیح\s+می[\u200c\s]?دم)[^\d]{0,16}${timeToken}`, "iu")
  );
  const positiveBareTime = positiveBare
    ? normalizeToken(positiveBare[1], positiveBare[2], positiveBare[3])
    : null;
  if (positiveBareTime && !allTimes.includes(positiveBareTime)) allTimes.push(positiveBareTime);

  const boundaryPatterns: Array<[TimeBoundaryKind, RegExp]> = [
    [
      "exclusive_lower",
      new RegExp(
        String.raw`(?:after|later\s+than|efter(?:\s+kl(?:ockan)?)?|senare\s+[aä]n|nach|sp[aä]ter\s+als|despu[eé]s\s+de(?:\s+las)?|m[aá]s\s+tarde\s+que|bade?(?:\s+az)?(?:\s+saat)?|بعد\s+از(?:\s+ساعت)?|دیرتر\s+از|بعد\s+الساعة)\s*${timeToken}`,
        "iu"
      )
    ],
    [
      "inclusive_lower",
      new RegExp(
        String.raw`(?:from|starting\s+(?:at|from)|fr[oå]n(?:\s+kl(?:ockan)?)?|ab|desde(?:\s+las)?|az(?:\s+saat)?|از\s+(?:ساعت\s*)?|من\s+الساعة)\s*${timeToken}(?:\s*(?:onward|onwards|or\s+later|och\s+senare|eller\s+senare|aufw[aä]rts|en\s+adelante|be\s+bad|به\s+بعد|فصاعد[ااً]?))?`,
        "iu"
      )
    ],
    [
      "inclusive_upper",
      new RegExp(
        String.raw`(?:until|no\s+later\s+than|senast(?:\s+kl(?:ockan)?)?|bis(?:\s+sp[aä]testens)?|hasta(?:\s+las)?|ta(?:\s+saat)?|تا(?:\s+ساعت)?|حتى\s+الساعة)\s*${timeToken}|${timeToken}\s*(?:or\s+earlier|eller\s+tidigare|oder\s+fr[uü]her|o\s+antes|یا\s+زودتر|أو\s+قبل)`,
        "iu"
      )
    ],
    [
      "exclusive_upper",
      new RegExp(
        String.raw`(?:before|earlier\s+than|f[oö]re(?:\s+kl(?:ockan)?)?|vor|antes\s+de(?:\s+las)?|pish\s+az(?:\s+saat)?|قبل\s+از(?:\s+ساعت)?|قبل\s+الساعة)\s*${timeToken}`,
        "iu"
      )
    ],
    [
      "approximate",
      new RegExp(
        String.raw`(?:around|about|cirka|ungef[aä]r|gegen|aproximadamente|sobre\s+las|hodude?|حدود(?:\s+ساعت)?|تقریباً|تقريبا|حوالي\s+الساعة)\s*${timeToken}`,
        "iu"
      )
    ]
  ];
  let boundary: TimeBoundary | null = null;
  for (const [kind, pattern] of boundaryPatterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    let boundaryTime: string | null = null;
    for (let index = 1; index < match.length; index += 3) {
      if (!match[index]) continue;
      boundaryTime = normalizeToken(
        match[index],
        match[index + 1],
        match[index + 2]
      );
      if (boundaryTime) break;
    }
    if (boundaryTime) {
      boundary = { kind, time: boundaryTime };
      break;
    }
  }
  const afterTime = boundary?.kind === "exclusive_lower" ? boundary.time : null;
  const negativeWithoutTime = /(?:cannot|can['’]?t|kan\s+inte|inte\s+då|inte\s+da|kann\s+ich\s+nicht|no\s+puedo|لا\s+(?:استطيع|أستطيع)|نمی[\u200c\s]?(?:تونم|توانم)|اون\s+موقع\s+نه|آن\s+موقع\s+نه)/iu.test(raw);
  const explicitTime = [...allTimes]
    .reverse()
    .find((time) =>
      !rejectedTimes.includes(time) &&
      (!boundary || boundary.kind === "approximate" || time !== boundary.time)
    ) || (boundary?.kind === "approximate" ? boundary.time : null);

  return {
    explicitTime,
    rejectedTimes,
    rejectsCurrentSelection: negativeWithoutTime || rejectedTimes.length > 0,
    afterTime,
    boundary
  };
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
    const times = [...timesRaw].sort((a, b) => a.localeCompare(b, "sv-SE"));
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

async function verifyExactSlotIsFree(
  adapter: CalendarAdapter,
  dateTime: string,
  durationMinutes: number
): Promise<{ free: boolean; normalizedIso: string | null; reason?: string }> {
  const normalizedIso = ensureStockholmOffset(String(dateTime || "").trim());
  const start = new Date(normalizedIso);
  const duration = Number(durationMinutes || 0);

  if (Number.isNaN(start.getTime()) || !Number.isFinite(duration) || duration <= 0) {
    return { free: false, normalizedIso: null, reason: "invalid_slot" };
  }

  const dateStr = stockholmDateString(start);
  const events = await adapter.getEvents(dateStr, dateStr);
  const free = isSlotFree(start.getTime(), duration, Array.isArray(events) ? events : []);

  console.log(`[ExactSlotCheck] dateTime=${normalizedIso}, duration=${duration}, events=${Array.isArray(events) ? events.length : 0}, free=${free}`);
  return { free, normalizedIso, reason: free ? undefined : "calendar_conflict" };
}

type SlotSearchOptions = {
  minTime?: string;
  maxTime?: string;
  afterTime?: string;
  timeBoundary?: TimeBoundary;
  excludedTimes?: string[];
  selectFirstAvailable?: boolean;
};

const BOOKING_OPEN_MINUTES = 9 * 60;
const BOOKING_CLOSE_MINUTES = 20 * 60;
const BOOKING_INTERVAL_MINUTES = 15;

type BookingSlotOwner = {
  businessId: string;
  platform: string;
  userId: string;
  sessionId: string;
};

type OwnedOfferedSlot = {
  start: string;
  end: string;
  durationMinutes: number;
  service: string;
  businessId: string;
  platform: string;
  userId: string;
  generatedAt: number;
  searchStartDate?: string;
  searchEndDate?: string;
};

type ExactSlotValidationResult = {
  free: boolean;
  category:
    | "available"
    | "invalid_slot"
    | "outside_working_hours"
    | "invalid_interval"
    | "calendar_conflict"
    | "pending_conflict"
    | "ownership_mismatch"
    | "stale_offer";
  normalizedIso: string | null;
  endIso: string | null;
};

function bookingSlotOwnerMatches(slot: OwnedOfferedSlot, owner: BookingSlotOwner): boolean {
  return Boolean(
    slot.businessId &&
    slot.businessId === owner.businessId &&
    normalizePlatformName(slot.platform) === normalizePlatformName(owner.platform) &&
    normalizePlatformUserId(slot.platform, slot.userId) ===
      normalizePlatformUserId(owner.platform, owner.userId)
  );
}

function getPendingBookingBlockingEvents(
  owner: BookingSlotOwner,
  startMs: number,
  endMs: number
): any[] {
  return Object.entries(pendingBookings)
    .filter(([sessionId, pending]) => {
      if (sessionId === owner.sessionId || !pending || isPendingBookingExpired(pending)) return false;
      if (!["awaiting_confirmation", "awaiting_contact", "inserting"].includes(String(pending.status || ""))) return false;
      const pendingBusinessId = String(
        pending.businessId ||
        getBusinessIdFromConfig(pending.businessConfig) ||
        ""
      );
      const pendingPlatform = normalizePlatformName(pending.platform || "");
      const pendingUserId = normalizePlatformUserId(pendingPlatform, String(pending.userId || ""));
      if (
        pendingBusinessId !== owner.businessId ||
        !pendingPlatform ||
        !pendingUserId
      ) return false;
      const pendingStart = new Date(ensureStockholmOffset(String(pending.dateTime || ""))).getTime();
      const pendingDuration = Number(pending.durationMinutes || 0);
      const pendingEnd = pendingStart + pendingDuration * 60000;
      return Number.isFinite(pendingStart) && pendingDuration > 0 && pendingStart < endMs && pendingEnd > startMs;
    })
    .map(([, pending]) => ({
      startTime: ensureStockholmOffset(String(pending.dateTime || "")),
      endTime: new Date(
        new Date(ensureStockholmOffset(String(pending.dateTime || ""))).getTime() +
        Number(pending.durationMinutes || 0) * 60000
      ).toISOString(),
      summary: "Pending appointment hold"
    }));
}

async function validateCanonicalExactSlot(params: {
  adapter: CalendarAdapter;
  owner: BookingSlotOwner;
  businessConfig: any;
  start: string;
  service: string;
  durationMinutes: number;
  excludeEventId?: string;
  offeredSlot?: OwnedOfferedSlot;
}): Promise<ExactSlotValidationResult> {
  const { adapter, owner, start, service, durationMinutes, excludeEventId, offeredSlot } = params;
  const businessId = String(getBusinessIdFromConfig(params.businessConfig) || "");
  const platform = normalizePlatformName(owner.platform);
  const userId = normalizePlatformUserId(platform, owner.userId);
  if (!businessId || businessId !== owner.businessId || !platform || !userId) {
    return { free: false, category: "ownership_mismatch", normalizedIso: null, endIso: null };
  }

  if (offeredSlot) {
    if (!bookingSlotOwnerMatches(offeredSlot, owner)) {
      return { free: false, category: "ownership_mismatch", normalizedIso: null, endIso: null };
    }
    const expectedEndMs =
      new Date(ensureStockholmOffset(start)).getTime() + Number(durationMinutes) * 60000;
    const offeredLocalDate = stockholmDateString(
      new Date(ensureStockholmOffset(start))
    );
    if (
      Date.now() - Number(offeredSlot.generatedAt || 0) > PENDING_BOOKING_TTL_MS ||
      Number(offeredSlot.durationMinutes) !== Number(durationMinutes) ||
      String(offeredSlot.service || "") !== String(service || "") ||
      new Date(offeredSlot.start).getTime() !== new Date(ensureStockholmOffset(start)).getTime() ||
      new Date(offeredSlot.end).getTime() !== expectedEndMs ||
      (
        offeredSlot.searchStartDate &&
        offeredLocalDate < offeredSlot.searchStartDate
      ) ||
      (
        offeredSlot.searchEndDate &&
        offeredLocalDate > offeredSlot.searchEndDate
      )
    ) {
      return { free: false, category: "stale_offer", normalizedIso: null, endIso: null };
    }
  }

  const normalizedIso = ensureStockholmOffset(String(start || "").trim());
  const startDate = new Date(normalizedIso);
  const duration = Number(durationMinutes || 0);
  if (Number.isNaN(startDate.getTime()) || !Number.isFinite(duration) || duration <= 0) {
    return { free: false, category: "invalid_slot", normalizedIso: null, endIso: null };
  }

  const localDate = stockholmDateString(startDate);
  const localTime = startDate.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit"
  });
  const startMinutes = timeTextToMinutes(localTime);
  const endMinutes = Number(startMinutes) + duration;
  if (
    startMinutes === null ||
    startMinutes < BOOKING_OPEN_MINUTES ||
    endMinutes > BOOKING_CLOSE_MINUTES
  ) {
    return { free: false, category: "outside_working_hours", normalizedIso, endIso: null };
  }
  if (startMinutes % BOOKING_INTERVAL_MINUTES !== 0) {
    return { free: false, category: "invalid_interval", normalizedIso, endIso: null };
  }

  const startMs = startDate.getTime();
  const endMs = startMs + duration * 60000;
  const calendarEvents = await adapter.getEvents(localDate, localDate);
  const filteredEvents = (Array.isArray(calendarEvents) ? calendarEvents : []).filter(
    (event: any) => !excludeEventId || String(event?.id || "") !== String(excludeEventId)
  );
  if (!isSlotFree(startMs, duration, filteredEvents)) {
    return { free: false, category: "calendar_conflict", normalizedIso, endIso: new Date(endMs).toISOString() };
  }

  const pendingEvents = getPendingBookingBlockingEvents(owner, startMs, endMs);
  if (!isSlotFree(startMs, duration, pendingEvents)) {
    return { free: false, category: "pending_conflict", normalizedIso, endIso: new Date(endMs).toISOString() };
  }

  return {
    free: true,
    category: "available",
    normalizedIso,
    endIso: new Date(endMs).toISOString()
  };
}

async function createCanonicalOfferedSlots(params: {
  adapter: CalendarAdapter;
  owner: BookingSlotOwner;
  businessConfig: any;
  startDate: string;
  endDate: string;
  service: string;
  durationMinutes: number;
  requestedTime?: string;
  options?: SlotSearchOptions;
  excludeEventId?: string;
}): Promise<{ displaySlots: string[]; ownedSlots: OwnedOfferedSlot[] }> {
  const events = await params.adapter.getEvents(params.startDate, params.endDate);
  const pendingEvents = getPendingBookingBlockingEvents(
    params.owner,
    new Date(localStockholmDateBoundary(params.startDate, false)).getTime(),
    new Date(localStockholmDateBoundary(params.endDate, true)).getTime()
  );
  const filteredEvents = (Array.isArray(events) ? events : []).filter(
    (event: any) => !params.excludeEventId || String(event?.id || "") !== String(params.excludeEventId)
  );
  const generated = getSlotsArray({
    available_slots_string: getDailySlots(
      params.startDate,
      params.endDate,
      [...filteredEvents, ...pendingEvents],
      params.durationMinutes,
      params.requestedTime,
      params.options || {}
    )
  });
  const displaySlots: string[] = [];
  const ownedSlots: OwnedOfferedSlot[] = [];
  const generatedAt = Date.now();

  for (const label of generated) {
    const start = parseSlotIso(label);
    if (!start) continue;
    const validation = await validateCanonicalExactSlot({
      adapter: params.adapter,
      owner: params.owner,
      businessConfig: params.businessConfig,
      start,
      service: params.service,
      durationMinutes: params.durationMinutes,
      excludeEventId: params.excludeEventId
    });
    if (!validation.free || !validation.normalizedIso || !validation.endIso) continue;
    displaySlots.push(label);
    ownedSlots.push({
      start: validation.normalizedIso,
      end: validation.endIso,
      durationMinutes: params.durationMinutes,
      service: params.service,
      businessId: params.owner.businessId,
      platform: normalizePlatformName(params.owner.platform),
      userId: normalizePlatformUserId(params.owner.platform, params.owner.userId),
      generatedAt,
      searchStartDate: params.startDate,
      searchEndDate: params.endDate
    });
  }

  console.log("[BookingFlow]", {
    platform: normalizePlatformName(params.owner.platform),
    businessScopePresent: Boolean(params.owner.businessId),
    operation: "availability",
    offeredSlotCount: ownedSlots.length,
    serviceDuration: params.durationMinutes,
    validatorResultCategory: ownedSlots.length > 0 ? "available" : "no_validated_slots"
  });
  return { displaySlots, ownedSlots };
}

function timeTextToMinutes(value?: string): number | null {
  const normalized = normalizeRequestedTime(value || "");
  if (!normalized) return null;
  const [hours, minutes] = normalized.split(":").map(Number);
  return hours * 60 + minutes;
}

function getDailySlots(
  startDateStr: string,
  endDateStr: string,
  events: any[],
  durationMinutes: number = 60,
  requestedTime?: string,
  options: SlotSearchOptions = {}
) {
  const normalizedRequestedTime = normalizeRequestedTime(requestedTime || "");
  const endString = endDateStr || startDateStr;

  // ClinicPilot availability window.
  // Keep this dynamic later from the business dashboard/businesses table.
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
      for (let totalMin = BOOKING_OPEN_MINUTES; totalMin <= BOOKING_CLOSE_MINUTES - BOOKING_INTERVAL_MINUTES; totalMin += BOOKING_INTERVAL_MINUTES) {
        const endTotal = totalMin + durationMinutes;
        if (endTotal > BOOKING_CLOSE_MINUTES) continue;

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

  const minimumMinutes = timeTextToMinutes(options.minTime);
  const maximumMinutes = timeTextToMinutes(options.maxTime);
  const afterMinutes = timeTextToMinutes(options.afterTime);
  const boundaryMinutes = timeTextToMinutes(options.timeBoundary?.time);
  const excludedMinutes = new Set(
    (options.excludedTimes || [])
      .map((value) => timeTextToMinutes(value))
      .filter((value): value is number => value !== null)
  );
  const allCandidates = getAllFreeCandidates().filter((candidate) => {
    if (minimumMinutes !== null && candidate.totalMin < minimumMinutes) return false;
    if (maximumMinutes !== null && candidate.totalMin > maximumMinutes) return false;
    if (afterMinutes !== null && candidate.totalMin <= afterMinutes) return false;
    if (boundaryMinutes !== null) {
      if (
        options.timeBoundary?.kind === "exclusive_lower" &&
        candidate.totalMin <= boundaryMinutes
      ) return false;
      if (
        options.timeBoundary?.kind === "inclusive_lower" &&
        candidate.totalMin < boundaryMinutes
      ) return false;
      if (
        options.timeBoundary?.kind === "exclusive_upper" &&
        candidate.totalMin >= boundaryMinutes
      ) return false;
      if (
        options.timeBoundary?.kind === "inclusive_upper" &&
        candidate.totalMin > boundaryMinutes
      ) return false;
    }
    if (excludedMinutes.has(candidate.totalMin)) return false;
    return true;
  });

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
  getEventById(eventId: string) {
    return this.events.find((item: any) => String(item.id) === String(eventId)) || null;
  }
  verifyEventDeleted(eventId: string) {
    return !this.events.some((item: any) => String(item.id) === String(eventId));
  }
  insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes: number = 60, chatId?: string, _skipConflictCheck: boolean = false) {
    const conflicting = this.events.filter(e => e.startTime === dateTime);
    if(conflicting.length > 0) return { success: false, message: "Slot already booked." };
    const evEnd = new Date(new Date(dateTime).getTime() + durationMinutes * 60000).toISOString();
    const event = { id: String(this.events.length + 1), summary: `Bokad: ${name} - ${phone}`, description: `Tjänst: ${service}\nTelegramChatId: ${chatId || ''}`, startTime: dateTime, endTime: evEnd };
    this.events.push(event);
    return { success: true, message: `Successfully booked for ${name} at ${dateTime}.`, event };
  }

  updateAppointment(eventId: string, dateTime: string, durationMinutes: number = 60) {
    const event = this.events.find((item: any) => String(item.id) === String(eventId));
    if (!event) return { success: false, code: "EVENT_NOT_FOUND", message: "Appointment not found." };
    const start = new Date(ensureStockholmOffset(dateTime));
    if (Number.isNaN(start.getTime())) return { success: false, code: "INVALID_DATETIME", message: "Invalid date and time." };
    event.startTime = start.toISOString();
    event.endTime = new Date(start.getTime() + durationMinutes * 60000).toISOString();
    return { success: true, event };
  }

  cancelAppointment(eventId: string) {
    const index = this.events.findIndex((item: any) => String(item.id) === String(eventId));
    if (index < 0) return { success: false, code: "EVENT_NOT_FOUND", message: "Appointment not found." };
    const [event] = this.events.splice(index, 1);
    return { success: true, event };
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

  async getEventById(eventId: string) {
    try {
      if (!eventId) return null;
      const headers: any = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/events/${encodeURIComponent(eventId)}`, { headers });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return data?.event || data || null;
    } catch (e) {
      return null;
    }
  }

  async verifyEventDeleted(eventId: string) {
    if (!eventId) return false;
    const headers: any = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetch(
      `${this.apiUrl}/events/${encodeURIComponent(eventId)}`,
      { headers }
    );
    if (res.status === 404 || res.status === 410) return true;
    if (res.ok) return false;
    throw new Error(`Calendar deletion verification failed with status ${res.status}`);
  }

  async insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes?: number, chatId?: string, _skipConflictCheck: boolean = false) {
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

  async updateAppointment(eventId: string, dateTime: string, durationMinutes: number = 60) {
    try {
      const headers: any = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/events/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ dateTime, durationMinutes })
      });
      return await res.json();
    } catch (e) {
      return { success: false, code: "UPDATE_FAILED", message: "Failed to update appointment." };
    }
  }

  async cancelAppointment(eventId: string) {
    try {
      const headers: any = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.apiUrl}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers });
      if (!res.ok) return { success: false, code: "CANCEL_FAILED", message: "Failed to cancel appointment." };
      const data = await res.json().catch(() => ({}));
      return { success: true, ...data };
    } catch (e) {
      return { success: false, code: "CANCEL_FAILED", message: "Failed to cancel appointment." };
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

  async getEventById(eventId: string) {
    try {
      if (!eventId) return null;
      const res = await this.calendar.events.get({
        calendarId: this.calendarId,
        eventId
      });
      return res.data || null;
    } catch (e: any) {
      console.error("Google Calendar getEventById Error:", e.message);
      return null;
    }
  }

  async verifyEventDeleted(eventId: string) {
    try {
      if (!eventId) return false;
      await this.calendar.events.get({
        calendarId: this.calendarId,
        eventId
      });
      return false;
    } catch (e: any) {
      const status = Number(e?.code || e?.response?.status);
      if (status === 404 || status === 410) {
        return true;
      }
      console.error("Google Calendar verifyEventDeleted Error:", e.message);
      throw e;
    }
  }

  async insertAppointment(name: string, phone: string, service: string, dateTime: string, durationMinutes: number = 60, chatId?: string, skipConflictCheck: boolean = false) {
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
      const ownerPlatform = String(chatId || "").startsWith("ms_")
        ? "messenger"
        : String(chatId || "").startsWith("ig_")
          ? "instagram"
          : String(chatId || "").startsWith("wa_")
            ? "whatsapp"
            : String(chatId || "").startsWith("tg_")
              ? "telegram"
              : "";
      const ownerUserId = ownerPlatform
        ? normalizePlatformUserId(ownerPlatform, String(chatId || ""))
        : "";

      // Tool-driven calls keep their own final conflict check. The deterministic booking
      // engine can skip this duplicate read after verifyExactSlotIsFree() has just passed.
      if (!skipConflictCheck) {
        const bookingDate = stockholmDateString(startTime);
        const existingEvents = await this.getEvents(bookingDate, bookingDate);
        if (!isSlotFree(startTime.getTime(), safeDuration, Array.isArray(existingEvents) ? existingEvents : [])) {
          return { success: false, code: "SLOT_CONFLICT", message: "The selected slot is no longer available." };
        }
      }

      const res = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: `Bokad: ${name} - ${phone}`,
          description: `Tjänst: ${service}\nTelegramChatId: ${chatId || ''}`,
          start: { dateTime: startTime.toISOString(), timeZone: "Europe/Stockholm" },
          end: { dateTime: endTime.toISOString(), timeZone: "Europe/Stockholm" },
          ...(ownerPlatform && ownerUserId
            ? {
                extendedProperties: {
                  private: {
                    platform: ownerPlatform,
                    userId: ownerUserId
                  }
                }
              }
            : {})
        },
      });
      return { success: true, message: `Successfully booked for ${name} at ${dateTime}.`, event: res.data };
    } catch(e: any) {
      console.error("Google Calendar insertAppointment Error:", e.message);
      return { success: false, message: 'Failed to access Google Calendar API to book slot.' };
    }
  }

  async updateAppointment(eventId: string, dateTime: string, durationMinutes: number = 60) {
    try {
      const safeDateTime = ensureStockholmOffset(String(dateTime || "").trim());
      const startTime = new Date(safeDateTime);
      const safeDuration = Number(durationMinutes || 30);
      if (!eventId || Number.isNaN(startTime.getTime()) || !Number.isFinite(safeDuration) || safeDuration <= 0) {
        return { success: false, code: "INVALID_RESCHEDULE_DATA", message: "Invalid reschedule data." };
      }

      const endTime = new Date(startTime.getTime() + safeDuration * 60 * 1000);
      const res = await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId,
        requestBody: {
          start: { dateTime: startTime.toISOString(), timeZone: "Europe/Stockholm" },
          end: { dateTime: endTime.toISOString(), timeZone: "Europe/Stockholm" }
        }
      });

      return { success: true, event: res.data };
    } catch (e: any) {
      console.error("Google Calendar updateAppointment Error:", e.message);
      return { success: false, code: "UPDATE_FAILED", message: "Failed to update appointment." };
    }
  }

  async cancelAppointment(eventId: string) {
    try {
      if (!eventId) return { success: false, code: "MISSING_EVENT_ID", message: "Calendar event id is missing." };
      await this.calendar.events.delete({ calendarId: this.calendarId, eventId });
      return { success: true };
    } catch (e: any) {
      const status = Number(e?.code || e?.response?.status);
      if (status === 404 || status === 410) {
        return { success: true, alreadyDeleted: true };
      }
      console.error("Google Calendar cancelAppointment Error:", e.message);
      return { success: false, code: "CANCEL_FAILED", message: "Failed to cancel appointment." };
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
  const digits = normalizeLocalizedDigits(String(value || "")).replace(/\D/g, "");
  if (/^0046\d{7,10}$/.test(digits)) return digits.slice(2);
  if (/^0\d{8,9}$/.test(digits)) return `46${digits.slice(1)}`;
  return digits;
}

function appointmentIdentityKeyConflictsCanonical(
  identityKey: string | undefined,
  suppliedPhone?: string
): boolean {
  if (!String(identityKey || "").startsWith("phone:")) {
    return appointmentIdentityKeyConflicts(identityKey, suppliedPhone);
  }
  const storedPhone = normalizeLookupDigits(String(identityKey).slice("phone:".length));
  const currentPhone = normalizeLookupDigits(suppliedPhone);
  return Boolean(storedPhone && currentPhone.length >= 7 && storedPhone !== currentPhone);
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

function stockholmLocalDayStartMs(dateStr: string): number {
  const previousDate = addDaysToStockholmDate(dateStr, -1);
  const previousOffset = getStockholmUtcOffset(previousDate);
  const dateOffset = getStockholmUtcOffset(dateStr);
  // DST changes occur after local midnight, so a transition date starts with the
  // previous day's offset and ends with the new offset.
  const midnightOffset = previousOffset !== dateOffset ? previousOffset : dateOffset;
  return new Date(`${dateStr}T00:00:00${midnightOffset}`).getTime();
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

  const digitCandidates = [
    normalizeLookupDigits(rawCustomerId),
    normalizeLookupDigits(rawPhone)
  ].filter((value) => value.length >= 7);

  if (digitCandidates.some((digits) => haystackDigits.includes(digits))) return true;

  // Channel IDs are written into event descriptions as TelegramChatId for legacy reasons,
  // even when the source is WhatsApp, Messenger, Instagram or web.
  if (rawCustomerId && haystack.includes(normalizeLookupText(rawCustomerId))) return true;

  return false;
}

function getCalendarConversationOwner(event: any): string {
  const privateProperties = event?.extendedProperties?.private || {};
  const privatePlatform = normalizePlatformName(String(privateProperties.platform || ""));
  const privateUserId = String(privateProperties.userId || privateProperties.user_id || "").trim();
  if (privatePlatform && privateUserId) return `${privatePlatform}:${privateUserId}`;

  const description = String(event?.description || "");
  return String(description.match(/TelegramChatId\s*:\s*([^\s\n]+)/i)?.[1] || "").trim();
}

function calendarEventHasExactMessengerOwner(event: any, messengerUserId: string): boolean {
  const expectedUserId = normalizePlatformUserId("messenger", messengerUserId);
  const owner = getCalendarConversationOwner(event);
  if (!expectedUserId || !owner) return false;

  const privatePlatform = normalizePlatformName(String(event?.extendedProperties?.private?.platform || ""));
  const privateUserId = normalizePlatformUserId(
    privatePlatform,
    String(event?.extendedProperties?.private?.userId || event?.extendedProperties?.private?.user_id || "")
  );
  if (privatePlatform === "messenger" && privateUserId === expectedUserId) return true;

  // A bare numeric Calendar owner is ambiguous across Meta channels. Only an explicitly
  // Messenger-prefixed legacy owner can prove Messenger ownership without a phone mapping.
  if (!/^(?:ms_|messenger[_:-])/i.test(owner)) return false;
  return normalizePlatformUserId("messenger", owner) === expectedUserId;
}

function calendarEventHasExactChannelOwner(event: any, platform: string, userId: string): boolean {
  const normalizedPlatform = normalizePlatformName(platform);
  const expectedUserId = normalizePlatformUserId(normalizedPlatform, userId);
  if (!normalizedPlatform || !expectedUserId) return false;
  if (normalizedPlatform === "messenger") {
    return calendarEventHasExactMessengerOwner(event, expectedUserId);
  }

  const privateProperties = event?.extendedProperties?.private || {};
  const privatePlatform = normalizePlatformName(String(privateProperties.platform || ""));
  const privateUserId = normalizePlatformUserId(
    privatePlatform,
    String(privateProperties.userId || privateProperties.user_id || "")
  );
  if (privatePlatform === normalizedPlatform && privateUserId === expectedUserId) return true;

  const owner = getCalendarConversationOwner(event);
  const prefixPattern: Record<string, RegExp> = {
    instagram: /^(?:ig_|instagram[_:-])/i,
    whatsapp: /^(?:wa_|whatsapp[_:-])/i,
    telegram: /^(?:tg_|telegram[_:-])/i,
  };
  if (prefixPattern[normalizedPlatform]?.test(owner)) {
    return normalizePlatformUserId(normalizedPlatform, owner) === expectedUserId;
  }

  // A WhatsApp sender number is a channel-verified phone identity. Exact phone tokens
  // are therefore safe for legacy WhatsApp events that predate explicit owner markers.
  if (normalizedPlatform === "whatsapp") {
    return calendarEventHasExactPhone(event, expectedUserId);
  }
  return false;
}

function calendarEventBusinessMarkerMatches(event: any, businessScope: string): boolean {
  const markedBusiness = String(
    event?.extendedProperties?.private?.businessId ||
    event?.extendedProperties?.private?.business_id ||
    ""
  ).trim();
  return !markedBusiness || markedBusiness === String(businessScope || "").trim();
}

function calendarEventHasExactPhone(event: any, phone: string): boolean {
  const expectedPhone = normalizeLookupDigits(phone);
  if (expectedPhone.length < 7) return false;
  const text = `${event?.summary || event?.title || ""} ${event?.description || ""} ${event?.location || ""}`;
  const phoneTokens = (text.match(/\+?\d[\d\s()\-]{4,}\d/g) || []).map(normalizeLookupDigits);
  return phoneTokens.includes(expectedPhone);
}

function logAppointmentLookupDiagnostic(details: {
  path: string;
  businessScopePresent: boolean;
  platform: string;
  exactIdentityMatchCount: number;
  verifiedPhoneFallbackUsed: boolean;
  returnedResultCount: number;
}) {
  const safePath = String(details.path || "appointment_lookup").replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
  console.log(
    `[AppointmentLookup] path=${safePath} ` +
    `businessScopePresent=${details.businessScopePresent} ` +
    `platform=${normalizePlatformName(details.platform)} ` +
    `exactIdentityMatchCount=${Math.max(0, Number(details.exactIdentityMatchCount) || 0)} ` +
    `verifiedPhoneFallbackUsed=${Boolean(details.verifiedPhoneFallbackUsed)} ` +
    `returnedResultCount=${Math.max(0, Number(details.returnedResultCount) || 0)}`
  );
}

function isValidLookupDate(value: unknown): value is string {
  const raw = String(value || "").trim();
  const match = raw.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function extractExplicitAppointmentLookupDates(text?: string): string[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const matches: string[] = [];

  for (const match of raw.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)) {
    if (isValidLookupDate(match[0])) matches.push(match[0]);
  }

  const namedDatePattern = /\b(?:den\s+)?\d{1,2}\s+(?:januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)(?:\s+20\d{2})?\b/gi;
  for (const match of raw.matchAll(namedDatePattern)) {
    const resolved = resolveExplicitBookingDate(match[0]);
    if (resolved && isValidLookupDate(resolved)) matches.push(resolved);
  }

  for (const match of raw.matchAll(/(?<!20\d{2}-)\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]20\d{2})?\b/g)) {
    const resolved = resolveExplicitBookingDate(match[0]);
    if (resolved && isValidLookupDate(resolved)) matches.push(resolved);
  }

  return Array.from(new Set(matches)).sort();
}

function isOlderAppointmentHistoryConfirmation(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return /^(?:ja|ja tack|gärna|yes|yes please|sure|بله|آره|حتماً|حتما)[!.؟?\s]*$/iu.test(raw) ||
    /\b(längre tillbaka|äldre period|äldre bokning|older|further back|search earlier|قبل‌تر|قدیمی‌تر)\b/iu.test(raw);
}

function resolveAppointmentLookupRange(args: any): {
  lookupMode: AppointmentLookupMode;
  startDate: string;
  endDate: string;
  historyWindowLimited: boolean;
  olderHistorySearched: boolean;
} {
  const today = stockholmDateString(new Date());
  const lookupText = String(args?.lookupText || "");
  const explicitDates = extractExplicitAppointmentLookupDates(lookupText);
  const requestedStartDate = isValidLookupDate(args?.startDate) ? String(args.startDate) : "";
  const requestedEndDate = isValidLookupDate(args?.endDate) ? String(args.endDate) : "";

  let startDate = "";
  let endDate = "";
  let historyWindowLimited = false;
  let olderHistorySearched = false;

  if (explicitDates.length > 0) {
    startDate = explicitDates[0];
    endDate = explicitDates[explicitDates.length - 1];
  } else if (
    /\b(igår|igar|yesterday|gestern|ayer|dirooz|diruz)\b/i.test(lookupText) ||
    /(?:دیروز|أمس|امس)/u.test(lookupText)
  ) {
    startDate = addDaysToStockholmDate(today, -1);
    endDate = startDate;
  } else if (
    /\b(idag|today|heute|hoy|emruz|emrooz)\b/i.test(lookupText) ||
    /(?:امروز|اليوم)/u.test(lookupText)
  ) {
    startDate = today;
    endDate = today;
  } else if (/\b(förra\s+veckan|last\s+week)\b/i.test(lookupText)) {
    const [year, month, day] = today.split("-").map(Number);
    const todayUtc = new Date(Date.UTC(year, month - 1, day));
    const daysSinceMonday = (todayUtc.getUTCDay() + 6) % 7;
    endDate = addDaysToStockholmDate(today, -(daysSinceMonday + 1));
    startDate = addDaysToStockholmDate(endDate, -6);
  } else if (args?.olderHistory === true) {
    startDate = addDaysToStockholmDate(today, -365);
    endDate = addDaysToStockholmDate(today, -8);
    olderHistorySearched = true;
  } else {
    const requestedLookupMode = String(args?.lookupMode || "");
    const historyRequested = requestedLookupMode === "history" ||
      Boolean(args?.includePast) ||
      isPastAppointmentLookupIntent(lookupText) ||
      /\b(har\s+jag\s+haft|did\s+i\s+have|before|previous(?:ly)?)\b/i.test(lookupText);
    const todayRequested = requestedLookupMode === "today";

    if (requestedStartDate) {
      startDate = requestedStartDate;
      endDate = requestedEndDate || requestedStartDate;
    } else if (todayRequested) {
      startDate = today;
      endDate = today;
    } else if (historyRequested) {
      startDate = addDaysToStockholmDate(today, -7);
      endDate = addDaysToStockholmDate(today, -1);
      historyWindowLimited = true;
    } else {
      startDate = today;
      endDate = addDaysToStockholmDate(today, 180);
    }
  }

  if (endDate < startDate) [startDate, endDate] = [endDate, startDate];

  const lookupMode: AppointmentLookupMode = startDate === today && endDate === today
    ? "today"
    : endDate < today
      ? "history"
      : startDate >= today
        ? "upcoming"
        : "today";

  return { lookupMode, startDate, endDate, historyWindowLimited, olderHistorySearched };
}

async function resolveVerifiedLookupPhone(
  platform: string,
  customerId: string,
  suppliedPhone: string,
  businessId: string | null
): Promise<string> {
  const normalizedPlatform = normalizePlatformName(platform);
  const normalizedCustomerId = normalizePlatformUserId(normalizedPlatform, customerId);
  const suppliedDigits = normalizeLookupDigits(suppliedPhone);

  // A WhatsApp sender number is verified by Meta and is the only phone identity that
  // may be inferred directly from a channel id. Never let a typed number override it.
  if (normalizedPlatform === "whatsapp") {
    const channelDigits = normalizeLookupDigits(normalizedCustomerId);
    return channelDigits.length >= 7 ? channelDigits : "";
  }

  if (!supabase || !businessId || suppliedDigits.length < 7 || !normalizedCustomerId) return "";

  const prefixes: Record<string, string[]> = {
    messenger: ["ms_", "messenger_", "messenger:", "messenger-"],
    instagram: ["ig_", "instagram_", "instagram:"],
    telegram: ["tg_", "telegram_", "telegram:"],
  };
  const userIdCandidates = Array.from(new Set([
    normalizedCustomerId,
    ...(prefixes[normalizedPlatform] || []).map((prefix) => `${prefix}${normalizedCustomerId}`),
  ]));
  const platformCandidates = normalizedPlatform === "messenger"
    ? ["messenger", "messenger-webhook", "messenger_webhook", "facebook", "facebook_messenger"]
    : [normalizedPlatform];

  try {
    const { data, error } = await supabase
      .from("appointments_leads")
      .select("user_id,platform,phone_number,business_id,ai_summary")
      .eq("business_id", String(businessId))
      .in("platform", platformCandidates)
      .in("user_id", userIdCandidates)
      .limit(10);

    if (error) {
      console.error("[AppointmentLookup] Verified phone mapping lookup failed:", error);
      return "";
    }

    for (const row of data || []) {
      if (normalizePlatformName(String(row?.platform || "")) !== normalizedPlatform) continue;
      if (normalizePlatformUserId(normalizedPlatform, String(row?.user_id || "")) !== normalizedCustomerId) continue;
      let mappedPhone = normalizeLookupDigits(row?.phone_number);
      if (!mappedPhone && row?.ai_summary) {
        try {
          const summary = typeof row.ai_summary === "string" ? JSON.parse(row.ai_summary) : row.ai_summary;
          mappedPhone = normalizeLookupDigits(summary?.customerPhone || summary?.phone);
        } catch {
          mappedPhone = "";
        }
      }
      if (mappedPhone === suppliedDigits) return suppliedDigits;
    }
  } catch (error) {
    console.error("[AppointmentLookup] Verified phone mapping lookup crashed:", error);
  }

  return "";
}

function normalizeRecoveryName(value?: string): string {
  return normalizeLookupText(value)
    .replace(/\+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowMatchesSecureRecoveryAttributes(
  row: any,
  suppliedPhone: string,
  suppliedName?: string,
  requestedDate?: string,
  approximateTime?: string,
  toleranceMinutes: number = 30,
  requestedService?: string
): boolean {
  const phoneDigits = normalizeLookupDigits(suppliedPhone);
  if (
    phoneDigits.length < 7 ||
    normalizeLookupDigits(row?.phone_number) !== phoneDigits
  ) return false;

  const normalizedName = normalizeRecoveryName(suppliedName);
  const rowName = normalizeRecoveryName(row?.customer_name);
  const nameMatches = Boolean(
    normalizedName.length >= 2 &&
    rowName.length >= 2 &&
    normalizedName === rowName
  );

  const requestedMinutes = timeTextToMinutes(approximateTime);
  const rowStart = new Date(String(row?.start_time || ""));
  const rowDate = Number.isNaN(rowStart.getTime()) ? "" : stockholmDateString(rowStart);
  const rowTime = Number.isNaN(rowStart.getTime())
    ? null
    : timeTextToMinutes(
        rowStart.toLocaleTimeString("sv-SE", {
          timeZone: "Europe/Stockholm",
          hour: "2-digit",
          minute: "2-digit"
        })
      );
  const dateTimeMatches = Boolean(
    requestedDate &&
    requestedMinutes !== null &&
    rowDate === requestedDate &&
    rowTime !== null &&
    Math.abs(rowTime - requestedMinutes) <= toleranceMinutes
  );

  const normalizedRequestedService = normalizeLookupText(requestedService);
  const normalizedRowService = normalizeLookupText(row?.service);
  if (
    normalizedRequestedService &&
    normalizedRequestedService !== "bokning" &&
    normalizedRowService &&
    normalizedRequestedService !== normalizedRowService
  ) return false;

  return nameMatches || dateTimeMatches;
}

function calendarEventMatchesSecureRecoveryAttributes(
  event: any,
  suppliedPhone: string,
  suppliedName?: string,
  requestedDate?: string,
  approximateTime?: string,
  requestedService?: string,
  toleranceMinutes: number = 30
): boolean {
  const phoneDigits = normalizeLookupDigits(suppliedPhone);
  if (phoneDigits.length < 7 || !calendarEventHasExactPhone(event, phoneDigits)) {
    return false;
  }

  const summary = String(event?.summary || event?.title || "");
  const description = String(event?.description || "");
  const summaryName = summary.match(/^Bokad:\s*(.*?)\s*-\s*(?:\+?[\d\s()/-]+)$/i)?.[1] || "";
  const descriptionName = description.match(
    /(?:CustomerName|Customer Name|Namn|Name)\s*:\s*([^\n]+)/i
  )?.[1] || "";
  const normalizedName = normalizeRecoveryName(suppliedName);
  const eventName = normalizeRecoveryName(summaryName || descriptionName);
  const nameMatches = Boolean(
    normalizedName.length >= 2 &&
    eventName.length >= 2 &&
    normalizedName === eventName
  );

  const eventStart = new Date(getEventStartIso(event));
  const eventDate = Number.isNaN(eventStart.getTime())
    ? ""
    : stockholmDateString(eventStart);
  const eventMinutes = Number.isNaN(eventStart.getTime())
    ? null
    : timeTextToMinutes(
        eventStart.toLocaleTimeString("sv-SE", {
          timeZone: "Europe/Stockholm",
          hour: "2-digit",
          minute: "2-digit"
        })
      );
  const requestedMinutes = timeTextToMinutes(approximateTime);
  const dateTimeMatches = Boolean(
    requestedDate &&
    requestedMinutes !== null &&
    eventDate === requestedDate &&
    eventMinutes !== null &&
    Math.abs(eventMinutes - requestedMinutes) <= toleranceMinutes
  );

  const normalizedService = normalizeLookupText(requestedService);
  if (
    normalizedService &&
    normalizedService !== "bokning" &&
    !normalizeLookupText(`${summary} ${description}`).includes(normalizedService)
  ) return false;

  return nameMatches || dateTimeMatches;
}

async function findCustomerAppointments(
  adapter: CalendarAdapter,
  args: any,
  customerId: string,
  platform: string,
  businessConfig?: any
) {
  const lookupRange = resolveAppointmentLookupRange(args);
  const { lookupMode, startDate, endDate, historyWindowLimited, olderHistorySearched } = lookupRange;
  const phone = String(args?.phone || "");
  const name = String(args?.name || "");
  const normalizedPlatform = normalizePlatformName(platform);
  const normalizedCustomerId = normalizePlatformUserId(normalizedPlatform, customerId);
  const now = Date.now();
  const rangeStartMs = stockholmLocalDayStartMs(startDate);
  const rangeEndMs = stockholmLocalDayStartMs(addDaysToStockholmDate(endDate, 1)) - 1;
  const businessId = getBusinessIdFromConfig(businessConfig);
  const lookupPath = String(args?.lookupPath || "appointment_lookup");
  let exactIdentityMatchCount = 0;
  let verifiedPhoneFallbackUsed = false;
  let secureRecoveryAttempted = false;

  if (
    normalizedPlatform === "messenger" &&
    (!businessId || !normalizedCustomerId || businessConfig?.messengerBusinessScopeVerified === false)
  ) {
    logAppointmentLookupDiagnostic({
      path: lookupPath,
      businessScopePresent: Boolean(businessId) && businessConfig?.messengerBusinessScopeVerified !== false,
      platform: normalizedPlatform,
      exactIdentityMatchCount: 0,
      verifiedPhoneFallbackUsed: false,
      returnedResultCount: 0
    });
    return {
      success: true,
      found: false,
      needsContactDetails: true,
      searchedFrom: startDate,
      searchedTo: endDate,
      lookupMode,
      historyWindowLimited,
      olderHistorySearched,
      verifiedPhoneAccepted: false,
      identityKey: "",
      appointments: []
    };
  }

  const verifiedPhone = await resolveVerifiedLookupPhone(
    normalizedPlatform,
    normalizedCustomerId,
    phone,
    businessId
  );

  // First use OdinLink's own appointment records. This is the most reliable identity match
  // for Instagram/Messenger because Google Calendar events may not contain the channel id
  // for older bookings. Fall back to Google Calendar below.
  if (supabase && businessId) {
    try {
      let query = supabase
        .from("appointments")
        .select("id,customer_name,phone_number,platform,user_id,service,start_time,end_time,status,business_id")
        .eq("business_id", String(businessId))
        .gte("start_time", new Date(rangeStartMs).toISOString())
        .lte("start_time", new Date(rangeEndMs).toISOString())
        .order("start_time", { ascending: true })
        .limit(50);

      const { data: dbRows, error: dbError } = await query;
      if (dbError) throw dbError;

      const securelyScopedRows = normalizedPlatform === "messenger"
        ? (dbRows || []).filter((row: any) => {
            if (String(row?.business_id || "").trim() !== String(businessId)) return false;
            const rowPlatform = normalizePlatformName(String(row?.platform || ""));
            const rowUserId = normalizePlatformUserId(rowPlatform, String(row?.user_id || ""));
            const exactIdentityMatch = rowPlatform === "messenger" && rowUserId === normalizedCustomerId;
            if (exactIdentityMatch) {
              exactIdentityMatchCount++;
              return true;
            }

            const verifiedPhoneMatch = normalizeLookupDigits(verifiedPhone).length >= 7 &&
              rowPlatform === "messenger" &&
              normalizeLookupDigits(row?.phone_number) === normalizeLookupDigits(verifiedPhone) &&
              (!rowUserId || rowUserId === normalizedCustomerId);
            return verifiedPhoneMatch;
          })
        : (dbRows || []);

      const normalizedPhoneRows = securelyScopedRows.map((row: any) => ({
        ...row,
        __originalPhoneNumber: row?.phone_number,
        phone_number: normalizeLookupDigits(row?.phone_number)
      }));
      let secureSelection: any = selectSecureAppointmentRows(
        normalizedPhoneRows,
        {
          businessId: String(businessId),
          platform: normalizedPlatform,
          userId: normalizedCustomerId,
          phone: verifiedPhone
        },
        lookupMode,
        now,
        rangeStartMs,
        rangeEndMs
      );
      if (
        secureSelection.rows.length === 0 &&
        args?.secureRecovery === true &&
        normalizeLookupDigits(phone).length >= 7
      ) {
        secureRecoveryAttempted = true;
        const recoveryRows = (dbRows || [])
          .filter((row: any) => {
            const rowPlatform = normalizePlatformName(String(row?.platform || ""));
            const rowUserId = normalizePlatformUserId(
              rowPlatform,
              String(row?.user_id || "")
            );
            return (
              String(row?.business_id || "") === String(businessId) &&
              rowPlatform === normalizedPlatform &&
              (!rowUserId || rowUserId === normalizedCustomerId) &&
              isActiveAppointmentStatus(row?.status) &&
              rowMatchesSecureRecoveryAttributes(
                row,
                phone,
                args?.name,
                args?.requestedDate,
                args?.approximateTime,
                30,
                args?.service
              )
            );
          })
          .map((row: any) => ({
            ...row,
            __originalPhoneNumber: row?.phone_number,
            phone_number: normalizeLookupDigits(row?.phone_number)
          }));

        if (recoveryRows.length > 1) {
          logAppointmentLookupDiagnostic({
            path: lookupPath,
            businessScopePresent: Boolean(businessId),
            platform: normalizedPlatform,
            exactIdentityMatchCount: 0,
            verifiedPhoneFallbackUsed: false,
            returnedResultCount: 0
          });
          return {
            success: true,
            found: false,
            needsContactDetails: false,
            searchedFrom: startDate,
            searchedTo: endDate,
            lookupMode,
            historyWindowLimited,
            olderHistorySearched,
            verifiedPhoneAccepted: false,
            secureRecoveryAttempted: true,
            secureRecoveryAmbiguous: true,
            identityKey: "",
            appointments: []
          };
        }

        if (recoveryRows.length === 1) {
          const recoveredRow = recoveryRows[0];
          secureSelection = {
            rows: recoveryRows,
            identityKey: `phone:${normalizeLookupDigits(phone)}`,
            matchedBy: "secure_recovery"
          };
          console.log("[AppointmentLookup]", {
            path: lookupPath,
            platform: normalizedPlatform,
            businessScopePresent: true,
            secureRecoveryMatched: true,
            recoveredRowIdPresent: Boolean(recoveredRow?.id),
            recoveryUsedName: Boolean(
              normalizeRecoveryName(args?.name) &&
              normalizeRecoveryName(args?.name) ===
                normalizeRecoveryName(recoveredRow?.customer_name)
            ),
            recoveryUsedDateTime: Boolean(args?.requestedDate && args?.approximateTime)
          });
        }
      }
      verifiedPhoneFallbackUsed = secureSelection.matchedBy === "phone";

      const dbAppointments = secureSelection.rows.slice(0, 5).map((row: any) => ({
        id: row.id || null,
        calendarEventId: null,
        summary: row.service || "Appointment",
        service: row.service || "Appointment",
        customerName: row.customer_name || null,
        phone: row.__originalPhoneNumber || row.phone_number || null,
        description: "",
        start: row.start_time,
        end: row.end_time,
        platform: row.platform || normalizedPlatform,
        userId: row.user_id || null,
        businessId: row.business_id || String(businessId),
        status: row.status || "booked",
        identityKey: secureSelection.identityKey,
        source: "appointments_table"
      }));

      if (dbAppointments.length > 0) {
        // Try to attach the actual Google Calendar event id so follow-up questions
        // and rescheduling can use the same appointment without asking again.
        try {
          const calendarEvents = await adapter.getEvents(startDate, endDate);
          for (const appointment of dbAppointments) {
            const appointmentStart = new Date(appointment.start).getTime();
            const matchedEvent = (Array.isArray(calendarEvents) ? calendarEvents : []).find((event: any) => {
              const eventStart = new Date(getEventStartIso(event)).getTime();
              if (!Number.isFinite(eventStart) || Math.abs(eventStart - appointmentStart) > 60 * 1000) return false;
              if (!calendarEventBusinessMarkerMatches(event, getAppointmentBusinessScope(businessConfig))) {
                return false;
              }
              if (normalizedPlatform === "messenger") {
                return calendarEventHasExactMessengerOwner(event, normalizedCustomerId) ||
                  calendarEventHasExactPhone(event, appointment.phone || verifiedPhone);
              }
              return calendarEventHasExactChannelOwner(event, normalizedPlatform, normalizedCustomerId) ||
                calendarEventHasExactPhone(event, appointment.phone || verifiedPhone);
            });
            if (matchedEvent?.id) appointment.calendarEventId = matchedEvent.id;
          }
        } catch (enrichError) {
          console.error("[AppointmentLookup] Calendar enrichment failed:", enrichError);
        }

        logAppointmentLookupDiagnostic({
          path: lookupPath,
          businessScopePresent: Boolean(businessId),
          platform: normalizedPlatform,
          exactIdentityMatchCount: secureSelection.matchedBy === "channel"
            ? secureSelection.rows.length
            : exactIdentityMatchCount,
          verifiedPhoneFallbackUsed,
          returnedResultCount: dbAppointments.length
        });

        return {
          success: true,
          found: true,
          needsContactDetails: false,
          searchedFrom: startDate,
          searchedTo: endDate,
          lookupMode,
          historyWindowLimited,
          olderHistorySearched,
          verifiedPhoneAccepted: normalizeLookupDigits(verifiedPhone).length >= 7,
          secureRecoveryAttempted,
          secureRecoveryMatched: secureSelection.matchedBy === "secure_recovery",
          identityKey: secureSelection.identityKey,
          matchedBy: secureSelection.matchedBy,
          identityVerified: true,
          appointments: dbAppointments,
          source: "appointments_table"
        };
      }
    } catch (dbLookupError) {
      console.error("[AppointmentLookup] Supabase lookup failed; falling back to calendar:", dbLookupError);
    }
  } else if (supabase && !businessId) {
    console.error("[AppointmentLookup] Refusing unscoped appointments-table lookup: business id is missing.");
  }

  const events = await adapter.getEvents(startDate, endDate);
  const eligibleEvents = (Array.isArray(events) ? events : []).filter((event: any) =>
    !isLikelyWorkingHoursMarker(event) &&
    calendarEventBusinessMarkerMatches(event, getAppointmentBusinessScope(businessConfig))
  );
  let secureCalendarSelection;
  let secureCalendarRecoveryMatched = false;

  if (normalizedPlatform === "messenger") {
    const exactMessengerEvents = eligibleEvents.filter((event: any) =>
      calendarEventHasExactMessengerOwner(event, normalizedCustomerId)
    );
    const exactMessengerSelection = selectSecureCalendarEvents(
      exactMessengerEvents,
      { platform: "messenger", userId: normalizedCustomerId, phone: "" },
      lookupMode,
      now,
      rangeStartMs,
      rangeEndMs,
      getEventStartIso
    );
    exactIdentityMatchCount += exactMessengerSelection.events.length;

    if (exactMessengerSelection.events.length > 0) {
      secureCalendarSelection = exactMessengerSelection;
    } else if (normalizeLookupDigits(verifiedPhone).length >= 7) {
      const verifiedPhoneEvents = eligibleEvents.filter((event: any) =>
        calendarEventHasExactPhone(event, verifiedPhone)
      );
      secureCalendarSelection = selectSecureCalendarEvents(
        verifiedPhoneEvents,
        { platform: "messenger", userId: "", phone: verifiedPhone },
        lookupMode,
        now,
        rangeStartMs,
        rangeEndMs,
        getEventStartIso
      );
      verifiedPhoneFallbackUsed = secureCalendarSelection.events.length > 0;
    } else {
      secureCalendarSelection = exactMessengerSelection;
    }
  } else {
    const exactChannelEvents = eligibleEvents.filter((event: any) =>
      calendarEventHasExactChannelOwner(event, normalizedPlatform, normalizedCustomerId)
    );
    const verifiedPhoneEvents = normalizeLookupDigits(verifiedPhone).length >= 7
      ? eligibleEvents.filter((event: any) => calendarEventHasExactPhone(event, verifiedPhone))
      : [];
    secureCalendarSelection = exactChannelEvents.length > 0
      ? {
          events: exactChannelEvents.filter((event: any) => {
            if (!isActiveAppointmentStatus(event?.status)) return false;
            const startMs = new Date(getEventStartIso(event)).getTime();
            if (!Number.isFinite(startMs) || startMs < rangeStartMs || startMs > rangeEndMs) return false;
            if (lookupMode === "upcoming") return startMs >= now;
            if (lookupMode === "history") return startMs <= now;
            return true;
          }),
          identityKey: `channel:${normalizedPlatform}:${normalizedCustomerId}`,
          matchedBy: "channel" as const
        }
      : selectSecureCalendarEvents(
          verifiedPhoneEvents,
          { platform: normalizedPlatform, userId: normalizedCustomerId, phone: verifiedPhone },
          lookupMode,
          now,
          rangeStartMs,
          rangeEndMs,
          getEventStartIso
        );

    if (
      normalizedPlatform === "telegram" &&
      secureCalendarSelection.events.length === 0 &&
      args?.secureRecovery === true &&
      normalizeLookupDigits(phone).length >= 7
    ) {
      secureRecoveryAttempted = true;
      const recoveryEvents = eligibleEvents.filter((event: any) => {
        if (!isActiveAppointmentStatus(event?.status)) return false;
        const startMs = new Date(getEventStartIso(event)).getTime();
        if (!Number.isFinite(startMs) || startMs < rangeStartMs || startMs > rangeEndMs) {
          return false;
        }
        if (lookupMode === "upcoming" && startMs < now) return false;
        if (lookupMode === "history" && startMs > now) return false;

        const privateProperties = event?.extendedProperties?.private || {};
        const markedPlatform = normalizePlatformName(
          String(privateProperties.platform || "")
        );
        const markedUserId = normalizePlatformUserId(
          markedPlatform || "telegram",
          String(privateProperties.userId || privateProperties.user_id || "")
        );
        if (markedPlatform && markedPlatform !== "telegram") return false;
        if (markedUserId && markedUserId !== normalizedCustomerId) return false;

        return calendarEventMatchesSecureRecoveryAttributes(
          event,
          phone,
          args?.name,
          args?.requestedDate,
          args?.approximateTime,
          args?.service,
          30
        );
      });

      if (recoveryEvents.length > 1) {
        logAppointmentLookupDiagnostic({
          path: lookupPath,
          businessScopePresent: Boolean(businessId),
          platform: normalizedPlatform,
          exactIdentityMatchCount: 0,
          verifiedPhoneFallbackUsed: false,
          returnedResultCount: 0
        });
        return {
          success: true,
          found: false,
          needsContactDetails: false,
          searchedFrom: startDate,
          searchedTo: endDate,
          lookupMode,
          historyWindowLimited,
          olderHistorySearched,
          verifiedPhoneAccepted: false,
          secureRecoveryAttempted: true,
          secureRecoveryAmbiguous: true,
          identityKey: "",
          appointments: []
        };
      }

      if (recoveryEvents.length === 1) {
        secureCalendarSelection = {
          events: recoveryEvents,
          identityKey: `phone:${normalizeLookupDigits(phone)}`,
          matchedBy: "secure_recovery" as const
        };
        secureCalendarRecoveryMatched = true;
      }
    }
    exactIdentityMatchCount = secureCalendarSelection.matchedBy === "channel"
      ? secureCalendarSelection.events.length
      : 0;
    verifiedPhoneFallbackUsed = secureCalendarSelection.matchedBy === "phone";
  }

  const appointments = secureCalendarSelection.events
    .sort((a: any, b: any) =>
      lookupMode === "history"
        ? new Date(getEventStartIso(b)).getTime() - new Date(getEventStartIso(a)).getTime()
        : new Date(getEventStartIso(a)).getTime() - new Date(getEventStartIso(b)).getTime()
    )
    .slice(0, 5)
    .map((event: any) => {
      const summary = String(event?.summary || event?.title || "Appointment");
      const description = String(event?.description || "");
      const nameMatch = summary.match(/^Bokad:\s*(.*?)\s*-\s*(.+)$/i);
      const serviceMatch = description.match(/Tjänst:\s*([^\n]+)/i);
      return {
        id: event?.id || null,
        calendarEventId: event?.id || null,
        summary,
        service: serviceMatch?.[1]?.trim() || "Appointment",
        customerName: nameMatch?.[1]?.trim() || null,
        phone: nameMatch?.[2]?.trim() || null,
        description,
        start: getEventStartIso(event),
        end: getEventEndIso(event),
        platform: normalizedPlatform,
        userId: normalizedCustomerId,
        businessId: businessId || null,
        status: event?.status || "booked",
        identityKey: secureCalendarSelection.identityKey,
        source: "calendar"
      };
    });

  const hasReliableIdentity =
    normalizeLookupDigits(verifiedPhone).length >= 7 ||
    normalizeLookupDigits(customerId).length >= 7 ||
    String(customerId || "").trim().length >= 5;

  logAppointmentLookupDiagnostic({
    path: lookupPath,
    businessScopePresent: Boolean(businessId),
    platform: normalizedPlatform,
    exactIdentityMatchCount,
    verifiedPhoneFallbackUsed,
    returnedResultCount: appointments.length
  });

  return {
    success: true,
    found: appointments.length > 0,
    needsContactDetails: appointments.length === 0 && (normalizedPlatform === "messenger" || !hasReliableIdentity),
    searchedFrom: startDate,
    searchedTo: endDate,
    lookupMode,
    historyWindowLimited,
    olderHistorySearched,
    verifiedPhoneAccepted: normalizeLookupDigits(verifiedPhone).length >= 7,
    secureRecoveryAttempted,
    secureRecoveryMatched: secureCalendarRecoveryMatched,
    identityKey: secureCalendarSelection.identityKey,
    matchedBy: secureCalendarSelection.matchedBy,
    identityVerified: appointments.length > 0,
    appointments
  };
}

type AppointmentTemporalState = "future_or_active" | "expired_today" | "recent_past";

function classifyAppointmentTemporalState(
  appointment: any,
  nowMs: number = Date.now()
): AppointmentTemporalState {
  const startMs = new Date(String(appointment?.start || "")).getTime();
  const explicitEndMs = new Date(String(appointment?.end || "")).getTime();
  const endMs = Number.isFinite(explicitEndMs)
    ? explicitEndMs
    : startMs + getAppointmentDurationMinutes(appointment) * 60000;
  if (Number.isFinite(endMs) && endMs > nowMs) return "future_or_active";
  const appointmentDate = Number.isFinite(startMs)
    ? stockholmDateString(new Date(startMs))
    : "";
  return appointmentDate === stockholmDateString(new Date(nowMs))
    ? "expired_today"
    : "recent_past";
}

async function findOwnedAppointmentForMutation(
  adapter: CalendarAdapter,
  args: any,
  customerId: string,
  platform: string,
  businessConfig: any
): Promise<{
  result: any;
  pastAppointment: any | null;
  temporalState: AppointmentTemporalState | null;
}> {
  if (isValidLookupDate(args?.requestedDate)) {
    const exactDate = String(args.requestedDate);
    const exact = await findCustomerAppointments(
      adapter,
      {
        ...args,
        startDate: exactDate,
        endDate: exactDate,
        lookupMode: exactDate < stockholmDateString(new Date()) ? "history" : "today",
        includePast: true,
        lookupText: exactDate,
        lookupPath: `${String(args?.lookupPath || "mutation")}_requested_date`
      },
      customerId,
      platform,
      businessConfig
    );
    if (exact?.found) {
      const appointments = Array.isArray(exact.appointments) ? exact.appointments : [];
      const futureOrActive = appointments.find(
        (appointment: any) =>
          classifyAppointmentTemporalState(appointment) === "future_or_active"
      );
      if (futureOrActive) {
        return {
          result: { ...exact, appointments: [futureOrActive] },
          pastAppointment: null,
          temporalState: "future_or_active"
        };
      }
      const past = appointments
        .filter((appointment: any) =>
          classifyAppointmentTemporalState(appointment) !== "future_or_active"
        )
        .sort(
          (a: any, b: any) =>
            new Date(b.end || b.start).getTime() -
            new Date(a.end || a.start).getTime()
        )[0];
      if (past) {
        return {
          result: { ...exact, appointments: [past] },
          pastAppointment: past,
          temporalState: classifyAppointmentTemporalState(past)
        };
      }
    }
    return { result: exact, pastAppointment: null, temporalState: null };
  }

  const upcoming = await findCustomerAppointments(
    adapter,
    {
      ...args,
      lookupMode: "upcoming",
      includePast: false,
      lookupPath: `${String(args?.lookupPath || "mutation")}_upcoming`
    },
    customerId,
    platform,
    businessConfig
  );
  if (upcoming?.found) {
    return { result: upcoming, pastAppointment: null, temporalState: "future_or_active" };
  }

  const today = await findCustomerAppointments(
    adapter,
    {
      ...args,
      lookupMode: "today",
      includePast: true,
      lookupText: "today",
      lookupPath: `${String(args?.lookupPath || "mutation")}_today`
    },
    customerId,
    platform,
    businessConfig
  );
  const activeToday = (Array.isArray(today?.appointments) ? today.appointments : [])
    .filter((appointment: any) => classifyAppointmentTemporalState(appointment) === "future_or_active")
    .sort((a: any, b: any) => new Date(a.end || a.start).getTime() - new Date(b.end || b.start).getTime());
  if (activeToday.length > 0) {
    return {
      result: { ...today, found: true, appointments: activeToday },
      pastAppointment: null,
      temporalState: "future_or_active"
    };
  }
  const expiredToday = (Array.isArray(today?.appointments) ? today.appointments : [])
    .filter((appointment: any) => classifyAppointmentTemporalState(appointment) === "expired_today")
    .sort((a: any, b: any) => new Date(b.end || b.start).getTime() - new Date(a.end || a.start).getTime())[0];
  if (expiredToday) {
    return { result: today, pastAppointment: expiredToday, temporalState: "expired_today" };
  }

  const recent = await findCustomerAppointments(
    adapter,
    {
      ...args,
      lookupMode: "history",
      includePast: true,
      lookupText: "previous appointment",
      lookupPath: `${String(args?.lookupPath || "mutation")}_recent`
    },
    customerId,
    platform,
    businessConfig
  );
  const recentPast = (Array.isArray(recent?.appointments) ? recent.appointments : [])
    .filter((appointment: any) => classifyAppointmentTemporalState(appointment) === "recent_past")
    .sort((a: any, b: any) => new Date(b.end || b.start).getTime() - new Date(a.end || a.start).getTime())[0];
  if (recentPast) {
    return { result: recent, pastAppointment: recentPast, temporalState: "recent_past" };
  }

  return { result: upcoming, pastAppointment: null, temporalState: null };
}

function formatPastAppointmentMutationReply(
  appointment: any,
  temporalState: AppointmentTemporalState,
  language: string
): string {
  const { dateText, timeText } = formatLocalizedDateTime(String(appointment?.start || ""), language);
  if (temporalState === "expired_today") {
    if (language === "sv") return `Jag hittade din bokning idag kl. ${timeText}, men tiden har redan passerat och kan inte längre ändras. Vill du att jag hjälper dig boka en ny tid?`;
    if (language === "fa") return `رزرو امروزتان ساعت ${timeText} را پیدا کردم، اما زمانش گذشته و دیگر قابل تغییر نیست. می‌خواهید برایتان وقت جدیدی رزرو کنم؟`;
    if (language === "de") return `Ich habe Ihren Termin heute um ${timeText} Uhr gefunden. Er ist bereits vorbei und kann nicht mehr verschoben werden. Soll ich einen neuen Termin buchen?`;
    if (language === "es") return `Encontré tu cita de hoy a las ${timeText}, pero ya pasó y no puede cambiarse. ¿Quieres que te ayude a reservar otra?`;
    if (language === "ar") return `وجدت موعدك اليوم الساعة ${timeText}، لكنه انتهى ولا يمكن تغييره الآن. هل تريد أن أساعدك في حجز موعد جديد؟`;
    return `I found your appointment today at ${timeText}, but that time has already passed, so it can no longer be moved. Would you like help booking a new appointment?`;
  }
  if (language === "sv") return `Jag hittade din tidigare bokning ${dateText} kl. ${timeText}. Den har redan passerat och kan inte bokas om, men jag hjälper gärna till med en ny tid. Vill du det?`;
  if (language === "fa") return `رزرو قبلی‌تان در ${dateText} ساعت ${timeText} را پیدا کردم. زمانش گذشته و قابل جابه‌جایی نیست، اما می‌توانم وقت جدیدی رزرو کنم. مایلید؟`;
  if (language === "de") return `Ich habe Ihren früheren Termin am ${dateText} um ${timeText} Uhr gefunden. Er kann nicht mehr verschoben werden. Soll ich einen neuen Termin buchen?`;
  if (language === "es") return `Encontré tu cita anterior del ${dateText} a las ${timeText}. Ya no puede cambiarse. ¿Quieres reservar una nueva?`;
  if (language === "ar") return `وجدت موعدك السابق بتاريخ ${dateText} الساعة ${timeText}. لا يمكن تغييره الآن. هل تريد حجز موعد جديد؟`;
  return `I found your previous appointment on ${dateText} at ${timeText}. It has already passed and cannot be moved. Would you like help booking a new appointment?`;
}

function formatAppointmentLookupReply(result: any, language: string = "en"): string {
  const lang = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";

  if (!result?.found && result?.verifiedPhoneAccepted) {
    return formatVerifiedPhoneNoAppointment(lang, result?.lookupMode || "upcoming");
  }

  if (!result?.found && result?.lookupMode === "history" && result?.historyWindowLimited) {
    const limitedHistory: Record<string, string> = {
      sv: "Jag hittar ingen bokning de senaste sju dagarna. Vill du att jag söker längre tillbaka? Du kan också skicka mobilnumret du bokade med 😊",
      fa: "در هفت روز گذشته رزروی پیدا نکردم. می‌خواهید عقب‌تر را هم بررسی کنم؟ می‌توانید شماره‌ای را که با آن رزرو کردید هم بفرستید 😊",
      de: "Ich habe in den letzten sieben Tagen keine Buchung gefunden. Soll ich weiter zurücksuchen? Sie können mir auch die verwendete Mobilnummer senden.",
      es: "No encontré ninguna reserva en los últimos siete días. ¿Quieres que busque más atrás? También puedes enviarme el móvil usado al reservar.",
      ar: "لم أجد حجزًا خلال الأيام السبعة الماضية. هل تريد أن أبحث في فترة أقدم؟ يمكنك أيضًا إرسال رقم الهاتف المستخدم للحجز.",
      en: "I couldn’t find a booking in the last seven days. Would you like me to search further back? You can also send the mobile number used to book 😊"
    };
    return limitedHistory[lang];
  }

  if (!result?.found && result?.lookupMode === "history" && result?.olderHistorySearched) {
    const olderHistory: Record<string, string> = {
      sv: "Jag hittar ingen äldre bokning under det senaste året. Skriv gärna vilket datum eller vilken period jag ska söka i.",
      fa: "در یک سال گذشته رزرو قدیمی‌تری پیدا نکردم. لطفاً تاریخ یا بازه‌ای را که باید بررسی کنم بفرستید.",
      de: "Ich habe im letzten Jahr keine ältere Buchung gefunden. Nennen Sie mir bitte ein Datum oder einen Zeitraum.",
      es: "No encontré una reserva anterior durante el último año. Indícame una fecha o un período concreto.",
      ar: "لم أجد حجزًا أقدم خلال السنة الماضية. أرسل تاريخًا أو فترة محددة للبحث.",
      en: "I couldn’t find an older booking in the past year. Please send the date or period you want me to search."
    };
    return olderHistory[lang];
  }

  if (result?.needsContactDetails) {
    const ask: Record<string, string> = {
      sv: "Självklart 😊 Vilket mobilnummer bokade du med?",
      fa: "حتماً 😊 با چه شماره موبایلی رزرو کردید؟",
      de: "Gerne 😊 Mit welcher Mobilnummer wurde gebucht?",
      es: "Claro 😊 ¿Con qué número de móvil reservaste?",
      ar: "بالتأكيد 😊 ما رقم الهاتف الذي استخدمته للحجز؟",
      en: "Of course 😊 What mobile number did you book with?"
    };
    return ask[lang];
  }

  if (!result?.found || !Array.isArray(result?.appointments) || result.appointments.length === 0) {
    if (result?.lookupMode === "today") {
      const noneToday: Record<string, string> = {
        sv: "Jag hittar ingen bokning idag här 😊 Vilket mobilnummer bokade du med?",
        fa: "برای امروز رزروی پیدا نکردم 😊 با چه شماره‌ای رزرو کردید؟",
        de: "Ich habe für heute keine Buchung zu Ihren Angaben gefunden. Soll ich mit einer anderen Mobilnummer suchen? 📅",
        es: "No encontré ninguna reserva para hoy asociada a tus datos. ¿Quieres que busque con otro número? 📅",
        ar: "لم أجد حجزًا لليوم مرتبطًا ببياناتك. هل تريد أن أبحث برقم هاتف آخر؟ 📅",
        en: "I can’t find a booking for today here 😊 What mobile number did you book with?"
      };
      return noneToday[lang];
    }

    if (result?.lookupMode === "history") {
      const noneHistory: Record<string, string> = {
        sv: "Jag hittar ingen tidigare bokning här 😊 Vilket mobilnummer bokade du med?",
        fa: "رزرو قبلی پیدا نکردم 😊 با چه شماره‌ای رزرو کردید؟",
        de: "Ich habe keine frühere Buchung zu Ihren Angaben gefunden. Soll ich mit einer anderen Mobilnummer suchen? 📅",
        es: "No encontré ninguna reserva anterior asociada a tus datos. ¿Quieres que busque con otro número? 📅",
        ar: "لم أجد حجزًا سابقًا مرتبطًا ببياناتك. هل تريد أن أبحث برقم هاتف آخر؟ 📅",
        en: "I can’t find a previous booking here 😊 What mobile number did you book with?"
      };
      return noneHistory[lang];
    }

    const none: Record<string, string> = {
      sv: "Jag hittar ingen kommande bokning här 😊 Vilket mobilnummer bokade du med?",
      fa: "رزرو آینده‌ای پیدا نکردم 😊 با چه شماره‌ای رزرو کردید؟",
      de: "Ich habe keine kommende Buchung zu Ihren Angaben gefunden. Soll ich mit einer anderen Mobilnummer suchen? 📅",
      es: "No encontré ninguna reserva próxima asociada a tus datos. ¿Quieres que busque con otro número? 📅",
      ar: "لم أجد حجزًا قادمًا مرتبطًا ببياناتك. هل تريد أن أبحث برقم هاتف آخر؟ 📅",
      en: "I can’t find an upcoming booking here 😊 What mobile number did you book with?"
    };
    return none[lang];
  }

  if (result.appointments.length === 1) {
    const temporalState = classifyAppointmentTemporalState(
      result.appointments[0]
    );
    if (temporalState !== "future_or_active") {
      return formatPastAppointmentMutationReply(
        result.appointments[0],
        temporalState,
        lang
      );
    }
  }

  const selectionPrompt = formatAppointmentSelectionPrompt(result, lang);
  if (selectionPrompt) return selectionPrompt;

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
    const when = new Intl.DateTimeFormat(localeMap[lang], {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
    const name = String(appointment.customerName || "").trim();
    const service = String(appointment.service || "").trim();
    if (lang === "sv") return `${when}${name ? `, bokad i namnet ${name}` : ""}${service && service !== "Appointment" ? ` för ${service}` : ""}`;
    if (lang === "fa") return `${when}${name ? `، به نام ${name}` : ""}${service && service !== "Appointment" ? ` برای ${service}` : ""}`;
    if (lang === "de") return `${when}${name ? `, auf den Namen ${name}` : ""}${service && service !== "Appointment" ? ` für ${service}` : ""}`;
    if (lang === "es") return `${when}${name ? `, a nombre de ${name}` : ""}${service && service !== "Appointment" ? ` para ${service}` : ""}`;
    if (lang === "ar") return `${when}${name ? `، باسم ${name}` : ""}${service && service !== "Appointment" ? ` لخدمة ${service}` : ""}`;
    return `${when}${name ? `, under the name ${name}` : ""}${service && service !== "Appointment" ? ` for ${service}` : ""}`;
  });

  const joined = formatted.join(", ");
  const found: Record<string, string> = {
    sv: `Ja 😊 Din bokning är ${joined}.`,
    fa: `بله 😊 رزروتون ${joined} هست.`,
    de: `Ja, ich habe Ihre Buchung gefunden: ${joined}. 📅`,
    es: `Sí, encontré tu reserva: ${joined}. 📅`,
    ar: `نعم، وجدت حجزك: ${joined}. 📅`,
    en: `Yes 😊 Your booking is ${joined}.`
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
      description: "Looks up only the current customer's appointments. MUST be used when the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they have an appointment. Use lookupMode=today for the full local day, including times already passed; use upcoming for future bookings and history for the previous 7 local calendar days. For yesterday or an explicit date/period, pass that exact date range. The server automatically uses the current channel identity; pass a phone number only when the customer explicitly provides it.",
      parameters: {
        type: "OBJECT",
        properties: {
          startDate: { type: "STRING", description: "Optional start date in YYYY-MM-DD. Use the relevant date when the customer mentions today, tomorrow, next week, or a specific day." },
          endDate: { type: "STRING", description: "Optional end date in YYYY-MM-DD. Use the same value as startDate for one explicit day." },
          lookupMode: { type: "STRING", enum: ["upcoming", "today", "history"], description: "Appointment time scope. Use today for today's complete local calendar day, upcoming for future bookings, or history for the previous 7 local calendar days." },
          phone: { type: "STRING", description: "Customer phone number only if explicitly provided in the conversation." },
          name: { type: "STRING", description: "Optional display name for reply context. A name alone is never used as booking identity." }
        }
      }
    },
    {
      name: "rescheduleAppointment",
      description: "Moves an existing appointment to a new exact ISO date and time. Use only after findCustomerAppointments has returned a calendarEventId and after the new slot has been checked.",
      parameters: {
        type: "OBJECT",
        properties: {
          eventId: { type: "STRING", description: "The Google Calendar event id returned by findCustomerAppointments." },
          dateTime: { type: "STRING", description: "The new start time in ISO 8601 format." },
          durationMinutes: { type: "INTEGER", description: "Appointment duration in minutes." }
        },
        required: ["eventId", "dateTime", "durationMinutes"]
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

function selectAuthoritativeGeminiFunctionCalls(
  calls: any[],
  sessionId?: string
): any[] {
  const available = Array.isArray(calls)
    ? calls.filter((call) => String(call?.function?.name || "").trim())
    : [];
  if (available.length <= 1) return available;

  const hasVerifiedReschedule = Boolean(sessionId && getRescheduleContext(sessionId));
  const priority = hasVerifiedReschedule
    ? ["rescheduleAppointment", "findCustomerAppointments", "checkSlots", "insertAppointment", "logSystemAnalysis"]
    : ["findCustomerAppointments", "checkSlots", "rescheduleAppointment", "insertAppointment", "logSystemAnalysis"];
  const selected = priority
    .map((name) => available.find((call) => call.function.name === name))
    .find(Boolean) || available[0];

  console.warn("[BookingFlow]", {
    operation: "gemini_tool_dispatch",
    offeredToolCount: available.length,
    selectedTool: String(selected?.function?.name || "unknown"),
    finalHandledPath: "single_authoritative_tool"
  });
  return selected ? [selected] : [];
}

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
type ConversationFlowLanguageContext = {
  language: string;
  flowType: "appointment" | "booking" | "reschedule" | "cancellation" | "availability" | "service_info";
  createdAt: number;
  updatedAt: number;
};
const FLOW_LANGUAGE_TTL_MS = Number(process.env.FLOW_LANGUAGE_TTL_MINUTES || 120) * 60 * 1000;
const conversationFlowLanguages: Record<string, ConversationFlowLanguageContext> = {};

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
const recentlyCompletedBookings: Record<string, {
  completedAt: number;
  language: string;
  name?: string;
  service?: string;
  durationMinutes?: number;
  dateTime?: string;
}> = {};
const appointmentContexts: Record<string, { appointment: any; savedAt: number; language: string }> = {};
const appointmentSelectionContexts: Record<string, { appointments: any[]; savedAt: number; language: string; intent?: "reschedule" | "cancel" | "lookup" }> = {};
type AppointmentLookupContext = {
  savedAt: number;
  language: string;
  businessId?: string;
  platform?: string;
  userId?: string;
  includePast?: boolean;
  lookupMode?: AppointmentLookupMode;
  historyWindowLimited?: boolean;
  operation?: "lookup" | "reschedule" | "cancel";
  verifiedPhone?: string;
  receivedPhone?: string;
  receivedName?: string;
  requestedDate?: string;
  approximateTime?: string;
  requestedService?: string;
  lookupAlreadyRan?: boolean;
  additionalIdentificationRequired?: boolean;
  lastPromptKey?: string;
  recoveryMode?: boolean;
  recoveryPromptCount?: number;
  phoneReceivedAt?: number;
  lookupAttemptedAt?: number;
  resultCategory?:
    | "needs_verified_phone"
    | "phone_unverified"
    | "verified_not_found"
    | "recovery_needs_attribute"
    | "recovery_ambiguous"
    | "recovery_not_found";
  nextAction?:
    | "awaiting_verified_phone"
    | "awaiting_recovery_attribute"
    | "clarify_recovery"
    | "offer_new_booking";
};
const appointmentLookupContexts: Record<string, AppointmentLookupContext> = {};
type RescheduleOperation =
  | "awaiting_target"
  | "awaiting_slot_selection"
  | "awaiting_confirmation"
  | "updating"
  | "update_failed"
  | "verification_failed";

type RescheduleContext = {
  sessionId: string;
  businessId: string;
  platform: string;
  userId: string;
  identityKey: string;
  appointment: any;
  originalAppointmentId: string;
  exactCalendarEventId: string;
  originalStartTime: string;
  requestedDate?: string;
  requestedTime?: string;
  requestedDaypart?: "morning" | "afternoon" | "evening";
  selectedNewStartTime?: string;
  selectedEndTime?: string;
  offeredSlots?: string[];
  ownedOfferedSlots?: OwnedOfferedSlot[];
  lastOfferedTime?: string;
  serviceDuration: number;
  service: string;
  verifiedPhone?: string;
  contactSatisfied?: boolean;
  operationType: "reschedule";
  lockedReplyLanguage: string;
  language: string;
  lastOperation: RescheduleOperation;
  createdAt: number;
  savedAt: number;
};

const RESCHEDULE_CONTEXT_TTL_MS = Number(process.env.RESCHEDULE_CONTEXT_TTL_MINUTES || 60) * 60 * 1000;
const rescheduleContexts: Record<string, RescheduleContext> = {};
const recentlyCompletedReschedules: Record<string, { completedAt: number; eventId: string; newStartTime: string }> = {};
type CancellationOperation =
  | "awaiting_reason"
  | "awaiting_confirmation"
  | "processing"
  | "completed"
  | "failed";

type CancellationContext = {
  appointment: any;
  savedAt: number;
  language: string;
  feeApplies: boolean;
  feeAmount: number;
  currency: string;
  awaitingReason: boolean;
  reason?: string;
  lastOperation: CancellationOperation;
};

const cancellationContexts: Record<string, CancellationContext> = {};
const recentlyCompletedCancellations: Record<string, {
  completedAt: number;
  appointmentId: string;
  calendarEventId: string;
  language: string;
}> = {};
const appointmentStateOwners: Record<string, AppointmentStateOwner> = {};
type AvailabilityConstraintKind =
  | "whole_day"
  | "exact_time"
  | "time_window"
  | "time_boundary"
  | "approximate_time"
  | "daypart"
  | "date_range";

type CanonicalAvailabilityConstraint = {
  startDate: string;
  endDate: string;
  kind: AvailabilityConstraintKind;
  exactTime?: string;
  minTime?: string;
  maxTime?: string;
  timeBoundary?: TimeBoundary;
  daypart?: "morning" | "afternoon" | "evening";
  rejectedTimes: string[];
  generatedFromLatestRequestAt: number;
};

type AvailabilitySearchContext = {
  constraint: CanonicalAvailabilityConstraint;
  service: string;
  durationMinutes: number;
  language: string;
  businessId: string;
  platform: string;
  userId: string;
  savedAt: number;
  lastResultCategory?: "available" | "no_availability";
};
const availabilitySearchContexts: Record<string, AvailabilitySearchContext> = {};
const lastServiceInformationReplies: Record<string, { key: string; sentAt: number }> = {};
const pastAppointmentRecoveryContexts: Record<string, {
  savedAt: number;
  language: string;
  owner: AppointmentStateOwner;
}> = {};

function hasAppointmentConversationState(sessionId: string): boolean {
  return Boolean(
    appointmentContexts[sessionId] ||
    appointmentSelectionContexts[sessionId] ||
    appointmentLookupContexts[sessionId] ||
    rescheduleContexts[sessionId] ||
    cancellationContexts[sessionId]
  );
}

function clearAppointmentConversationState(sessionId: string) {
  delete appointmentContexts[sessionId];
  delete appointmentSelectionContexts[sessionId];
  delete appointmentLookupContexts[sessionId];
  delete rescheduleContexts[sessionId];
  delete cancellationContexts[sessionId];
  delete appointmentStateOwners[sessionId];
  delete availabilitySearchContexts[sessionId];
  delete pastAppointmentRecoveryContexts[sessionId];
  clearConversationFlowLanguage(sessionId);
}

function getAppointmentMutationId(appointment: any): string {
  return String(appointment?.id || appointment?.calendarEventId || "").trim();
}

function getAppointmentCalendarEventId(appointment: any): string {
  return String(appointment?.calendarEventId || (appointment?.source === "calendar" ? appointment?.id : "") || "").trim();
}

function getAppointmentDurationMinutes(appointment: any): number {
  const startMs = new Date(String(appointment?.start || "")).getTime();
  const endMs = new Date(String(appointment?.end || "")).getTime();
  const measured = Math.round((endMs - startMs) / 60000);
  return Math.max(
    1,
    Number.isFinite(measured) && measured > 0
      ? measured
      : (getDefaultBookingDurationForService(appointment?.service) || 30)
  );
}

function saveAppointmentStateOwner(sessionId: string, owner: AppointmentStateOwner, identityKey?: string) {
  appointmentStateOwners[sessionId] = {
    ...owner,
    ...(identityKey ? { identityKey } : {})
  };
}

function rememberAppointmentContext(sessionId: string, result: any, language: string, owner?: AppointmentStateOwner) {
  const appointments = Array.isArray(result?.appointments)
    ? result.appointments.filter(Boolean)
    : [];

  delete appointmentContexts[sessionId];
  delete appointmentSelectionContexts[sessionId];
  if (owner) saveAppointmentStateOwner(sessionId, owner, result?.identityKey);

  if (appointments.length === 1) {
    appointmentContexts[sessionId] = {
      appointment: appointments[0],
      savedAt: Date.now(),
      language
    };
    return;
  }

  if (appointments.length > 1) {
    appointmentSelectionContexts[sessionId] = {
      appointments,
      savedAt: Date.now(),
      language
    };
  }
}

function getAppointmentContext(sessionId: string) {
  const context = appointmentContexts[sessionId];
  if (!context) return null;
  if (Date.now() - context.savedAt > 60 * 60 * 1000) {
    delete appointmentContexts[sessionId];
    return null;
  }
  return context;
}

function getAppointmentSelectionContext(sessionId: string) {
  const context = appointmentSelectionContexts[sessionId];
  if (!context) return null;
  if (Date.now() - context.savedAt > 30 * 60 * 1000) {
    delete appointmentSelectionContexts[sessionId];
    return null;
  }
  return context;
}

function clearAppointmentSelectionContext(sessionId: string) {
  delete appointmentSelectionContexts[sessionId];
}

function normalizeAppointmentSelectionText(value?: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectAppointmentFromText(
  text: string,
  appointments: any[]
): { type: "one"; appointment: any } | { type: "all" } | null {
  const raw = normalizeAppointmentSelectionText(text);
  if (!raw || !Array.isArray(appointments) || appointments.length === 0) return null;

  if (/\b(båda|bada|alla|allihop|both|all|har do|hardota|هر دو|هردو|همه|دوتا|دوتاش)\b/i.test(raw)) {
    return { type: "all" };
  }

  const numericSelection = raw.match(/^(?:(?:nummer|numret|nr|number|no|n:o|شماره|رقم)\s*)?([1-9]\d*)$/i);
  if (numericSelection) {
    const index = Number(numericSelection[1]) - 1;
    if (appointments[index]) return { type: "one", appointment: appointments[index] };
  }

  const ordinalMap: Array<[RegExp, number]> = [
    [/\b(första|forsta|first|اولی|اول)\b/i, 0],
    [/\b(andra|second|دومی|دوم)\b/i, 1],
    [/\b(tredje|third|سومی|سوم)\b/i, 2],
    [/\b(fjärde|fjarde|fourth|چهارمی|چهارم)\b/i, 3]
  ];

  for (const [pattern, index] of ordinalMap) {
    if (pattern.test(raw) && appointments[index]) {
      return { type: "one", appointment: appointments[index] };
    }
  }

  const byName = appointments.find((appointment: any) => {
    const name = normalizeAppointmentSelectionText(appointment?.customerName);
    return name.length >= 2 && (raw === name || raw.includes(name) || name.includes(raw));
  });
  if (byName) return { type: "one", appointment: byName };

  const rawDigits = normalizeLookupDigits(raw);
  if (rawDigits.length >= 4) {
    const byPhone = appointments.find((appointment: any) => {
      const phone = normalizeLookupDigits(appointment?.phone);
      return phone && (phone.endsWith(rawDigits) || rawDigits.endsWith(phone));
    });
    if (byPhone) return { type: "one", appointment: byPhone };
  }

  return null;
}

function formatAppointmentSelectionPrompt(result: any, language: string = "en"): string | null {
  const appointments = Array.isArray(result?.appointments) ? result.appointments : [];
  if (appointments.length <= 1) return null;

  const lang = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";
  const localeMap: Record<string, string> = {
    sv: "sv-SE",
    fa: "fa-IR",
    de: "de-DE",
    es: "es-ES",
    ar: "ar",
    en: "en-GB"
  };

  const rows = appointments.slice(0, 5).map((appointment: any, index: number) => {
    const date = new Date(appointment.start);
    const when = new Intl.DateTimeFormat(localeMap[lang], {
      timeZone: "Europe/Stockholm",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);

    const name = String(appointment.customerName || "").trim();
    const service = String(appointment.service || "").trim();
    const serviceSuffix = service && service !== "Appointment" ? ` — ${service}` : "";

    if (lang === "fa") return `${index + 1}) ${name || "بدون نام"} — ${when}${serviceSuffix}`;
    if (lang === "sv") return `${index + 1}) ${name || "Utan namn"} — ${when}${serviceSuffix}`;
    return `${index + 1}) ${name || "No name"} — ${when}${serviceSuffix}`;
  });

  const intro: Record<string, string> = {
    sv: "Jag hittade flera bokningar kopplade till den här konversationen:",
    fa: "چند رزرو مرتبط با این گفتگو پیدا کردم:",
    de: "Ich habe mehrere Buchungen gefunden:",
    es: "Encontré varias reservas:",
    ar: "وجدت عدة حجوزات مرتبطة بهذه المحادثة:",
    en: "I found several bookings linked to this conversation:"
  };

  const question: Record<string, string> = {
    sv: 'Vilken menar du? Svara med namnet, numret i listan eller "båda". 📅',
    fa: "منظورتان کدام است؟ نام، شماره فهرست یا «هر دو» را بفرستید. 📅",
    de: "Welche meinen Sie? Antworten Sie mit dem Namen, der Nummer oder „alle“. 📅",
    es: "¿Cuál quieres decir? Responde con el nombre, el número o «todas». 📅",
    ar: "أي حجز تقصد؟ أرسل الاسم أو رقم الحجز أو «الكل». 📅",
    en: 'Which one do you mean? Reply with the name, list number, or "both". 📅'
  };

  return `${intro[lang]}\n${rows.join("\n")}\n${question[lang]}`;
}

function formatAllAppointmentsSelectedReply(language: string = "en"): string {
  const lang = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";
  const replies: Record<string, string> = {
    sv: "Okej, du menar båda bokningarna. Vad vill du göra med dem — kontrollera, flytta eller avboka? 📅",
    fa: "باشه، منظورتان هر دو رزرو است. می‌خواهید آن‌ها را بررسی، جابه‌جا یا لغو کنید؟ 📅",
    de: "Okay, Sie meinen beide Buchungen. Möchten Sie sie prüfen, verschieben oder stornieren? 📅",
    es: "De acuerdo, te refieres a ambas reservas. ¿Quieres revisarlas, cambiarlas o cancelarlas? 📅",
    ar: "حسنًا، تقصد الحجزين معًا. هل تريد التحقق منهما أو تغييرهما أو إلغاءهما؟ 📅",
    en: "Okay, you mean both bookings. Would you like to check, move, or cancel them? 📅"
  };
  return replies[lang];
}

function isMissedPastAppointmentsIntent(text?: string): boolean {
  const raw = normalizeAppointmentSelectionText(text);
  if (!raw) return false;

  return (
    /\b(missade|missat|missade bada|missat bada|hann inte|kom inte|uteblev)\b/i.test(raw) ||
    /\b(missed|did not make it|could not come|didnt come|didn't come)\b/i.test(raw) ||
    /\b(از دست دادم|نرسیدم|نتونستم بیام|نتوانستم بیایم|فراموش کردم)\b/u.test(String(text || "")) ||
    /\b(miss kardam|natonestam biam|nemitonestam biam)\b/i.test(raw)
  );
}

function formatMissedPastAppointmentsReply(appointments: any[], language: string = "en"): string {
  const lang = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";
  const count = Array.isArray(appointments) ? appointments.length : 0;

  if (lang === "sv") {
    return count > 1
      ? "Ja, båda tiderna har redan passerat. Vill du att jag hjälper dig boka en ny tid? 📅"
      : "Ja, tiden har redan passerat. Vill du att jag hjälper dig boka en ny tid? 📅";
  }
  if (lang === "fa") {
    return count > 1
      ? "بله، هر دو وقت گذشته‌اند. می‌خواهید برایتان وقت جدید پیدا کنم؟ 📅"
      : "بله، این وقت گذشته است. می‌خواهید برایتان وقت جدید پیدا کنم؟ 📅";
  }
  if (lang === "de") return "Ja, die Termine sind bereits vorbei. Soll ich Ihnen helfen, einen neuen Termin zu buchen? 📅";
  if (lang === "es") return "Sí, las citas ya han pasado. ¿Quieres que te ayude a reservar una nueva? 📅";
  if (lang === "ar") return "نعم، المواعيد قد مضت. هل تريد أن أساعدك في حجز موعد جديد؟ 📅";
  return count > 1
    ? "Yes, both appointments have already passed. Would you like help booking a new one? 📅"
    : "Yes, the appointment has already passed. Would you like help booking a new one? 📅";
}

function rememberAppointmentLookupContext(
  sessionId: string,
  language: string,
  includePast: boolean = false,
  lookupMode: AppointmentLookupMode = includePast ? "history" : "upcoming",
  historyWindowLimited: boolean = false,
  updates: Partial<AppointmentLookupContext> = {}
) {
  const owner = appointmentStateOwners[sessionId];
  const nextAction = updates.nextAction ??
    appointmentLookupContexts[sessionId]?.nextAction;
  appointmentLookupContexts[sessionId] = {
    ...(appointmentLookupContexts[sessionId] || {}),
    ...(owner
      ? {
          businessId: owner.businessId,
          platform: normalizePlatformName(owner.platform),
          userId: normalizePlatformUserId(owner.platform, owner.userId)
        }
      : {}),
    ...updates,
    savedAt: Date.now(),
    language,
    includePast,
    lookupMode,
    historyWindowLimited,
    lookupAlreadyRan: Boolean(
      updates.lookupAttemptedAt ||
      appointmentLookupContexts[sessionId]?.lookupAttemptedAt
    ),
    additionalIdentificationRequired: [
      "awaiting_verified_phone",
      "awaiting_recovery_attribute",
      "clarify_recovery"
    ].includes(String(nextAction || ""))
  };
}

function getAppointmentLookupContext(sessionId: string) {
  const context = appointmentLookupContexts[sessionId];
  if (!context) return null;
  if (Date.now() - context.savedAt > 30 * 60 * 1000) {
    delete appointmentLookupContexts[sessionId];
    return null;
  }
  return context;
}

function clearAppointmentLookupContext(sessionId: string) {
  delete appointmentLookupContexts[sessionId];
}

function rememberLookupResultForConversation(
  sessionId: string,
  result: any,
  language: string,
  platform: string,
  userId: string,
  businessConfig: any
) {
  const lookupMode: AppointmentLookupMode = result?.lookupMode === "today" || result?.lookupMode === "history"
    ? result.lookupMode
    : "upcoming";
  const owner: AppointmentStateOwner = {
    sessionId,
    businessId: getAppointmentBusinessScope(businessConfig),
    platform: normalizePlatformName(platform),
    userId: normalizePlatformUserId(platform, userId),
  };

  rememberAppointmentContext(sessionId, result, language, owner);
  if (result?.found) clearAppointmentLookupContext(sessionId);
  else rememberAppointmentLookupContext(
    sessionId,
    language,
    lookupMode === "history",
    lookupMode,
    Boolean(result?.historyWindowLimited)
  );
}

async function validateStoredAppointmentForMutation(
  appointment: any,
  owner: AppointmentStateOwner,
  businessConfig: any,
  adapter: CalendarAdapter
): Promise<any | null> {
  if (!appointment || !isActiveAppointmentStatus(appointment?.status)) return null;

  const businessId = String(getBusinessIdFromConfig(businessConfig) || "");
  const businessScope = getAppointmentBusinessScope(businessConfig);
  if (!businessScope || owner.businessId !== businessScope) return null;

  if (appointment?.source === "appointments_table") {
    if (!supabase || !businessId || !appointment?.id) return null;

    const { data, error } = await supabase
      .from("appointments")
      .select("id,customer_name,phone_number,platform,user_id,service,start_time,end_time,status,business_id")
      .eq("id", appointment.id)
      .eq("business_id", businessId)
      .maybeSingle();

    if (error) {
      console.error("[AppointmentState] Live appointment validation failed:", error);
      return null;
    }
    if (!data || !isActiveAppointmentStatus(data.status)) return null;

    const rowPlatform = normalizePlatformName(data.platform || "");
    const rowUserId = normalizePlatformUserId(rowPlatform, String(data.user_id || ""));
    const ownerPlatform = normalizePlatformName(owner.platform);
    const ownerUserId = normalizePlatformUserId(ownerPlatform, owner.userId);
    const channelMatch = rowPlatform === ownerPlatform && rowUserId === ownerUserId;
    const ownerPhone = String(owner.identityKey || "").startsWith("phone:")
      ? normalizeLookupDigits(String(owner.identityKey).slice("phone:".length))
      : "";
    const phoneMatch = ownerPhone.length >= 7 &&
      rowPlatform === ownerPlatform &&
      normalizeLookupDigits(data.phone_number) === ownerPhone &&
      (!rowUserId || rowUserId === ownerUserId);
    const identityIsChannel = String(owner.identityKey || "").startsWith("channel:");
    if (identityIsChannel ? !channelMatch : (!channelMatch && !phoneMatch)) return null;

    return {
      ...appointment,
      customerName: data.customer_name || appointment.customerName,
      phone: data.phone_number || appointment.phone,
      platform: data.platform || appointment.platform,
      userId: data.user_id || appointment.userId,
      businessId: data.business_id || appointment.businessId,
      service: data.service || appointment.service,
      start: data.start_time,
      end: data.end_time,
      status: data.status,
    };
  }

  const eventId = String(appointment?.calendarEventId || appointment?.id || "");
  const start = new Date(String(appointment?.start || ""));
  if (!eventId || Number.isNaN(start.getTime())) return null;

  const appointmentDate = stockholmDateString(start);
  const events = await adapter.getEvents(appointmentDate, appointmentDate);
  const liveEvent = (Array.isArray(events) ? events : []).find((event: any) =>
    String(event?.id || "") === eventId
  );
  if (!liveEvent || !isActiveAppointmentStatus(liveEvent.status)) return null;
  if (!calendarEventBusinessMarkerMatches(liveEvent, businessScope)) return null;

  const exactChannelOwner = calendarEventHasExactChannelOwner(liveEvent, owner.platform, owner.userId);
  const ownerPhone = String(owner.identityKey || "").startsWith("phone:")
    ? String(owner.identityKey).slice("phone:".length)
    : "";
  const exactVerifiedPhone = normalizePlatformName(owner.platform) !== "messenger" &&
    ownerPhone.length >= 7 &&
    calendarEventHasExactPhone(liveEvent, ownerPhone);
  if (!exactChannelOwner && !exactVerifiedPhone) return null;

  return {
    ...appointment,
    start: getEventStartIso(liveEvent) || appointment.start,
    end: getEventEndIso(liveEvent) || appointment.end,
    status: liveEvent.status || appointment.status || "booked",
  };
}

function formatStaleAppointmentStateMessage(language: string): string {
  if (language === "sv") return "Jag kollar gärna igen 😊 Vilket mobilnummer bokade du med?";
  if (language === "fa") return "حتماً دوباره بررسی می‌کنم 😊 با چه شماره‌ای رزرو کردید؟";
  return "I’ll gladly check again 😊 What mobile number did you book with?";
}

function rememberRescheduleContext(
  sessionId: string,
  appointment: any,
  language: string,
  requestedDate?: string | null,
  requestedTime?: string | null,
  updates: Partial<RescheduleContext> = {}
) {
  const now = Date.now();
  const existing = rescheduleContexts[sessionId];
  const owner = appointmentStateOwners[sessionId];
  const sameAppointment = Boolean(
    existing &&
    existing.originalAppointmentId === getAppointmentMutationId(appointment) &&
    existing.exactCalendarEventId === getAppointmentCalendarEventId(appointment)
  );
  const base = sameAppointment ? existing : null;
  const lockedReplyLanguage = String(
    updates.lockedReplyLanguage ||
    base?.lockedReplyLanguage ||
    language ||
    "en"
  );

  rescheduleContexts[sessionId] = {
    ...(base || {}),
    ...updates,
    sessionId,
    businessId: String(owner?.businessId || ""),
    platform: normalizePlatformName(owner?.platform || appointment?.platform || ""),
    userId: normalizePlatformUserId(owner?.platform || appointment?.platform || "", String(owner?.userId || appointment?.userId || "")),
    identityKey: String(owner?.identityKey || appointment?.identityKey || ""),
    appointment,
    originalAppointmentId: getAppointmentMutationId(appointment),
    exactCalendarEventId: getAppointmentCalendarEventId(appointment),
    originalStartTime: String(base?.originalStartTime || appointment?.start || ""),
    serviceDuration: Number(base?.serviceDuration || getAppointmentDurationMinutes(appointment)),
    service: String(base?.service || appointment?.service || "Bokning"),
    operationType: "reschedule",
    lockedReplyLanguage,
    language: lockedReplyLanguage,
    lastOperation: updates.lastOperation || base?.lastOperation || "awaiting_target",
    createdAt: Number(base?.createdAt || now),
    savedAt: now,
    ...(requestedDate ? { requestedDate } : {}),
    ...(requestedTime ? { requestedTime } : {})
  };
}

function getRescheduleContext(sessionId: string) {
  return rescheduleContexts[sessionId] || null;
}

function isRescheduleContextStale(context: RescheduleContext): boolean {
  return !context.createdAt || Date.now() - context.createdAt > RESCHEDULE_CONTEXT_TTL_MS;
}

function getRescheduleReplyLanguage(context: RescheduleContext, latestText?: string): string {
  return isExplicitLanguageSwitch(latestText) ||
    context.lockedReplyLanguage ||
    context.language ||
    "en";
}

function rescheduleContextOwnerMatches(
  context: RescheduleContext,
  currentOwner: AppointmentStateOwner,
  storedOwner: AppointmentStateOwner | undefined
): boolean {
  if (!storedOwner || !appointmentStateOwnerMatches(storedOwner, currentOwner)) return false;
  if (context.sessionId !== currentOwner.sessionId) return false;
  if (context.businessId !== currentOwner.businessId) return false;
  if (normalizePlatformName(context.platform) !== normalizePlatformName(currentOwner.platform)) return false;
  if (
    normalizePlatformUserId(context.platform, context.userId) !==
    normalizePlatformUserId(currentOwner.platform, currentOwner.userId)
  ) return false;
  if (!context.identityKey) return false;
  if (context.identityKey !== String(storedOwner.identityKey || "")) return false;
  if (context.originalAppointmentId !== getAppointmentMutationId(context.appointment)) return false;
  if (context.exactCalendarEventId !== getAppointmentCalendarEventId(context.appointment)) return false;
  return Boolean(context.originalAppointmentId && context.exactCalendarEventId);
}

function clearRescheduleContext(sessionId: string) {
  delete rescheduleContexts[sessionId];
}

function isCancellationIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase().normalize("NFKC");
  if (!raw) return false;
  return /(?:^|\s)(?:avboka|avbokning|avboka den|avboka tiden|cancel|cancel it|cancel my appointment|cancel the appointment|cancell?ation|laghv|لغو|کنسل)(?=\s|$)/iu.test(raw);
}

function isCancellationConfirmation(text?: string): boolean {
  const raw = normalizeConfirmationReply(text);
  if (!raw || isCancellationRejection(raw)) return false;
  return isCompoundAffirmativeReply(raw) ||
    /^(?:bekrafta|avboka|avboka den|confirm|cancel it|taeed|تایید|لغو کن)$/u.test(raw);
}

function isCancellationRejection(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  return /^(?:nej|nej tack|avbryt|no|keep it|don'?t cancel|na|نه|خیر|لغو نکن)[!.؟?\s]*$/iu.test(raw);
}

function getCancellationPolicy(config: any) {
  const allowCancellation = Boolean(config?.allowCancellation ?? config?.allow_cancellation ?? false);
  const deadlineMinutes = Math.max(0, Number(config?.cancellationDeadlineMinutes ?? config?.cancellation_deadline_minutes ?? 0) || 0);
  const feeEnabled = Boolean(config?.cancellationFeeEnabled ?? config?.cancellation_fee_enabled ?? false);
  const feeAmount = Math.max(0, Number(config?.cancellationFeeAmount ?? config?.cancellation_fee_amount ?? 0) || 0);
  const currency = String(config?.cancellationFeeCurrency ?? config?.cancellation_fee_currency ?? "SEK").trim().toUpperCase() || "SEK";
  return { allowCancellation, deadlineMinutes, feeEnabled, feeAmount, currency };
}

function getCancellationFeeState(appointment: any, config: any) {
  const policy = getCancellationPolicy(config);
  const startMs = new Date(String(appointment?.start || "")).getTime();
  const minutesRemaining = Number.isFinite(startMs) ? (startMs - Date.now()) / 60000 : Number.POSITIVE_INFINITY;
  const insideDeadline = policy.deadlineMinutes > 0 && minutesRemaining < policy.deadlineMinutes;
  return { ...policy, minutesRemaining, feeApplies: insideDeadline && policy.feeEnabled && policy.feeAmount > 0 };
}

function rememberCancellationContext(sessionId: string, appointment: any, language: string, config: any) {
  const fee = getCancellationFeeState(appointment, config);
  cancellationContexts[sessionId] = {
    appointment,
    savedAt: Date.now(),
    language,
    feeApplies: fee.feeApplies,
    feeAmount: fee.feeAmount,
    currency: fee.currency,
    awaitingReason: true,
    lastOperation: "awaiting_reason"
  };
}

function getCancellationContext(sessionId: string) {
  const context = cancellationContexts[sessionId];
  if (!context) return null;
  if (Date.now() - context.savedAt > 15 * 60 * 1000) {
    delete cancellationContexts[sessionId];
    return null;
  }
  return context;
}

function clearCancellationContext(sessionId: string) {
  delete cancellationContexts[sessionId];
}

function getRecentCompletedCancellation(sessionId: string) {
  const completed = recentlyCompletedCancellations[sessionId];
  if (!completed) return null;
  if (Date.now() - completed.completedAt > 30 * 60 * 1000) {
    delete recentlyCompletedCancellations[sessionId];
    return null;
  }
  return completed;
}

function logInstagramCancellationStage(details: {
  stage: string;
  businessScopePresent: boolean;
  result: string;
  ownershipMatch?: boolean;
  calendarVerified?: boolean;
  databaseVerified?: boolean;
}) {
  console.log("[InstagramCancellation]", {
    platform: "instagram",
    stage: details.stage,
    businessScopePresent: details.businessScopePresent,
    result: details.result,
    ...(typeof details.ownershipMatch === "boolean"
      ? { ownershipMatch: details.ownershipMatch }
      : {}),
    ...(typeof details.calendarVerified === "boolean"
      ? { calendarVerified: details.calendarVerified }
      : {}),
    ...(typeof details.databaseVerified === "boolean"
      ? { databaseVerified: details.databaseVerified }
      : {})
  });
}

function formatCancellationDisabled(language: string): string {
  if (language === "fa") return "لغو خودکار برای این کسب‌وکار فعال نیست. لطفاً برای لغو با مجموعه تماس بگیرید. 🙏";
  if (language === "sv") return "Den här verksamheten har inte aktiverat automatisk avbokning. Kontakta gärna personalen för hjälp. 🙏";
  return "This business has not enabled automatic cancellation. Please contact the team for help. 🙏";
}

function formatCancellationReasonQuestion(language: string): string {
  if (language === "fa") return "دلیل لغو چیست؟ لطفاً خیلی کوتاه بنویسید.";
  if (language === "sv") return "Varför vill du avboka? Svara gärna mycket kort.";
  if (language === "de") return "Warum möchten Sie stornieren? Bitte kurz antworten.";
  if (language === "es") return "¿Por qué quieres cancelar? Responde muy brevemente.";
  if (language === "ar") return "ما سبب الإلغاء؟ أجب باختصار شديد.";
  return "Why would you like to cancel? Please answer very briefly.";
}

function normalizeCancellationReason(text?: string): string {
  const reason = String(text || "").replace(/\s+/g, " ").trim();
  if (!reason) return "Not provided";
  return reason.length > 120 ? `${reason.slice(0, 117)}...` : reason;
}

function isInvalidCancellationReason(text?: string): boolean {
  const raw = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[!?.،,؛:«»"'()\s]+/g, " ")
    .trim();

  if (!raw || raw.length < 3) return true;
  if (isCancellationConfirmation(raw) || isCancellationRejection(raw)) return true;

  // Generic confirmations or repeated cancellation commands are not actual reasons.
  return /^(?:ok|okej|okay|yes|yeah|yep|sure|confirm|ja|ja tack|bale|baleh|are|taeed|تایید|تأیید|بله|آره|باشه|حتما|نعم|si|sí|vale|avboka|avboka den|cancel|cancel it|cancel konam|cancelesh kon|laghv|laghv kon|لغو|لغو کن|کنسل|کنسل کن)$/iu.test(raw);
}

function formatInvalidCancellationReason(language: string): string {
  if (language === "fa") return "لطفاً دلیل واقعی لغو را خیلی کوتاه بنویسید؛ مثلاً «برنامه‌ام عوض شد».";
  if (language === "sv") return "Skriv gärna en kort faktisk anledning, till exempel “mina planer ändrades”.";
  if (language === "de") return "Bitte nennen Sie kurz einen tatsächlichen Grund, zum Beispiel „Meine Pläne haben sich geändert“.";
  if (language === "es") return "Escribe un motivo real y breve, por ejemplo: «Cambiaron mis planes».";
  if (language === "ar") return "اكتب سببًا حقيقيًا ومختصرًا، مثل: «تغيّرت خططي».";
  return "Please give a real, brief reason, for example: “My plans changed.”";
}

function formatCancellationDisabledDuringFlow(language: string): string {
  if (language === "fa") return "لغو خودکار غیرفعال شده و رزرو شما لغو نشد. لطفاً با مجموعه تماس بگیرید. 🙏";
  if (language === "sv") return "Automatisk avbokning har stängts av och bokningen avbokades inte. Kontakta personalen för hjälp. 🙏";
  if (language === "de") return "Die automatische Stornierung wurde deaktiviert; der Termin wurde nicht storniert. Bitte kontaktieren Sie das Team. 🙏";
  if (language === "es") return "La cancelación automática se ha desactivado y la reserva no fue cancelada. Contacta con el equipo. 🙏";
  if (language === "ar") return "تم تعطيل الإلغاء التلقائي ولم يتم إلغاء الحجز. يرجى التواصل مع الفريق. 🙏";
  return "Automatic cancellation has been disabled, so the appointment was not cancelled. Please contact the team. 🙏";
}

function formatCancellationConfirmation(appointment: any, language: string, feeApplies: boolean, feeAmount: number, currency: string): string {
  const { dateText, timeText } = formatLocalizedDateTime(String(appointment?.start || ""), language);
  const fee = `${feeAmount.toLocaleString("sv-SE")} ${currency}`;
  if (language === "fa") return feeApplies
    ? `آیا مطمئن هستید که می‌خواهید رزرو ${dateText} ساعت ${timeText} را لغو کنید؟ طبق قوانین مجموعه، هزینه لغو دیرهنگام ${fee} اعمال می‌شود. برای تأیید بنویسید «بله».`
    : `آیا مطمئن هستید که می‌خواهید رزرو ${dateText} ساعت ${timeText} را لغو کنید؟ برای تأیید بنویسید «بله».`;
  if (language === "sv") return feeApplies
    ? `Vill du verkligen avboka tiden ${dateText} kl ${timeText}? En sen avbokningsavgift på ${fee} gäller enligt verksamhetens policy. Svara “ja” för att bekräfta.`
    : `Vill du verkligen avboka tiden ${dateText} kl ${timeText}? Svara “ja” för att bekräfta.`;
  return feeApplies
    ? `Do you want to cancel the appointment on ${dateText} at ${timeText}? A late-cancellation fee of ${fee} applies under the business policy. Reply “yes” to confirm.`
    : `Do you want to cancel the appointment on ${dateText} at ${timeText}? Reply “yes” to confirm.`;
}

function formatCancellationSuccess(language: string, feeApplies: boolean, feeAmount: number, currency: string): string {
  const fee = `${feeAmount.toLocaleString("sv-SE")} ${currency}`;
  if (language === "fa") return feeApplies ? `رزرو شما لغو شد. طبق قوانین مجموعه، هزینه لغو دیرهنگام ${fee} ممکن است اعمال شود.` : "رزرو شما با موفقیت لغو شد. ✅";
  if (language === "sv") return feeApplies ? `Din bokning är avbokad. En sen avbokningsavgift på ${fee} kan debiteras enligt verksamhetens policy.` : "Din bokning är nu avbokad. ✅";
  return feeApplies ? `Your appointment is cancelled. A late-cancellation fee of ${fee} may be charged under the business policy.` : "Your appointment has been cancelled. ✅";
}

function isAppointmentNameQuestion(text?: string): boolean {
  return /\b(på vilket namn|vilket namn|vem står bokningen på|under what name|what name|به نام چه کسی|به چه نامی)\b/i.test(String(text || ""));
}

function isRescheduleIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;

  // Do not use JavaScript \b around Swedish words such as "ändra".
  // In JavaScript, \b is ASCII-based, so a word beginning with "ä" can fail to match.
  // That caused Messenger messages like "Jag ska ändra min tid" to fall through into
  // the new-booking flow and incorrectly ask for name/mobile again.
  const normalized = raw
    .normalize("NFKC")
    .replace(/[.,!?;:()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const swedishOrEnglish =
    isDirectReschedulePhrase(normalized) ||
    /(?:^|\s)(?:ändra(?:\s+(?:min\s+tid|tiden|tid|bokningen))?|flytta(?:\s+(?:min\s+tid|tiden|tid|bokningen|den))?|boka\s+om|omboka|reschedule|change\s+my\s+appointment|change\s+the\s+time|move\s+(?:my\s+appointment|it|the\s+appointment))(?=\s|$)/i.test(normalized) ||
    /(?:^|\s)(?:(?:can|could)\s+(?:i\s+)?(?:change|move|reschedule)|can\s+my\s+(?:appointment|booking)\s+be\s+(?:changed|moved|rescheduled)|could\s+my\s+(?:appointment|booking)\s+be\s+(?:changed|moved|rescheduled)|kan\s+(?:jag\s+)?(?:ändra|flytta|boka\s+om)|kan\s+min\s+(?:tid|bokning)\s+(?:ändras|flyttas|bokas\s+om))(?=\s|$)/i.test(normalized) ||
    /(?:^|\s)(?:kan\s+(?:tyvärr\s+)?inte\s+komma|kommer\s+inte\s+kunna\s+komma|cannot\s+come|can't\s+come|can\s+not\s+come)(?=\s|$)/i.test(normalized);

  const transliteratedPersian =
    /(?:^|\s)(?:avaz(?:\s+(?:konam|kardam|bedam|beshe))?|taghir(?:\s+(?:bedam|konam))?|vaghtam\s+avaz|vaght\s+ro\s+avaz|hamon\s+vaght(?:e|i)?\s+ghabli)(?=\s|$)/i.test(normalized);

  const persianScript = /(?:تغییر[^\n]{0,30}وقت|عوض[^\n]{0,30}وقت|وقت[^\n]{0,30}(?:تغییر|عوض))/.test(raw);

  const german =
    /\b(?:termin|buchung).*(?:andern|ändern|verschieben|umbuchen)\b|\b(?:andern|ändern|verschieben|umbuchen).*(?:termin|buchung)\b/iu.test(normalized);
  const spanish =
    /\b(?:cita|reserva|reservaci[oó]n).*(?:cambiar|mover|reprogramar)\b|\b(?:cambiar|mover|reprogramar).*(?:cita|reserva|reservaci[oó]n)\b/iu.test(normalized);
  const arabic =
    /(?:تغيير|تعديل|نقل).{0,30}(?:موعد|حجز)|(?:موعد|حجز).{0,30}(?:تغيير|تعديل|نقل)/u.test(raw);

  return swedishOrEnglish || transliteratedPersian || persianScript || german || spanish || arabic;
}

function isGenericBookingRequestWithoutDate(text?: string): boolean {
  const raw = String(text || "").trim();
  if (!raw || resolveExplicitBookingDate(raw)) return false;
  if (isExistingAppointmentLookupIntent(raw) || isRescheduleIntent(raw)) return false;

  const hasBookingIntent = /\b(boka|bokning|tid|appointment|book|booking|vaght|وقت|رزرو|möte|meeting)\b/i.test(raw);
  const hasService = inferServiceFromText(raw) !== "Bokning";
  return hasBookingIntent && hasService;
}

function formatAppointmentNameReply(appointment: any, language: string): string {
  const name = String(appointment?.customerName || "").trim();
  if (!name) {
    if (language === "fa") return "نام ثبت‌شده در این رزرو در دسترس نیست، اما زمان رزرو را تأیید کرده‌ام. 📅";
    if (language === "sv") return "Jag kan bekräfta tiden, men namnet saknas i bokningsuppgifterna. 📅";
    return "I can confirm the appointment time, but the booked name is missing from the record. 📅";
  }
  if (language === "fa") return `این رزرو به نام ${name} ثبت شده است. 📅`;
  if (language === "sv") return `Bokningen är registrerad i namnet ${name}. 📅`;
  return `The booking is registered under the name ${name}. 📅`;
}

function formatRescheduleSuccess(language: string, dateTime: string): string {
  const { dateText, timeText } = formatLocalizedDateTime(dateTime, language);
  if (language === "fa") return `وقت شما با موفقیت به ${dateText} ساعت ${timeText} تغییر کرد. 😊`;
  if (language === "sv") return `Din bokning är nu ombokad till ${dateText} kl ${timeText}. 😊`;
  if (language === "de") return `Ihr Termin wurde auf ${dateText} um ${timeText} Uhr verschoben. 😊`;
  if (language === "es") return `Tu cita se ha cambiado al ${dateText} a las ${timeText}. 😊`;
  if (language === "ar") return `تم نقل موعدك إلى ${dateText} الساعة ${timeText}. 😊`;
  return `Your appointment has been rescheduled to ${dateText} at ${timeText}. 😊`;
}

function formatRescheduleConfirmation(language: string, dateTime: string): string {
  const { dateText, timeText } = formatLocalizedDateTime(dateTime, language);
  if (language === "fa") return `${dateText} ساعت ${timeText} خالیه. وقتتون رو به همون زمان منتقل کنم؟`;
  if (language === "sv") return `${dateText} kl. ${timeText} är ledigt. Ska jag flytta din bokning dit?`;
  if (language === "de") return `${dateText} um ${timeText} Uhr ist frei. Soll ich Ihren Termin dorthin verschieben?`;
  if (language === "es") return `${dateText} a las ${timeText} está libre. ¿Cambio tu cita a esa hora?`;
  if (language === "ar") return `${dateText} الساعة ${timeText} متاح. هل أنقل موعدك إلى هذا الوقت؟`;
  return `${dateText} at ${timeText} is available. Shall I move your appointment there?`;
}

function formatRescheduleFailure(language: string): string {
  if (language === "fa") return "متأسفم، نتونستم تغییر وقت رو با اطمینان ثبت کنم. زمان انتخابی‌تون محفوظ مونده؛ لطفاً کمی بعد دوباره تأیید کنید. 🙏";
  if (language === "sv") return "Tyvärr kunde jag inte verifiera ombokningen. Din valda tid finns kvar här — bekräfta gärna igen om en liten stund. 🙏";
  if (language === "de") return "Leider konnte ich die Terminänderung nicht sicher bestätigen. Ihre gewählte Zeit bleibt gespeichert; bestätigen Sie bitte in Kürze erneut.";
  if (language === "es") return "Lo siento, no pude verificar el cambio. Conservaré la hora elegida; vuelve a confirmarla en un momento.";
  if (language === "ar") return "عذرًا، لم أتمكن من التحقق من تغيير الموعد. سأحتفظ بالوقت المختار؛ يرجى التأكيد مرة أخرى بعد قليل.";
  return "Sorry, I couldn’t verify the change safely. I’ve kept your selected time here; please confirm again in a moment. 🙏";
}

function formatRescheduleTimeRejected(language: string, rejectedTime?: string | null): string {
  const time = rejectedTime ? ` ${rejectedTime}` : "";
  if (language === "fa") return rejectedTime
    ? `باشه، ساعت${time} رو کنار گذاشتم. چه ساعتی براتون بهتره؟`
    : "باشه، زمان قبلی رو کنار گذاشتم. چه ساعتی براتون بهتره؟";
  if (language === "sv") return rejectedTime
    ? `Okej, jag tar bort kl.${time}. Vilken tid passar bättre?`
    : "Okej, jag tar bort den tiden. Vilken tid passar bättre?";
  if (language === "de") return rejectedTime
    ? `Okay, ${time.trim()} Uhr ist entfernt. Welche Uhrzeit passt besser?`
    : "Okay, ich habe diese Zeit entfernt. Welche Uhrzeit passt besser?";
  if (language === "es") return rejectedTime
    ? `De acuerdo, descarto las${time}. ¿Qué hora te va mejor?`
    : "De acuerdo, descarto esa hora. ¿Qué hora te va mejor?";
  if (language === "ar") return rejectedTime
    ? `حسنًا، استبعدت الساعة${time}. ما الوقت الأنسب لك؟`
    : "حسنًا، استبعدت ذلك الوقت. ما الوقت الأنسب لك؟";
  return rejectedTime
    ? `Okay, I’ve removed${time}. What time works better?`
    : "Okay, I’ve removed that time. What time works better?";
}

function formatChooseRescheduleTime(language: string): string {
  if (language === "fa") return "لطفاً اول یکی از زمان‌های پیشنهادی را انتخاب کنید.";
  if (language === "sv") return "Välj först en av de föreslagna tiderna.";
  if (language === "de") return "Bitte wählen Sie zuerst eine der vorgeschlagenen Zeiten.";
  if (language === "es") return "Elige primero una de las horas propuestas.";
  if (language === "ar") return "يرجى اختيار أحد الأوقات المقترحة أولاً.";
  return "Please choose one of the offered times first.";
}

function formatAskRescheduleTarget(language: string): string {
  if (language === "fa") return "حتماً 😊 چه روز و ساعتی براتون بهتره؟";
  if (language === "sv") return "Absolut 😊 Vilken dag och tid passar bättre?";
  if (language === "de") return "Gern 😊 Welcher Tag und welche Uhrzeit passen besser?";
  if (language === "es") return "Claro 😊 ¿Qué día y hora te van mejor?";
  if (language === "ar") return "بالتأكيد 😊 ما اليوم والوقت الأنسب لك؟";
  return "Of course 😊 What day and time works better?";
}

function formatAskRescheduleDayForTime(language: string, time: string): string {
  if (language === "fa") return `حتماً 😊 چه روزی برای ساعت ${time} مناسبه؟`;
  if (language === "sv") return `Absolut 😊 Vilken dag passar för kl. ${time}?`;
  if (language === "de") return `Gern 😊 Welcher Tag passt für ${time} Uhr?`;
  if (language === "es") return `Claro 😊 ¿Qué día te va bien a las ${time}?`;
  if (language === "ar") return `بالتأكيد 😊 ما اليوم المناسب للساعة ${time}؟`;
  return `Of course 😊 What day works for ${time}?`;
}

function formatAskRescheduleTimeForDate(language: string): string {
  if (language === "fa") return "شماره‌تون ثبت شد 😊 چه ساعتی در همان روز براتون بهتره؟";
  if (language === "sv") return "Numret är sparat 😊 Vilken tid den dagen passar bäst?";
  if (language === "de") return "Die Nummer ist gespeichert 😊 Welche Uhrzeit passt an diesem Tag am besten?";
  if (language === "es") return "He guardado el número 😊 ¿Qué hora te va mejor ese día?";
  if (language === "ar") return "تم حفظ الرقم 😊 ما الوقت الأنسب لك في ذلك اليوم؟";
  return "Your number is saved 😊 What time that day works best?";
}

function formatVerifiedPhoneNoAppointment(language: string, lookupMode: AppointmentLookupMode): string {
  const rangeLabel = lookupMode === "today" ? "today" : lookupMode === "history" ? "recently" : "in the requested range";
  if (language === "fa") return "شماره تأیید شد، اما در بازه بررسی‌شده رزروی پیدا نکردم. می‌خواهید برایتان وقت جدیدی رزرو کنم؟";
  if (language === "sv") return "Numret är verifierat, men jag hittar ingen bokning i den kontrollerade perioden. Vill du boka en ny tid?";
  if (language === "de") return "Die Nummer ist bestätigt, aber im geprüften Zeitraum wurde kein Termin gefunden. Möchten Sie einen neuen Termin buchen?";
  if (language === "es") return "El número está verificado, pero no encontré ninguna cita en el período consultado. ¿Quieres reservar una nueva?";
  if (language === "ar") return "تم التحقق من الرقم، لكنني لم أجد موعدًا في الفترة التي تم فحصها. هل تريد حجز موعد جديد؟";
  return `The number is verified, but I found no appointment ${rangeLabel}. Would you like to book a new one?`;
}

function formatUnverifiedPhoneLookupReply(language: string): string {
  if (language === "fa") return "شماره را دریافت کردم، اما نتوانستم آن را به‌طور امن به این گفتگو مرتبط کنم. می‌خواهید برایتان وقت جدیدی رزرو کنم؟";
  if (language === "sv") return "Jag har fått numret, men kunde inte koppla det säkert till den här konversationen. Vill du boka en ny tid?";
  if (language === "de") return "Ich habe die Nummer erhalten, konnte sie aber nicht sicher diesem Gespräch zuordnen. Möchten Sie einen neuen Termin buchen?";
  if (language === "es") return "He recibido el número, pero no pude vincularlo de forma segura a esta conversación. ¿Quieres reservar una nueva cita?";
  if (language === "ar") return "استلمت الرقم، لكن تعذر ربطه بهذه المحادثة بشكل آمن. هل تريد حجز موعد جديد؟";
  return "I received the number, but couldn’t securely link it to this conversation. Would you like to book a new appointment?";
}

function formatSecureRecoveryPrompt(
  language: string,
  mode: "missing_identifier" | "need_attribute" | "ambiguous" | "not_found"
): string {
  const replies: Record<string, Record<typeof mode, string>> = {
    fa: {
      missing_identifier: "روز و ساعت را نگه داشتم 😊 لطفاً نام یا شماره‌ای را بفرستید که رزرو با آن ثبت شده است.",
      need_attribute: "شماره را گرفتم. برای تأیید امن رزرو، لطفاً نام ثبت‌شده یا تاریخ و ساعت تقریبی وقت را هم بفرستید.",
      ambiguous: "بیش از یک رزرو مطابق این اطلاعات پیدا شد. لطفاً تاریخ و ساعت دقیق‌تر را بفرستید؛ نیازی به تکرار شماره نیست.",
      not_found: "با این اطلاعات نتوانستم رزرو را با اطمینان تأیید کنم. می‌توانید یک مشخصه دیگر بفرستید یا برای وقت جدید کمک بگیرید."
    },
    sv: {
      missing_identifier: "Jag har sparat dagen och tiden 😊 Skicka namnet eller numret som bokningen gjordes med.",
      need_attribute: "Jag har fått numret. För en säker kontroll behöver jag också bokningsnamnet eller ungefärligt datum och klockslag.",
      ambiguous: "Flera bokningar stämmer med uppgifterna. Skicka ett mer exakt datum och klockslag; numret behöver inte skickas igen.",
      not_found: "Jag kunde inte verifiera bokningen säkert med uppgifterna. Skicka gärna en ytterligare uppgift, eller så hjälper jag dig boka en ny tid."
    },
    de: {
      missing_identifier: "Tag und Uhrzeit sind gespeichert 😊 Bitte senden Sie den Buchungsnamen oder die verwendete Telefonnummer.",
      need_attribute: "Die Nummer ist gespeichert. Für eine sichere Prüfung brauche ich zusätzlich den Buchungsnamen oder das ungefähre Datum und die Uhrzeit.",
      ambiguous: "Mehrere Termine passen zu den Angaben. Bitte nennen Sie Datum und Uhrzeit genauer; die Nummer müssen Sie nicht wiederholen.",
      not_found: "Mit diesen Angaben konnte ich den Termin nicht sicher bestätigen. Senden Sie bitte noch eine Angabe, oder ich helfe bei einer neuen Buchung."
    },
    es: {
      missing_identifier: "He guardado el día y la hora 😊 Envíame el nombre o el número usado para la reserva.",
      need_attribute: "He guardado el número. Para verificar la reserva de forma segura, necesito también el nombre o la fecha y hora aproximadas.",
      ambiguous: "Hay varias reservas que coinciden. Indica una fecha y hora más exactas; no hace falta repetir el número.",
      not_found: "No pude verificar la reserva de forma segura con esos datos. Puedes darme otro dato o puedo ayudarte con una reserva nueva."
    },
    ar: {
      missing_identifier: "احتفظت باليوم والوقت 😊 أرسل الاسم أو الرقم المستخدم في الحجز.",
      need_attribute: "تم حفظ الرقم. للتحقق الآمن أحتاج أيضًا اسم الحجز أو التاريخ والوقت التقريبيين.",
      ambiguous: "هناك أكثر من موعد يطابق المعلومات. أرسل تاريخًا ووقتًا أكثر دقة؛ لا حاجة لإرسال الرقم مجددًا.",
      not_found: "تعذر التحقق من الحجز بأمان بهذه المعلومات. يمكنك إرسال معلومة إضافية أو يمكنني مساعدتك في حجز جديد."
    },
    en: {
      missing_identifier: "I’ve saved the day and time 😊 Please send the booking name or the phone number used.",
      need_attribute: "I’ve saved the number. To verify the booking safely, I also need the booking name or approximate date and time.",
      ambiguous: "More than one appointment matches those details. Please give a more exact date and time; you do not need to repeat the number.",
      not_found: "I couldn’t verify the booking safely with those details. You can send one more detail, or I can help with a new booking."
    }
  };
  const lang = replies[language] ? language : "en";
  return replies[lang][mode];
}

function getLookupIdentificationDetails(
  text: string,
  existing?: AppointmentLookupContext | null
): {
  name?: string;
  phone?: string;
  requestedDate?: string;
  approximateTime?: string;
  requestedService?: string;
  hasNewDateOrTime: boolean;
} {
  const combined = extractNameAndPhone(text);
  const name = combined?.name || extractNameOnly(text) || existing?.receivedName;
  const phone = normalizeAcceptedPhone(
    combined?.phone || extractPhoneOnly(text) || existing?.receivedPhone
  ) || undefined;
  const parsedDate = resolveExplicitBookingDate(text);
  const parsedTime = inferRequestedTimeFromText(text);
  const inferredService = inferServiceFromText(text);
  const requestedService = inferredService !== "Bokning"
    ? inferredService
    : existing?.requestedService;
  return {
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(parsedDate || existing?.requestedDate
      ? { requestedDate: parsedDate || existing?.requestedDate }
      : {}),
    ...(parsedTime || existing?.approximateTime
      ? { approximateTime: parsedTime || existing?.approximateTime }
      : {}),
    ...(requestedService ? { requestedService } : {}),
    hasNewDateOrTime: Boolean(parsedDate || parsedTime)
  };
}

function isExistingBookingIdentificationStatement(text?: string): boolean {
  const raw = normalizeAppointmentSelectionText(text);
  if (!raw) return false;
  return (
    /\b(?:i have|i had|my booking is|my appointment is).*(?:booking|appointment).*(?:at|on|for)\b/u.test(raw) ||
    /\b(?:jag har|jag hade|min bokning|min tid).*(?:bokning|tid).*(?:kl|pa|for)\b/u.test(raw) ||
    /\b(?:ich habe|ich hatte|mein termin).*(?:termin|buchung).*(?:um|am)\b/u.test(raw) ||
    /\b(?:tengo|tenia|mi reserva|mi cita).*(?:reserva|reservacion|cita).*(?:a las|para|el)\b/u.test(raw) ||
    /(?:من.*(?:رزرو|وقت).*(?:ساعت|روز)|رزرو.*(?:برای|ساعت)|وقت.*(?:برای|ساعت))/u.test(String(text || "")) ||
    /\b(?:man.*(?:rezerv|vaght).*(?:saat|rooz)|rezerv.*(?:baraye|saat))\b/u.test(raw) ||
    /(?:لدي|عندي|كان لدي).*(?:حجز|موعد).*(?:الساعة|يوم)/u.test(String(text || ""))
  );
}

function normalizeConfirmationReply(text?: string): string {
  return normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064B-\u065F\u0670]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\u200c/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCompoundAffirmativeReply(text?: string): boolean {
  const raw = normalizeConfirmationReply(text);
  if (!raw || isThanksOnlyText(raw)) return false;

  // A polite word must never turn a negative or uncertain answer into confirmation.
  const negativeOrUncertain = [
    /\b(?:no|not|dont|do not|cannot|cant|maybe|perhaps|unsure)\b/u,
    /\b(?:nej|inte|kanske|osaker)\b/u,
    /\b(?:nein|nicht|vielleicht|unsicher)\b/u,
    /\b(?:no|quizas|tal vez|no se)\b/u,
    /(?:^|\s)(?:نه|خیر|نمیدانم|شاید|مطمئن نیستم)(?:\s|$)/u,
    /(?:^|\s)(?:لا|ليس|ربما|غير متاكد)(?:\s|$)/u,
    /\b(?:na|nemikham|nemitonam|shayad)\b/u
  ];
  if (negativeOrUncertain.some((pattern) => pattern.test(raw))) return false;

  const affirmativePrefixes = [
    "yes please",
    "yes",
    "sure",
    "correct",
    "confirm it",
    "confirm",
    "book that one",
    "move it",
    "that time",
    "ok",
    "okay",
    "ja tack",
    "ja garna",
    "ja bitte",
    "ja gerne",
    "ja",
    "gerne",
    "si por favor",
    "si claro",
    "si",
    "claro",
    "نعم من فضلك",
    "نعم",
    "اجل",
    "موافق",
    "بله لطفا",
    "بله",
    "اره",
    "باشه",
    "bale lotfan",
    "baleh lotfan",
    "bale",
    "baleh",
    "are",
    "bashe",
    "hamoon vaght",
    "hamon vaght",
    "همون وقت",
    "همان وقت"
  ].sort((a, b) => b.length - a.length);
  const politeSuffixes = new Set([
    "please",
    "thanks",
    "thank",
    "you",
    "thankyou",
    "tack",
    "garna",
    "snalla",
    "danke",
    "gerne",
    "bitte",
    "vielen",
    "gracias",
    "por",
    "favor",
    "شكرا",
    "شکرا",
    "جزيلا",
    "من",
    "فضلك",
    "مرسی",
    "ممنون",
    "لطفا",
    "متشکرم",
    "سپاس",
    "mersi",
    "merci",
    "mamnoon",
    "mamnun",
    "lotfan",
    "sepas"
  ]);

  for (const prefix of affirmativePrefixes) {
    if (raw !== prefix && !raw.startsWith(`${prefix} `)) continue;
    const suffix = raw.slice(prefix.length).trim();
    if (!suffix) return true;
    const suffixTokens = suffix.split(" ");
    if (suffixTokens.every((token) => politeSuffixes.has(token))) return true;
  }
  return false;
}

function isRescheduleConfirmation(text?: string): boolean {
  const raw = normalizeConfirmationReply(text);
  if (/^(?:bekrafta|تایید|لغو کن)$/u.test(raw)) return true;
  return isCompoundAffirmativeReply(raw);
}

function isLaterRescheduleRequest(text?: string): boolean {
  const raw = normalizeAppointmentSelectionText(text);
  return /^(?:later|a little later|later that day|senare|lite senare|همون روز دیرتر|دیرتر|بعدتر|ye kam dir tar|dir tar)$/iu.test(raw) ||
    /\b(?:same day but later|samma dag men senare|hamon rooz dir tar|hamoon rooz dir tar)\b/iu.test(raw);
}

function inferRequestedDaypart(text?: string): "morning" | "afternoon" | "evening" | null {
  const raw = String(text || "").trim().toLowerCase();
  if (/\b(morning|förmiddag|formiddag|vormittag|morgen|ma[nñ]ana|sobh)\b/i.test(raw) || /(?:صبح|الصباح)/u.test(raw)) return "morning";
  if (/\b(afternoon|eftermiddag|nachmittag|tarde|bad az zohr|badezohr)\b/i.test(raw) || /(?:بعد\s*از\s*ظهر|بعد\s*الظهر)/u.test(raw)) return "afternoon";
  if (/\b(evening|kväll|kvall|abend|noche|asr|shab)\b/i.test(raw) || /(?:عصر|شب|المساء)/u.test(raw)) return "evening";
  return null;
}

function getDaypartSlotOptions(daypart?: "morning" | "afternoon" | "evening" | null): SlotSearchOptions {
  if (daypart === "morning") return { minTime: "09:00", maxTime: "11:59" };
  if (daypart === "afternoon") return { minTime: "12:00", maxTime: "17:59" };
  if (daypart === "evening") return { minTime: "17:00", maxTime: "20:00" };
  return {};
}

function selectRescheduleOfferedSlot(text: string, offeredSlots: string[]): string | null {
  if (!Array.isArray(offeredSlots) || offeredSlots.length === 0) return null;
  const requestedTime = inferRequestedTimeFromText(text);
  if (requestedTime) return findOfferedSlotIso(offeredSlots, requestedTime);
  const raw = normalizeAppointmentSelectionText(text);
  if (
    /^(?:that one|same one|den|den tiden|det passar|همون|همون رو|همون رو می ?خوام|همان|همان را|اون|اون رو|hamon ro mikham|hamoon ro mikham)$/iu.test(raw) &&
    offeredSlots.length === 1
  ) return parseSlotIso(offeredSlots[0]);
  if (/\b(?:last one|the last one|sista|den sista|آخری|آخرین)\b/iu.test(raw)) {
    return parseSlotIso(offeredSlots[offeredSlots.length - 1]);
  }
  const numeric = raw.match(/^(?:number|nummer|شماره)?\s*([1-9])$/iu);
  if (numeric) return parseSlotIso(offeredSlots[Number(numeric[1]) - 1] || "");
  const ordinalMap: Array<[RegExp, number]> = [
    [/\b(?:first|första|forsta|اول|اولی)\b/iu, 0],
    [/\b(?:second|andra|دوم|دومی)\b/iu, 1],
    [/\b(?:third|tredje|سوم|سومی)\b/iu, 2],
    [/\b(?:fourth|fjärde|fjarde|چهارم|چهارمی)\b/iu, 3]
  ];
  for (const [pattern, index] of ordinalMap) {
    if (pattern.test(raw)) return parseSlotIso(offeredSlots[index] || "");
  }
  return null;
}

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
  if (isExplicitNewBookingRequest(raw)) return true;
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

function rememberCompletedBooking(
  chatId: string,
  language: string,
  name?: string,
  service?: string,
  durationMinutes?: number,
  dateTime?: string
) {
  recentlyCompletedBookings[chatId] = {
    completedAt: Date.now(),
    language,
    name,
    service,
    durationMinutes,
    dateTime
  };
  clearConversationFlowLanguage(chatId);
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

  // Customers often stretch letters or make small Finglish spelling mistakes,
  // for example: "moshaveeeereh", "moshavereh", or "mashavare".
  // Collapse repeated Latin letters before matching so every channel resolves
  // the same service instead of falling back to the free-form AI flow.
  const compactServiceCollapsed = compactService.replace(/([a-z])\1+/g, "$1");

  if (
    /\b(konsultation|consultation|consulting|consult|konsultasjon|konsultasion|konsiltation|konstitution|knstilution|konstlution|konstultion|konslutation|moshavere|moshavereh|mashavere|mashavereh|مشاوره)\b/i.test(raw) ||
    /^(?:kons|cons|konst|knst).*(?:ult|lult|lut).*(?:ation|tion|ion)?$/i.test(compactServiceCollapsed) ||
    /^m[ao]sh?a?v?e?r(?:e|eh|h)?$/i.test(compactServiceCollapsed)
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
  const raw = normalizeConfirmationReply(text);
  if (!raw) return false;
  // Important: pure thanks words (tack, tusen tack, merci, mersi, thanks) must NOT restart booking.
  if (isThanksOnlyText(raw)) return false;
  return isCompoundAffirmativeReply(raw) ||
    /^(?:japp|yep|okej|absolut|boka|boka den|gor det|حتما)$/u.test(raw);
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

function isServiceDurationQuestion(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    /\b(hur\s+lång\s+tid|hur\s+länge|hur\s+lång\s+är|hur\s+lång\s+tid\s+tar|hur\s+långt\s+tar).*(konsultation|behandling|besök|tid)?/i.test(raw) ||
    /\b(how\s+long|what(?:'s|\s+is)\s+the\s+duration|duration).*(consultation|appointment|treatment|service)?/i.test(raw) ||
    /\b(wie\s+lange|dauer).*(beratung|termin|behandlung)?/i.test(raw) ||
    /\b(cuánto\s+dura|cuanto\s+dura|duración|duracion).*(consulta|cita|tratamiento)?/i.test(raw) ||
    /(چقدر\s+طول\s+می(?:‌|\s*)کشد|چقدر\s+طول\s+میکشه|مدتش\s+چقدره|مدت\s+.*چقدر)/u.test(raw) ||
    /\b(cheghadr\s+tool\s+mikeshe|cheqadr\s+tool\s+mikeshe|modatesh\s+cheghadre)\b/i.test(raw) ||
    /(كم\s+تستغرق|ما\s+مدة|كم\s+مدة)/u.test(raw)
  );
}

function getActiveServiceInformationContext(sessionId: string, text: string) {
  const pending = pendingBookings[sessionId];
  const reschedule = rescheduleContexts[sessionId];
  const appointment = appointmentContexts[sessionId]?.appointment || reschedule?.appointment;
  const completed = getRecentCompletedBooking(sessionId);
  const inferred = normalizeBookingService(text, "");
  const service = String(
    appointment?.service ||
    pending?.service ||
    completed?.service ||
    (inferred !== "Bokning" ? inferred : "")
  ).trim();

  let durationMinutes: number | null = null;
  if (appointment?.start && appointment?.end) {
    const measured = Math.round(
      (new Date(String(appointment.end)).getTime() - new Date(String(appointment.start)).getTime()) / 60000
    );
    if (Number.isFinite(measured) && measured > 0 && measured <= 24 * 60) durationMinutes = measured;
  }
  if (!durationMinutes && Number(completed?.durationMinutes) > 0) {
    durationMinutes = Number(completed.durationMinutes);
  }
  if (!durationMinutes && Number(pending?.durationMinutes) > 0) {
    durationMinutes = Number(pending.durationMinutes);
  }

  return { service, durationMinutes };
}

function parseConfiguredDuration(value: unknown): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 24 * 60) return Math.round(numeric);
  const match = String(value || "").match(/\b(\d{1,3})\s*(?:min|minuter|minutes|دقیقه)\b/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return parsed > 0 && parsed <= 24 * 60 ? parsed : null;
}

async function resolveServiceDurationMinutes(
  service: string,
  knownDuration: number | null,
  businessConfig: any
): Promise<number | null> {
  if (knownDuration && knownDuration > 0) return knownDuration;

  const serviceKey = String(service || "").trim().toLowerCase();
  const configuredMaps = [
    businessConfig?.serviceDurations,
    businessConfig?.service_durations,
    businessConfig?.durations
  ];
  for (const map of configuredMaps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (serviceKey && String(key).toLowerCase().includes(serviceKey)) {
        const parsed = parseConfiguredDuration(value);
        if (parsed) return parsed;
      }
    }
  }

  const services = Array.isArray(businessConfig?.services) ? businessConfig.services : [];
  for (const item of services) {
    const name = String(item?.name || item?.service || item?.title || "").toLowerCase();
    if (!serviceKey || !name.includes(serviceKey)) continue;
    const parsed = parseConfiguredDuration(
      item?.durationMinutes ?? item?.duration_minutes ?? item?.duration
    );
    if (parsed) return parsed;
  }

  const defaultDuration = getDefaultBookingDurationForService(service);
  if (defaultDuration) return defaultDuration;

  try {
    const query = `${service || "service"} duration minutes`;
    const matches = await knowledgeService.search(query);
    const searchable = (matches || []).flatMap((match: any) => [
      match?.text,
      match?.metadata?.durationMinutes,
      match?.metadata?.duration_minutes,
      match?.metadata?.duration
    ]);
    for (const value of searchable) {
      const parsed = parseConfiguredDuration(value);
      if (parsed) return parsed;
    }
  } catch (error) {
    console.error("[ServiceInformation] Knowledge duration lookup failed:", error);
  }

  const prompt = String(businessConfig?.systemPrompt || businessConfig?.system_prompt || "");
  if (serviceKey && prompt) {
    const escaped = serviceKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nearby = prompt.match(new RegExp(`${escaped}.{0,120}?(\\d{1,3})\\s*(?:min|minuter|minutes|دقیقه)`, "i"));
    const parsed = parseConfiguredDuration(nearby?.[1]);
    if (parsed) return parsed;
  }

  return null;
}

function formatServiceDurationReply(language: string, service: string, durationMinutes: number | null): string {
  const localizedService = localizeServiceName(service || "", language);
  if (!durationMinutes) {
    if (language === "sv") return `Jag hittar ingen säker uppgift om längden för ${localizedService}. Jag vill inte gissa.`;
    if (language === "fa") return `اطلاعات مطمئنی درباره مدت ${localizedService} پیدا نکردم و نمی‌خوام حدس بزنم.`;
    if (language === "de") return `Ich finde keine verlässliche Angabe zur Dauer von ${localizedService} und möchte nicht raten.`;
    if (language === "es") return `No encuentro información fiable sobre la duración de ${localizedService} y prefiero no adivinar.`;
    if (language === "ar") return `لم أجد معلومة مؤكدة عن مدة ${localizedService}، ولا أريد التخمين.`;
    return `I can’t find a reliable duration for ${localizedService}, and I don’t want to guess.`;
  }

  if (language === "sv") return `${localizedService} tar cirka ${durationMinutes} minuter. 😊`;
  if (language === "fa") return `مدت ${localizedService} حدود ${durationMinutes} دقیقه است. 😊`;
  if (language === "de") return `${localizedService} dauert ungefähr ${durationMinutes} Minuten. 😊`;
  if (language === "es") return `${localizedService} dura unos ${durationMinutes} minutos. 😊`;
  if (language === "ar") return `مدة ${localizedService} حوالي ${durationMinutes} دقيقة. 😊`;
  return `${localizedService} takes about ${durationMinutes} minutes. 😊`;
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
  const raw = normalizeLocalizedDigits(String(text || "")).trim();
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
    /(?:med\s+namnet|under\s+namnet|bokad\s+i\s+namnet|namnet)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:with\s+the\s+name|under\s+the\s+name)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
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
  const raw = normalizeLocalizedDigits(String(text || "")).trim();
  if (!raw) return null;

  const match = raw.match(/(?:\+?\d[\d\s\-()]{6,}\d)/);
  if (!match) return null;

  const phone = match[0].replace(/[^\d+]/g, "");
  return phone.replace(/\D/g, "").length >= 7 ? phone : null;
}

function normalizeAcceptedPhone(phone?: string): string | null {
  const raw = String(phone || "").trim();
  const digits = normalizeLookupDigits(raw);
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function maskPhoneForDiagnostic(phone?: string): string {
  const digits = normalizeLookupDigits(phone);
  if (digits.length < 4) return "missing";
  return `***${digits.slice(-4)}`;
}

function extractNameOnly(text?: string): string | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const patterns: RegExp[] = [
    /(?:mitt\s+namn\s+är|jag\s+heter)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:my\s+name\s+is|name\s+is)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:med\s+namnet|under\s+namnet|bokad\s+i\s+namnet|namnet)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
    /(?:with\s+the\s+name|under\s+the\s+name)\s+([A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,}(?:\s+[A-Za-zÅÄÖåäöÉéÜüÖöÄä'-]{2,})?)/i,
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
  pending.businessId = String(
    pending.businessId ||
    getBusinessIdFromConfig(pending.businessConfig) ||
    ""
  );
  pending.platform = normalizePlatformName(platform);
  pending.userId = normalizePlatformUserId(
    pending.platform,
    String(pending.userId || chatId)
  );
  pending.sessionId = chatId;
  pendingBookings[chatId] = pending;
  if (!supabase) return;
  try {
    const minimal = {
      type: "pending_booking",
      platform,
      service: pending.service,
      dateTime: pending.dateTime || null,
      selectedSlotEnd: pending.selectedSlotEnd || null,
      selectedDate: pending.selectedDate || null,
      offeredSlots: Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
      ownedOfferedSlots: Array.isArray(pending.ownedOfferedSlots) ? pending.ownedOfferedSlots : [],
      availabilityStartDate: pending.availabilityStartDate || null,
      availabilityEndDate: pending.availabilityEndDate || null,
      availabilityMinTime: pending.availabilityMinTime || null,
      availabilityMaxTime: pending.availabilityMaxTime || null,
      availabilityConstraint: pending.availabilityConstraint || null,
      language: pending.language || null,
      customerName: pending.customerName || null,
      customerPhone: pending.customerPhone || null,
      durationMinutes: pending.durationMinutes,
      status: pending.status,
      operation: pending.operation || "new_booking",
      createdAt: pending.createdAt || Date.now(),
      business_id: pending.businessId,
      userId: pending.userId
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
      clearConversationFlowLanguage(chatId);
      return null;
    }
    const inMemory = pendingBookings[chatId];
    const expectedBusinessId = String(getBusinessIdFromConfig(businessConfig) || "");
    const expectedUserId = normalizePlatformUserId(platform, chatId);
    if (
      String(inMemory.businessId || getBusinessIdFromConfig(inMemory.businessConfig) || "") !== expectedBusinessId ||
      normalizePlatformName(inMemory.platform || platform) !== normalizePlatformName(platform) ||
      normalizePlatformUserId(platform, String(inMemory.userId || chatId)) !== expectedUserId
    ) {
      console.warn("[BookingFlow]", {
        platform: normalizePlatformName(platform),
        businessScopePresent: Boolean(expectedBusinessId),
        operation: "load_pending",
        stateType: inMemory.operation || "new_booking",
        ownershipMatch: false,
        staleStateReason: "owner_mismatch"
      });
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
      selectedSlotEnd: parsed.selectedSlotEnd || null,
      selectedDate: parsed.selectedDate || null,
      offeredSlots: Array.isArray(parsed.offeredSlots) ? parsed.offeredSlots : [],
      ownedOfferedSlots: Array.isArray(parsed.ownedOfferedSlots) ? parsed.ownedOfferedSlots : [],
      availabilityStartDate: parsed.availabilityStartDate || null,
      availabilityEndDate: parsed.availabilityEndDate || null,
      availabilityMinTime: parsed.availabilityMinTime || null,
      availabilityMaxTime: parsed.availabilityMaxTime || null,
      availabilityConstraint: parsed.availabilityConstraint || null,
      language: parsed.language || null,
      customerName: parsed.customerName || null,
      customerPhone: parsed.customerPhone || null,
      durationMinutes: Number(parsed.durationMinutes || 60),
      status: parsed.status || "awaiting_contact",
      operation: parsed.operation || "new_booking",
      businessId: String(parsed.business_id || getBusinessIdFromConfig(businessConfig) || ""),
      userId: normalizePlatformUserId(platform, String(parsed.userId || chatId)),
      sessionId: chatId,
      createdAt: Number(parsed.createdAt || parsed.created_at || 0)
    };
    const expectedBusinessId = String(getBusinessIdFromConfig(businessConfig) || "");
    const expectedUserId = normalizePlatformUserId(platform, chatId);
    if (
      !pending.businessId ||
      pending.businessId !== expectedBusinessId ||
      normalizePlatformName(pending.platform) !== normalizePlatformName(platform) ||
      pending.userId !== expectedUserId
    ) {
      console.warn("[BookingFlow]", {
        platform: normalizePlatformName(platform),
        businessScopePresent: Boolean(expectedBusinessId),
        operation: "load_pending",
        stateType: pending.operation,
        ownershipMatch: false,
        staleStateReason: "owner_mismatch"
      });
      await clearPendingBooking(chatId);
      return null;
    }
    if (!pending.dateTime && !pending.selectedDate && !pending.availabilityStartDate) return null;
    if (isPendingBookingExpired(pending)) {
      console.log(`[DeterministicBooking] Expired DB pending booking cleared. chatId=${chatId}, dateTime=${pending.dateTime}`);
      await clearPendingBooking(chatId);
      clearConversationFlowLanguage(chatId);
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

async function sendCustomerMessage(platform: string, recipientId: string, message: string, businessConfig: any): Promise<boolean> {
  const channel = normalizePlatformName(platform);
  const recipient = normalizePlatformUserId(channel, String(recipientId || ""));
  if (!recipient) {
    console.error(`[ChannelSend] skipped: missing recipient for platform=${channel}`);
    return false;
  }

  if (channel === "whatsapp") return await sendWhatsAppMessage(recipient, message, businessConfig);
  if (channel === "messenger") return await sendMessengerMessage(recipient, message, businessConfig);
  if (channel === "instagram") return await sendInstagramMessage(recipient, message, getBusinessInstagramToken(businessConfig));

  if (channel === "telegram") {
    const token = businessConfig?.telegramToken || activeConfig?.telegramToken || process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("[ChannelSend] Telegram skipped: missing token");
      return false;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: recipient, text: message })
      });
      if (!res.ok) console.error("[ChannelSend] Telegram failed:", await res.text());
      return res.ok;
    } catch (error) {
      console.error("[ChannelSend] Telegram crashed:", error);
      return false;
    }
  }

  console.error(`[ChannelSend] unsupported platform=${channel}`);
  return false;
}

function getAdminNotificationChannel(businessConfig: any): "telegram" | "whatsapp" | null {
  const configured = String(
    businessConfig?.admin_notification_channel ??
    businessConfig?.adminNotificationChannel ??
    "telegram"
  ).trim().toLowerCase();

  if (configured === "whatsapp" || configured === "telegram") return configured;
  return null;
}

function resolveAdminNotificationRoute(
  businessConfig: any,
  logContext: "BookingNotify" | "CancellationNotify" | "RescheduleNotify"
): { channel: "telegram" | "whatsapp"; recipient: string } | null {
  const channel = getAdminNotificationChannel(businessConfig);
  if (!channel) {
    console.error(`[${logContext}] skipped: invalid admin_notification_channel`);
    return null;
  }

  if (channel === "whatsapp") {
    const rawRecipient = String(
      businessConfig?.admin_whatsapp_number ??
      businessConfig?.adminWhatsAppNumber ??
      ""
    ).trim();
    const recipient = rawRecipient.replace(/[^\d]/g, "");
    const recipientExists = /^\d{8,15}$/.test(recipient);
    console.log(`[${logContext}] selectedChannel=whatsapp method=WhatsApp recipientConfigured=${recipientExists}`);
    if (!recipientExists) {
      console.error(`[${logContext}] WhatsApp skipped: missing or invalid admin_whatsapp_number; no fallback recipient was used`);
      return null;
    }
    return { channel, recipient };
  }

  const recipient = String(
    businessConfig?.admin_telegram_chat_id ??
    businessConfig?.adminTelegramChatId ??
    ""
  ).trim();
  const recipientExists = Boolean(recipient);
  console.log(`[${logContext}] selectedChannel=telegram method=Telegram recipientConfigured=${recipientExists}`);
  if (!recipientExists) {
    console.error(`[${logContext}] Telegram skipped: missing admin_telegram_chat_id`);
    return null;
  }
  return { channel, recipient };
}

async function notifyAdminAboutBooking(businessConfig: any, platformLabel: string, businessName: string, name: string, phone: string, dateTime: string) {
  const notifyText = `🔔 Ny ${platformLabel}-bokning mottagen!\n🏢 Business: ${businessName}\n👤 Namn: ${name}\n📞 Mobil: ${phone}\n📅 Tid: ${dateTime}`;
  const route = resolveAdminNotificationRoute(businessConfig, "BookingNotify");
  if (!route) return false;
  const sent = await sendCustomerMessage(route.channel, route.recipient, notifyText, businessConfig);
  if (!sent) console.error(`[BookingNotify] ${route.channel} admin notification failed`);
  return sent;
}


async function notifyAdminAboutReschedule(
  businessConfig: any,
  platformLabel: string,
  businessName: string,
  name: string,
  phone: string,
  oldDateTime: string,
  newDateTime: string,
  service?: string
) {
  const businessTimeZone = String(businessConfig?.timezone || activeConfig?.timezone || "Europe/Stockholm").trim() || "Europe/Stockholm";
  const formatAdminDateTime = (dateTime: string) => {
    if (!dateTime) return "Saknas";
    const { dateText, timeText } = formatLocalizedDateTime(dateTime, "sv", businessTimeZone);
    return `${dateText} kl ${timeText}`;
  };
  const notifyText = `🔄 Ombokning

📱 Via: ${platformLabel}
🏢 ${businessName || "Okänd verksamhet"}
👤 ${name || "Okänd kund"}
📞 ${phone || "Saknas"}
📅 Från: ${formatAdminDateTime(oldDateTime)}
➡️ Till: ${formatAdminDateTime(newDateTime)}
🔔 ${service || "Bokning"}`;
  const route = resolveAdminNotificationRoute(businessConfig, "RescheduleNotify");
  if (!route) return false;
  const sent = await sendCustomerMessage(route.channel, route.recipient, notifyText, businessConfig);
  if (!sent) console.error(`[RescheduleNotify] ${route.channel} admin notification failed`);
  return sent;
}

async function notifyAdminAboutCancellation(
  businessConfig: any,
  platformLabel: string,
  appointment: any,
  reason: string
) {
  const customerName = String(appointment?.customerName || "Okänd kund").trim();
  const phone = String(appointment?.phone || "Saknas").trim();
  const service = String(appointment?.service || "Bokning").trim();
  const { dateText, timeText } = formatLocalizedDateTime(String(appointment?.start || ""), "sv");
  const shortReason = normalizeCancellationReason(reason);
  const channelName = platformLabel.toLowerCase() === "whatsapp"
    ? "WhatsApp"
    : platformLabel.charAt(0).toUpperCase() + platformLabel.slice(1).toLowerCase();
  const notifyText = `❌ Avbokning\n\n📱 Via: ${channelName}\n👤 ${customerName}\n📞 ${phone}\n📅 ${dateText} kl ${timeText}\n🔔 ${service}\n📝 ${shortReason}`;
  const route = resolveAdminNotificationRoute(businessConfig, "CancellationNotify");
  if (!route) return false;
  const sent = await sendCustomerMessage(route.channel, route.recipient, notifyText, businessConfig);
  if (!sent) console.error(`[CancellationNotify] ${route.channel} admin notification failed`);
  return sent;
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
  const raw = normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .replace(/\u200c/g, " ")
    .replace(/[،,!?؟;؛()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return null;

  const today = stockholmDateString(new Date());

  const iso = raw.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // A written calendar date is authoritative even when the same message also
  // contains a weekday, for example "onsdag 22 juli" or "22 juli, inte nästa onsdag".
  const namedDate = raw.match(/\b(?:den\s+)?(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)(?:\s+(20\d{2}))?\b/i);
  if (namedDate) {
    const monthNames = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
    const year = Number(namedDate[3] || today.slice(0, 4));
    const month = monthNames.indexOf(namedDate[2].toLowerCase()) + 1;
    const day = Number(namedDate[1]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return null;
  }

  const numeric = raw.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](20\d{2}))?\b/);
  if (numeric) {
    const year = Number(numeric[3] || new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Stockholm",
      year: "numeric"
    }).format(new Date()));
    return `${year}-${String(Number(numeric[2])).padStart(2, "0")}-${String(Number(numeric[1])).padStart(2, "0")}`;
  }

  // Relative dates must still be resolved before weekday parsing. This is critical for
  // rescheduling messages such as "imorgon kl 18:30" and "farda saate 18:30".
  if (/\b(idag|today|heute|hoy|emruz|emrooz)\b/i.test(raw) || /(?:امروز|اليوم)/u.test(raw)) return today;
  if (
    /\b(igår|igar|yesterday|gestern|ayer|dirooz|diruz)\b/i.test(raw) ||
    /(?:دیروز|أمس|امس)/u.test(raw)
  ) {
    return addDaysToStockholmDate(today, -1);
  }
  // Check day-after-tomorrow BEFORE tomorrow. Otherwise "pas farda" also matches "farda".
  if (/\b(i\s*övermorgon|övermorgon|day after tomorrow|pas\s*farda|pasfarda|پس\s*فردا|پسفردا)\b/i.test(raw)) {
    return addDaysToStockholmDate(today, 2);
  }
  if (/\b(i\s*morgon|imorgon|tomorrow|farda|فردا)\b/i.test(raw)) {
    return addDaysToStockholmDate(today, 1);
  }

  // Persian weekday numbers are weekday names, not calendar day numbers. Match all
  // compound forms before bare "shanbe" so "3 shanbe" can never degrade to Saturday.
  const weekdayMap: Array<[RegExp, number]> = [
    [/(?:^|\s)(?:söndag|sunday|sonntag|domingo|الأحد|الاحد|yek\s*shanbe|yekshanbe|1\s*shanbe|یک\s*شنبه)(?=\s|$)/iu, 0],
    [/(?:^|\s)(?:måndag|mandag|monday|montag|lunes|الاثنين|الإثنين|do\s*shanbe|doshanbe|2\s*shanbe|دو\s*شنبه)(?=\s|$)/iu, 1],
    [/(?:^|\s)(?:tisdag|tuesday|dienstag|martes|الثلاثاء|se\s*shanbe|seshanbe|3\s*shanbe|سه\s*شنبه)(?=\s|$)/iu, 2],
    [/(?:^|\s)(?:onsdag|wednesday|mittwoch|miércoles|miercoles|الأربعاء|الاربعاء|chahar\s*shanbe|chaharshanbe|4\s*shanbe|چهار\s*شنبه|چهارشنبه)(?=\s|$)/iu, 3],
    [/(?:^|\s)(?:torsdag|thursday|donnerstag|jueves|الخميس|panj\s*shanbe|panjshanbe|5\s*shanbe|پنج\s*شنبه|پنجشنبه)(?=\s|$)/iu, 4],
    [/(?:^|\s)(?:fredag|friday|freitag|viernes|الجمعة|jome|jomeh|جمعه)(?=\s|$)/iu, 5],
    [/(?:^|\s)(?:lördag|lordag|saturday|samstag|sábado|sabado|السبت|shanbe|شنبه)(?=\s|$)/iu, 6]
  ];

  const matched = weekdayMap.find(([pattern]) => pattern.test(raw));
  if (!matched) return null;

  const targetDay = matched[1];
  const todayStr = stockholmDateString(new Date());
  const [year, month, day] = todayStr.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(year, month - 1, day));
  const currentDay = todayUtc.getUTCDay();

  let daysAhead = (targetDay - currentDay + 7) % 7;
  const explicitlyThisWeek = /\bthis\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(raw) ||
    /(?:همین|این)\s*(?:شنبه|یک\s*شنبه|دو\s*شنبه|سه\s*شنبه|چهار\s*شنبه|پنج\s*شنبه|جمعه)/u.test(raw);
  if (daysAhead === 0 && !explicitlyThisWeek && !/\b(idag|today|امروز)\b/i.test(raw)) daysAhead = 7;

  // "next week / hafte ayande" is an explicit week qualifier. A plain "next Tuesday"
  // remains the next upcoming Tuesday, while "Tuesday next week" moves into next week.
  const explicitlyNextWeek = /\bnext\s+week\b|\bhafte\s+ayande\b|هفته\s+آینده/u.test(raw);
  if (explicitlyNextWeek && daysAhead < 7) daysAhead += 7;

  todayUtc.setUTCDate(todayUtc.getUTCDate() + daysAhead);
  return todayUtc.toISOString().slice(0, 10);
}

type AvailabilityRangeRequest = {
  startDate: string;
  endDate: string;
  minTime?: string;
  maxTime?: string;
  flexibleDays: boolean;
};

function getConfiguredBookingWindowDays(config: any): number {
  const value = Number(
    config?.bookingWindowDays ??
    config?.booking_window_days ??
    config?.advanceBookingDays ??
    config?.advance_booking_days ??
    30
  );
  return Number.isFinite(value) ? Math.max(1, Math.min(365, Math.round(value))) : 30;
}

function extractRequestedWeekdays(text?: string): Array<{ index: number; position: number }> {
  const raw = normalizeLocalizedDigits(String(text || ""))
    .toLowerCase()
    .replace(/\u200c/g, " ");
  const definitions: Array<[number, RegExp]> = [
    [0, /\b(?:söndag|sondag|sunday|sonntag|domingo|yek\s*shanbe|yekshanbe|1\s*shanbe)\b|یک\s*شنبه|الأحد|الاحد/giu],
    [1, /\b(?:måndag|mandag|monday|montag|lunes|do\s*shanbe|doshanbe|2\s*shanbe)\b|دو\s*شنبه|الاثنين|الإثنين/giu],
    [2, /\b(?:tisdag|tuesday|dienstag|martes|se\s*shanbe|seshanbe|3\s*shanbe)\b|سه\s*شنبه|الثلاثاء/giu],
    [3, /\b(?:onsdag|wednesday|mittwoch|miércoles|miercoles|chahar\s*shanbe|chaharshanbe|4\s*shanbe)\b|چهار\s*شنبه|چهارشنبه|الأربعاء|الاربعاء/giu],
    [4, /\b(?:torsdag|thursday|donnerstag|jueves|panj\s*shanbe|panjshanbe|5\s*shanbe)\b|پنج\s*شنبه|پنجشنبه|الخميس/giu],
    [5, /\b(?:fredag|friday|freitag|viernes|jome|jomeh)\b|جمعه|الجمعة/giu],
    [6, /\b(?:lördag|lordag|saturday|samstag|sábado|sabado|(?<!yek\s)(?<!do\s)(?<!se\s)(?<!chahar\s)(?<!panj\s)(?<![1-5]\s)shanbe)\b|(?<!یک\s)(?<!دو\s)(?<!سه\s)(?<!چهار\s)(?<!پنج\s)شنبه|السبت/giu]
  ];
  const matches: Array<{ index: number; position: number }> = [];
  for (const [index, pattern] of definitions) {
    for (const match of raw.matchAll(pattern)) {
      const position = Number(match.index || 0);
      if (!matches.some((item) => item.position === position)) matches.push({ index, position });
    }
  }
  return matches.sort((a, b) => a.position - b.position);
}

function nextStockholmWeekdayDate(weekday: number, fromDate: string): string {
  const [year, month, day] = fromDate.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, day));
  let daysAhead = (weekday - from.getUTCDay() + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  from.setUTCDate(from.getUTCDate() + daysAhead);
  return from.toISOString().slice(0, 10);
}

function normalizeWindowClock(hoursText: string, minutesText?: string): string | null {
  const hours = Number(hoursText);
  const minutes = Number(minutesText || 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function extractAvailabilityTimeWindow(text?: string): {
  minTime: string;
  maxTime: string;
} | null {
  const raw = normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .replace(/\u200c/g, " ")
    .replace(/[–—]/g, "-");
  const timeRangePattern =
    /(?:mellan|between|from|från|fran|zwischen|von|entre|desde|بين|من|بین|از)?\s*(\d{1,2})(?::([0-5]\d))?\s*(?:-|till|to|and|och|å|bis|und|hasta|y|إلى|الى|و|تا)\s*(\d{1,2})(?::([0-5]\d))?(?:\s*(?:kl|klockan|uhr|ساعت|الساعة))?/giu;
  let selected: { minTime: string; maxTime: string } | null = null;
  for (const candidate of raw.matchAll(timeRangePattern)) {
    const minTime = normalizeWindowClock(candidate[1], candidate[2]);
    const maxTime = normalizeWindowClock(candidate[3], candidate[4]);
    if (
      minTime &&
      maxTime &&
      Number(timeTextToMinutes(maxTime)) > Number(timeTextToMinutes(minTime))
    ) {
      selected = { minTime, maxTime };
    }
  }
  return selected;
}

function parseAvailabilityRangeRequest(text: string, businessConfig: any): AvailabilityRangeRequest | null {
  const raw = normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .replace(/\u200c/g, " ")
    .replace(/[–—]/g, "-");
  if (!raw) return null;

  const timeWindow = extractAvailabilityTimeWindow(raw);
  const minTime = timeWindow?.minTime || null;
  const maxTime = timeWindow?.maxTime || null;
  const hasValidWindow = Boolean(timeWindow);

  const flexibleDays = /\b(det\s+spelar\s+ingen\s+roll\s+vilken\s+dag|vilken\s+dag\s+som\s+helst|any\s+day|doesn'?t\s+matter\s+which\s+day|jeder\s+tag|welcher\s+tag\s+ist\s+egal|cualquier\s+d[ií]a|no\s+importa\s+qu[eé]\s+d[ií]a|farghi\s+nadare\s+che\s+roozi)\b/i.test(raw) ||
    /هر\s*روز|فرقی\s*نداره\s*چه\s*روزی|أي\s*يوم|لا\s*يهم\s*أي\s*يوم/u.test(raw);
  const weekdays = extractRequestedWeekdays(raw);
  const hasRangeConnector = /\b(till|through|until|to|och|and)\b|(?:^|\s)å(?:\s|$)|تا|و/u.test(raw);

  let explicitStartDate: string | null = null;
  let explicitEndDate: string | null = null;
  const isValidDate = (value: string) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const isoRange = raw.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:till|to|through|–|-)\s*(20\d{2}-\d{2}-\d{2})\b/i);
  if (isoRange && isValidDate(isoRange[1]) && isValidDate(isoRange[2]) && isoRange[1] <= isoRange[2]) {
    explicitStartDate = isoRange[1];
    explicitEndDate = isoRange[2];
  }
  if (!explicitStartDate) {
    const numericRange = raw.match(/\b(\d{1,2})[/.](\d{1,2})\s*(?:till|to|through|–|-)\s*(\d{1,2})[/.](\d{1,2})(?:[/.](20\d{2}))?\b/i);
    if (numericRange) {
      const year = Number(numericRange[5] || stockholmDateString(new Date()).slice(0, 4));
      const start = `${year}-${String(Number(numericRange[2])).padStart(2, "0")}-${String(Number(numericRange[1])).padStart(2, "0")}`;
      const end = `${year}-${String(Number(numericRange[4])).padStart(2, "0")}-${String(Number(numericRange[3])).padStart(2, "0")}`;
      if (isValidDate(start) && isValidDate(end) && start <= end) {
        explicitStartDate = start;
        explicitEndDate = end;
      }
    }
  }

  if (!flexibleDays && !explicitStartDate && weekdays.length === 0) return null;
  if (!hasValidWindow && !weekdays.length && !explicitStartDate) return null;

  const today = stockholmDateString(new Date());
  if (flexibleDays) {
    return {
      startDate: today,
      endDate: addDaysToStockholmDate(today, getConfiguredBookingWindowDays(businessConfig)),
      ...(hasValidWindow ? { minTime: minTime!, maxTime: maxTime! } : {}),
      flexibleDays: true
    };
  }

  if (explicitStartDate && explicitEndDate) {
    return {
      startDate: explicitStartDate,
      endDate: explicitEndDate,
      ...(hasValidWindow ? { minTime: minTime!, maxTime: maxTime! } : {}),
      flexibleDays: false
    };
  }

  const startDate = nextStockholmWeekdayDate(weekdays[0].index, today);
  let endDate = startDate;
  if (weekdays.length >= 2 && hasRangeConnector) {
    const [year, month, day] = startDate.split("-").map(Number);
    const startUtc = new Date(Date.UTC(year, month - 1, day));
    const daysToEnd = (weekdays[1].index - weekdays[0].index + 7) % 7;
    startUtc.setUTCDate(startUtc.getUTCDate() + (daysToEnd || 7));
    endDate = startUtc.toISOString().slice(0, 10);
  }

  return {
    startDate,
    endDate,
    ...(hasValidWindow ? { minTime: minTime!, maxTime: maxTime! } : {}),
    flexibleDays: false
  };
}

function isWholeDayAvailabilityRequest(text?: string): boolean {
  const raw = normalizeLocalizedDigits(String(text || ""))
    .trim()
    .toLowerCase()
    .replace(/\u200c/g, " ")
    .replace(/[،,!?؟;؛.]+/g, " ")
    .replace(/\s+/g, " ");
  if (!raw) return false;
  return (
    /\b(?:any\s+time|anytime|any\s+time\s+that\s+day|all\s+day|whole\s+day|only\s+(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|do\s+you\s+have\s+any\s+time)\b/i.test(raw) ||
    /\b(?:vilken\s+tid\s+som\s+helst|n[aå]gon\s+tid|hela\s+dagen|bara\s+(?:p[aå]\s+)?(?:m[aå]ndag|tisdag|onsdag|torsdag|fredag|l[oö]rdag|s[oö]ndag)|har\s+du\s+(?:inte\s+)?(?:n[aå]gon\s+)?tid)\b/i.test(raw) ||
    /\b(?:irgendeine\s+uhrzeit|jederzeit|den\s+ganzen\s+tag|nur\s+(?:am\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag))\b/i.test(raw) ||
    /\b(?:cualquier\s+hora|a\s+cualquier\s+hora|todo\s+el\s+d[ií]a|solo\s+(?:el\s+)?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\b/i.test(raw) ||
    /\b(?:har\s+saati|har\s+vaght|tamame?\s+rooz|faghat\s+(?:shanbe|yekshanbe|doshanbe|seshanbe|chaharshanbe|panjshanbe|jomeh?))\b/i.test(raw) ||
    /(?:هر\s*(?:ساعت|وقتی)|تمام\s*روز|فقط\s*(?:شنبه|یک\s*شنبه|دو\s*شنبه|سه\s*شنبه|چهار\s*شنبه|پنج\s*شنبه|جمعه)|أي\s*وقت|طوال\s*اليوم|فقط\s*(?:الأحد|الاحد|الاثنين|الإثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|السبت))/u.test(raw)
  );
}

function isAvailabilityPivotFromFailedLookup(text?: string): boolean {
  if (!resolveExplicitBookingDate(text)) return false;
  const raw = normalizeConfirmationReply(text);
  return (
    isWholeDayAvailabilityRequest(text) ||
    isNewBookingRequestText(text) ||
    /\b(?:what\s+about|how\s+about|do\s+you\s+have|available|ledig|ledigt|vad\s+s[aä]gs\s+om|wie\s+w[aä]re\s+es|hast\s+du\s+zeit|qu[eé]\s+tal|tienes\s+hora|chetor(?:e)?|vaght\s+dari)\b/iu.test(raw) ||
    /(?:وقت\s+داری|زمان\s+خالی|چه(?:طور|‌طور)\s+است|ماذا\s+عن|هل\s+لديك\s+وقت|موعد\s+متاح)/u.test(String(text || ""))
  );
}

function deriveCanonicalAvailabilityConstraint(
  text: string,
  businessConfig: any,
  previous?: CanonicalAvailabilityConstraint | null
): CanonicalAvailabilityConstraint | null {
  const range = parseAvailabilityRangeRequest(text, businessConfig);
  const explicitDate = resolveExplicitBookingDate(text);
  const timeWindow = extractAvailabilityTimeWindow(text);
  const timeFollowUp = parseRescheduleTimeFollowUp(text);
  const daypart = inferRequestedDaypart(text);
  const broadensToWholeDay = isWholeDayAvailabilityRequest(text);
  const hasDateSignal = Boolean(range || explicitDate);
  const refersToSameDay = /\b(?:that\s+day|same\s+day|den\s+dagen|samma\s+dag|diesem\s+tag|gleichen\s+tag|ese\s+d[ií]a|mismo\s+d[ií]a|hamoon\s+rooz|hamon\s+rooz)\b/i.test(text) ||
    /(?:همون|همان)\s*روز|ذلك\s*اليوم|نفس\s*اليوم/u.test(text);

  const startDate =
    range?.startDate ||
    explicitDate ||
    ((refersToSameDay || broadensToWholeDay) ? previous?.startDate : undefined);
  const endDate =
    range?.endDate ||
    explicitDate ||
    ((refersToSameDay || broadensToWholeDay) ? previous?.endDate : undefined);
  if (!startDate || !endDate) return null;

  const common = {
    startDate,
    endDate,
    rejectedTimes: [...timeFollowUp.rejectedTimes],
    generatedFromLatestRequestAt: Date.now()
  };

  // A date/weekday-only follow-up inside an active availability flow is a fresh
  // whole-day request. It must not inherit a rejected exact time or old bounds.
  if (
    broadensToWholeDay ||
    (
      hasDateSignal &&
      !timeWindow &&
      !timeFollowUp.explicitTime &&
      !timeFollowUp.boundary &&
      !daypart
    )
  ) {
    return { ...common, kind: startDate === endDate ? "whole_day" : "date_range", rejectedTimes: [] };
  }
  if (timeWindow) {
    return {
      ...common,
      kind: "time_window",
      minTime: timeWindow.minTime,
      maxTime: timeWindow.maxTime
    };
  }
  if (timeFollowUp.boundary) {
    if (timeFollowUp.boundary.kind === "approximate") {
      return {
        ...common,
        kind: "approximate_time",
        exactTime: timeFollowUp.boundary.time,
        timeBoundary: timeFollowUp.boundary
      };
    }
    return {
      ...common,
      kind: "time_boundary",
      timeBoundary: timeFollowUp.boundary
    };
  }
  if (timeFollowUp.explicitTime) {
    return {
      ...common,
      kind: "exact_time",
      exactTime: timeFollowUp.explicitTime
    };
  }
  if (daypart) {
    const daypartOptions = getDaypartSlotOptions(daypart);
    return {
      ...common,
      kind: "daypart",
      daypart,
      minTime: daypartOptions.minTime,
      maxTime: daypartOptions.maxTime
    };
  }
  return range
    ? { ...common, kind: startDate === endDate ? "whole_day" : "date_range", rejectedTimes: [] }
    : null;
}

function availabilityConstraintSlotOptions(
  constraint: CanonicalAvailabilityConstraint
): SlotSearchOptions {
  return {
    ...(constraint.minTime ? { minTime: constraint.minTime } : {}),
    ...(constraint.maxTime ? { maxTime: constraint.maxTime } : {}),
    ...(constraint.timeBoundary ? { timeBoundary: constraint.timeBoundary } : {}),
    ...(Array.isArray(constraint.rejectedTimes) && constraint.rejectedTimes.length
      ? { excludedTimes: constraint.rejectedTimes }
      : {})
  };
}

function isAlternativeAvailabilityRequest(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  return /\b(other|alternative|another|andra|alternativa|någon annan dag|andra dagar|outside|utanför|dagar efter|roo?z(?:e|hay)? dige|روز(?:های)? دیگر)\b/i.test(raw);
}

function formatRangeAvailabilityReply(
  slots: string[],
  language: string,
  request: AvailabilityRangeRequest,
  outsideOriginalRange: boolean
): string {
  if (slots.length === 0) {
    if (language === "sv") return `Jag hittar inga lediga tider mellan ${request.minTime || "öppning"} och ${request.maxTime || "stängning"} i det önskade intervallet. Vill du att jag söker andra dagar?`;
    if (language === "fa") return `در بازه درخواستی بین ${request.minTime || "زمان باز شدن"} تا ${request.maxTime || "زمان بسته شدن"} وقت خالی پیدا نکردم. روزهای دیگری را بررسی کنم؟`;
    if (language === "de") return `Im gewünschten Zeitraum finde ich zwischen ${request.minTime || "Öffnung"} und ${request.maxTime || "Schließung"} keinen freien Termin. Soll ich andere Tage prüfen?`;
    if (language === "es") return `No encuentro horas libres entre ${request.minTime || "la apertura"} y ${request.maxTime || "el cierre"} en el intervalo solicitado. ¿Busco otros días?`;
    if (language === "ar") return `لم أجد مواعيد متاحة بين ${request.minTime || "الافتتاح"} و${request.maxTime || "الإغلاق"} ضمن النطاق المطلوب. هل أبحث في أيام أخرى؟`;
    return `I can’t find an available time between ${request.minTime || "opening"} and ${request.maxTime || "closing"} in the requested range. Shall I check other days?`;
  }

  const base = buildLocalizedSlotReply(slots, undefined, language);
  if (!outsideOriginalRange) return base;
  if (language === "sv") return `Utanför det ursprungliga intervallet hittade jag: ${base}`;
  if (language === "fa") return `خارج از بازه اولیه این زمان‌ها خالی هستند: ${base}`;
  if (language === "de") return `Außerhalb des ursprünglichen Zeitraums habe ich Folgendes gefunden: ${base}`;
  if (language === "es") return `Fuera del intervalo original encontré: ${base}`;
  if (language === "ar") return `خارج النطاق الأصلي وجدت: ${base}`;
  return `Outside the original requested range, I found: ${base}`;
}

function formatSlotNoLongerAvailable(
  language: string,
  selectedTime: string | undefined,
  alternatives: string[]
): string {
  const time = normalizeRequestedTime(selectedTime || "") || selectedTime || "";
  const alternativeText = alternatives.length > 0
    ? buildLocalizedSlotReply(alternatives, undefined, language)
    : "";
  if (language === "sv") {
    return alternatives.length > 0
      ? `Tiden kl. ${time} hann tyvärr bli upptagen. ${alternativeText}`
      : `Tiden kl. ${time} hann tyvärr bli upptagen. Jag hittar ingen annan ledig tid den dagen just nu.`;
  }
  if (language === "fa") {
    return alternatives.length > 0
      ? `متأسفانه ساعت ${time} دیگر خالی نیست. ${alternativeText}`
      : `متأسفانه ساعت ${time} دیگر خالی نیست و فعلاً زمان آزاد دیگری در همان روز پیدا نکردم.`;
  }
  if (language === "de") {
    return alternatives.length > 0
      ? `Der Termin um ${time} Uhr wurde leider gerade vergeben. ${alternativeText}`
      : `Der Termin um ${time} Uhr wurde leider gerade vergeben. Aktuell finde ich an diesem Tag keine weitere freie Zeit.`;
  }
  if (language === "es") {
    return alternatives.length > 0
      ? `La hora de las ${time} acaba de ocuparse. ${alternativeText}`
      : `La hora de las ${time} acaba de ocuparse y no encuentro otra libre ese día.`;
  }
  if (language === "ar") {
    return alternatives.length > 0
      ? `للأسف تم حجز موعد الساعة ${time} للتو. ${alternativeText}`
      : `للأسف تم حجز موعد الساعة ${time} للتو، ولا أجد وقتًا آخر متاحًا في ذلك اليوم.`;
  }
  return alternatives.length > 0
    ? `The ${time} slot was just taken. ${alternativeText}`
    : `The ${time} slot was just taken, and I can’t find another available time that day right now.`;
}

function resolveRescheduleDate(text: string, appointment?: any): string | null {
  const explicit = resolveExplicitBookingDate(text);
  if (explicit) return explicit;

  const raw = String(text || "").trim().toLowerCase();
  const appointmentStart = String(appointment?.start || "").trim();
  const appointmentDate = appointmentStart
    ? stockholmDateString(new Date(ensureStockholmOffset(appointmentStart)))
    : null;

  // "same day", "samma dag", and equivalent phrases refer to the current appointment date.
  if (
    appointmentDate &&
    /\b(samma dag|samma datum|den dagen|same day|same date|hamon rooz|hamoon rooz|همان روز|همون روز)\b/i.test(raw)
  ) {
    return appointmentDate;
  }

  // During an active reschedule flow, a reply containing only a new clock time means
  // keep the appointment date and change only the time. This prevents endless loops
  // after messages such as "imorgon kl 18:30" followed by "18:30" or "samma dag 18:30".
  if (appointmentDate && inferRequestedTimeFromText(raw)) return appointmentDate;

  return null;
}

function isRescheduleDateCorrection(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  const hasExplicitCalendarDate =
    /\b20\d{2}-\d{2}-\d{2}\b/.test(raw) ||
    /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]20\d{2})?\b/.test(raw) ||
    /\b(?:den\s+)?\d{1,2}\s+(?:januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)(?:\s+20\d{2})?\b/i.test(raw);
  if (!hasExplicitCalendarDate) return false;
  return /\b(nej|inte|menar|rättelse|istället|no|not|mean|instead)\b/i.test(raw);
}

function inferBookingDurationFromContext(text: string, history: any[]): number {
  const combined = [
    ...(history || []).slice(-10).map((item: any) =>
      typeof item?.content === "string" ? item.content : ""
    ),
    text || ""
  ].join(" ").toLowerCase();

  // Keep service recognition in one place. This also catches stretched or
  // misspelled Finglish such as "moshaveeeereh".
  if (inferServiceFromText(combined) === "Konsultation") return 30;

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

  // A recognized service is enough to keep the message inside the deterministic
  // booking engine. Accept common Finglish endings such as "vaghte" as well.
  if (inferServiceFromText(combined) !== "Bokning") return true;

  return /\b(boka|bokning|tid(?:en)?|appointment|book|booking|vaght(?:e|i)?|begir(?:am|im)|رزرو|وقت)\b/i.test(combined);
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

function findOwnedOfferedSlot(pending: any, startIso?: string | null): OwnedOfferedSlot | null {
  const targetMs = new Date(ensureStockholmOffset(String(startIso || ""))).getTime();
  if (!Number.isFinite(targetMs)) return null;
  return (Array.isArray(pending?.ownedOfferedSlots) ? pending.ownedOfferedSlots : []).find(
    (slot: OwnedOfferedSlot) =>
      new Date(ensureStockholmOffset(String(slot?.start || ""))).getTime() === targetMs
  ) || null;
}

function selectOwnedOfferedSlot(text: string, pending: any): OwnedOfferedSlot | null {
  const selectedIso = selectRescheduleOfferedSlot(
    text,
    Array.isArray(pending?.offeredSlots) ? pending.offeredSlots : []
  );
  return findOwnedOfferedSlot(pending, selectedIso);
}

function isExistingAppointmentLookupIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  if (isDirectAppointmentLookupPhrase(raw)) return true;

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

function isExistingBookingOperationRecoveryIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase().normalize("NFKC");
  if (!raw) return false;
  return /\b(i (?:already )?have (?:an? )?(?:appointment|booking)|i have already booking|but i (?:already )?have|i (?:only|just) want to (?:change|move|reschedule)|change my existing booking|my existing booking)\b/iu.test(raw) ||
    /\b(jag har redan (?:en )?(?:bokning|tid)|jag vill bara (?:ändra|flytta|boka om)|min befintliga bokning|ändra min bokning)\b/iu.test(raw) ||
    /(من قبلاً وقت دارم|من از قبل رزرو دارم|فقط می.?خوام وقتمو تغییر بدم|رزرو قبلی|وقت قبلی)/u.test(raw) ||
    /\b(man az ghabl vaght daram|man ghablan rezerv daram|faghat mikham vaghtam ro taghir bedam|hamoon booking ghabli)\b/iu.test(raw);
}

function isPastAppointmentLookupIntent(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return /(?:^|\s)(igår|igar|yesterday|gestern|ayer|dirooz|diruz|tidigare|förra\s+veckan|last\s+week|letzte\s+woche|semana\s+pasada|hade\s+tid|had\s+an\s+appointment|hatte\s+ich\s+einen\s+termin|ten[ií]a\s+una\s+cita|missat|missed)(?=\s|$)/i.test(raw) ||
    /(?:دیروز|قرار قبلی|وقت قبلی|أمس|امس|موعد سابق)/u.test(raw);
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

function formatLocalizedFlowFallback(language: string, reply: string): string {
  const raw = String(reply || "").trim();
  const contactIntent =
    /\b(name|phone|mobile|contact|namn|telefon|mobilnummer)\b/i.test(raw) ||
    /(نام|اسم|شماره|موبایل)/u.test(raw);
  if (contactIntent) return formatAskContactMessage(language);

  const conflictIntent =
    /\b(no longer available|unavailable|taken|conflict|inte längre ledig|upptagen)\b/i.test(raw) ||
    /(دیگر خالی نیست|پر شده|گرفته شده)/u.test(raw);
  if (conflictIntent) {
    if (language === "sv") return "Tiden är tyvärr inte längre ledig. Jag söker gärna fram nya lediga tider. 😊";
    if (language === "fa") return "متأسفانه این زمان دیگر خالی نیست. می‌تونم زمان‌های آزاد جدید رو بررسی کنم. 😊";
    if (language === "de") return "Dieser Termin ist leider nicht mehr frei. Ich suche gern neue verfügbare Zeiten.";
    if (language === "es") return "Esa hora ya no está disponible. Puedo buscar nuevas horas libres.";
    if (language === "ar") return "للأسف لم يعد هذا الوقت متاحًا. يمكنني البحث عن أوقات جديدة.";
    return "That time is no longer available. I can check newly available times for you. 😊";
  }

  if (language === "sv") return "Ursäkta, jag kunde inte slutföra det just nu. Försök gärna igen om en liten stund.";
  if (language === "fa") return "ببخشید، الان نتونستم این کار رو کامل کنم. لطفاً کمی بعد دوباره تلاش کنید.";
  if (language === "de") return "Entschuldigung, ich konnte das gerade nicht abschließen. Bitte versuchen Sie es gleich noch einmal.";
  if (language === "es") return "Lo siento, no pude completar eso ahora. Inténtalo de nuevo en un momento.";
  if (language === "ar") return "عذرًا، لم أتمكن من إكمال ذلك الآن. يرجى المحاولة بعد قليل.";
  return "Sorry, I couldn’t complete that just now. Please try again in a moment.";
}

function guardCustomerFacingReply(sessionId: string, reply: string, fallbackLanguage?: string): string {
  const raw = String(reply || "").trim();
  const language = getStoredFlowLanguage(sessionId) ||
    chatLanguages[sessionId] ||
    fallbackLanguage ||
    "en";
  if (!raw) return getErrorMessageByLanguage(language);

  const hasEnglishStructure = /\b(to confirm|can i ask|please send|please choose|i need|i can'?t find|what mobile|what day|what time|which time|of course|your appointment|your booking|would you like|sorry|couldn'?t|is available|is booked|try again)\b/i.test(raw);
  const hasSwedishStructure = /\b(för att|kan jag|ditt namn|din bokning|mobilnummer|vill du|tyvärr|är ledig|är bokad)\b/i.test(raw);
  const hasPersianStructure = /[\u0600-\u06FF]/u.test(raw) &&
    /(برای|لطفاً|می.?خواهید|وقت|رزرو|نام|شماره|متأسفانه)/u.test(raw);
  const strongReplyLanguage = isMeaningfulLanguageMessage(raw)
    ? detectStrongLatestLanguage(raw) || detectUserLanguage(raw)
    : null;
  const incompatible =
    Boolean(strongReplyLanguage && strongReplyLanguage !== language) ||
    (language === "sv" && hasEnglishStructure) ||
    (language === "fa" && (hasEnglishStructure || hasSwedishStructure)) ||
    (language === "en" && (hasSwedishStructure || hasPersianStructure)) ||
    (["de", "es", "ar"].includes(language) && hasEnglishStructure);

  if (!incompatible) return raw;
  console.warn("[CustomerReplyGuard]", {
    language,
    mixedLanguageBlocked: true,
    stateType: conversationFlowLanguages[sessionId]?.flowType || "none"
  });
  const reschedule = rescheduleContexts[sessionId];
  if (reschedule?.selectedNewStartTime) {
    return formatRescheduleConfirmation(language, reschedule.selectedNewStartTime);
  }
  if (Array.isArray(reschedule?.offeredSlots) && reschedule.offeredSlots.length > 0) {
    return formatSwedishTimeSlots(reschedule.offeredSlots, reschedule.requestedTime, language);
  }
  const pending = pendingBookings[sessionId];
  if (pending?.status === "awaiting_contact") {
    return formatAskContactMessageForPlatform(language, normalizePlatformName(pending.platform || ""));
  }
  if (pending?.status === "awaiting_time_selection" && Array.isArray(pending.offeredSlots)) {
    return formatSwedishTimeSlots(pending.offeredSlots, undefined, language);
  }
  return formatLocalizedFlowFallback(language, raw);
}

function localizeServiceName(service: string, language: string): string {
  const raw = String(service || "").toLowerCase();
  const isBikini = raw.includes("bikini");
  const isFullBody = raw.includes("helkropp") || raw.includes("fullbody") || raw.includes("full body");
  const isConsultation = raw.includes("konsultation") || raw.includes("consultation") || raw.includes("مشاوره");
  if (language === "fa") {
    if (isConsultation) return "مشاوره";
    if (isBikini) return "بیکینی";
    if (isFullBody) return "لیزر فول بادی";
    if (raw.includes("laser")) return "لیزر";
    return "وقت";
  }
  if (language === "en") {
    if (isConsultation) return "consultation";
    if (isBikini) return "bikini treatment";
    if (isFullBody) return "full body laser treatment";
    return service || "appointment";
  }
  if (language === "sv") return service || "bokning";
  if (language === "de") {
    if (isConsultation) return "Beratung";
    if (isBikini) return "Bikini-Behandlung";
    if (isFullBody) return "Ganzkörper-Laserbehandlung";
    return service || "Termin";
  }
  if (language === "es") {
    if (isConsultation) return "consulta";
    if (isBikini) return "tratamiento de bikini";
    if (isFullBody) return "tratamiento láser de cuerpo completo";
    return service || "cita";
  }
  if (language === "ar") {
    if (isConsultation) return "الاستشارة";
    if (isBikini) return "علاج البكيني";
    if (isFullBody) return "ليزر الجسم الكامل";
    return "موعد";
  }
  return service || "appointment";
}

function formatLocalizedDateTime(dateTime: string, language: string, timeZone: string = "Europe/Stockholm") {
  const start = new Date(ensureStockholmOffset(dateTime));
  const localeMap: Record<string, string> = { fa: "fa-IR", sv: "sv-SE", en: "en-GB", de: "de-DE", es: "es-ES", ar: "ar-SA" };
  const locale = localeMap[language] || "en-GB";
  const dateText = start.toLocaleDateString(locale, { timeZone, weekday: "long", day: "numeric", month: "long" });
  const timeText = start.toLocaleTimeString("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit" });
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

type AtomicClaimState = {
  type:
    | "inbound_message_claim"
    | "reschedule_operation_claim"
    | "cancellation_operation_claim";
  status: "processing" | "completed" | "failed";
  attempts: number;
  claimedAt: number;
  updatedAt: number;
  retryAfter?: number;
};

type AtomicClaimHandle = {
  claimed: boolean;
  keyHash: string;
  storageId: string;
  state: AtomicClaimState;
  duplicateStatus?: AtomicClaimState["status"];
};

const atomicClaims = new Map<string, AtomicClaimState>();
const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_PROCESSING_TTL_MS = 2 * 60 * 1000;
const IDEMPOTENCY_RETRY_DELAY_MS = 5 * 1000;
const IDEMPOTENCY_MAX_ATTEMPTS = 3;

function isDuplicateInsertError(error: any): boolean {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "23505" || message.includes("duplicate") || message.includes("unique constraint");
}

function parseAtomicClaimState(value: any): AtomicClaimState | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (
      !parsed ||
      ![
        "inbound_message_claim",
        "reschedule_operation_claim",
        "cancellation_operation_claim"
      ].includes(parsed.type) ||
      !["processing", "completed", "failed"].includes(parsed.status)
    ) return null;
    return {
      type: parsed.type,
      status: parsed.status,
      attempts: Math.max(1, Number(parsed.attempts || 1)),
      claimedAt: Number(parsed.claimedAt || 0),
      updatedAt: Number(parsed.updatedAt || 0),
      retryAfter: parsed.retryAfter ? Number(parsed.retryAfter) : undefined
    };
  } catch {
    return null;
  }
}

function atomicClaimMayRetry(state: AtomicClaimState, now: number): boolean {
  if (state.attempts >= IDEMPOTENCY_MAX_ATTEMPTS) return false;
  if (state.status === "failed") return now >= Number(state.retryAfter || 0);
  return state.status === "processing" &&
    now - Number(state.updatedAt || state.claimedAt || 0) > IDEMPOTENCY_PROCESSING_TTL_MS;
}

async function claimAtomicOperation(params: {
  type: AtomicClaimState["type"];
  tenantScope: string;
  platform: string;
  exactId: string;
  businessId?: string;
}): Promise<AtomicClaimHandle> {
  const platform = normalizePlatformName(params.platform);
  const tenantScope = String(params.tenantScope || "").trim();
  const exactId = String(params.exactId || "").trim();
  const now = Date.now();
  const rawKey = `${params.type}|${tenantScope}|${platform}|${exactId}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const claimPrefix = params.type === "inbound_message_claim"
    ? "idem"
    : params.type === "reschedule_operation_claim"
      ? "resop"
      : "cancelop";
  const storageId = `${claimPrefix}_${keyHash.slice(0, 48)}`;
  const existingMemory = atomicClaims.get(keyHash);

  if (existingMemory) {
    if (
      existingMemory.status === "completed" &&
      now - existingMemory.updatedAt <= IDEMPOTENCY_COMPLETED_TTL_MS
    ) {
      return { claimed: false, keyHash, storageId, state: existingMemory, duplicateStatus: "completed" };
    }
    if (!atomicClaimMayRetry(existingMemory, now)) {
      return {
        claimed: false,
        keyHash,
        storageId,
        state: existingMemory,
        duplicateStatus: existingMemory.status
      };
    }
  }

  const nextState: AtomicClaimState = {
    type: params.type,
    status: "processing",
    attempts: Number(existingMemory?.attempts || 0) + 1,
    claimedAt: now,
    updatedAt: now
  };

  // Setting the process-local claim before the first await makes concurrent deliveries
  // on the same instance atomic. Supabase adds cross-instance atomicity via user_id's
  // existing unique constraint.
  atomicClaims.set(keyHash, nextState);

  if (!supabase) {
    return { claimed: true, keyHash, storageId, state: nextState };
  }

  const serialized = JSON.stringify(nextState);
  const { error: insertError } = await supabase
    .from("appointments_leads")
    .insert([{
      user_id: storageId,
      platform: `idempotency:${platform}`,
      business_id: params.businessId || null,
      ai_summary: serialized
    }]);

  if (!insertError) {
    return { claimed: true, keyHash, storageId, state: nextState };
  }

  if (!isDuplicateInsertError(insertError)) {
    atomicClaims.delete(keyHash);
    console.error("[Idempotency] Durable claim failed; refusing unsafe processing.", {
      platform,
      type: params.type,
      errorCode: String(insertError?.code || "storage_error")
    });
    return { claimed: false, keyHash, storageId, state: nextState, duplicateStatus: "failed" };
  }

  const { data: storedRow, error: readError } = await supabase
    .from("appointments_leads")
    .select("ai_summary")
    .eq("user_id", storageId)
    .maybeSingle();
  if (readError || !storedRow) {
    atomicClaims.delete(keyHash);
    console.error("[Idempotency] Existing durable claim could not be read.", {
      platform,
      type: params.type,
      errorCode: String(readError?.code || "missing_claim")
    });
    return { claimed: false, keyHash, storageId, state: nextState, duplicateStatus: "processing" };
  }

  const storedState = parseAtomicClaimState(storedRow.ai_summary);
  if (!storedState || !atomicClaimMayRetry(storedState, now)) {
    if (storedState) atomicClaims.set(keyHash, storedState);
    return {
      claimed: false,
      keyHash,
      storageId,
      state: storedState || nextState,
      duplicateStatus: storedState?.status || "processing"
    };
  }

  const retryState: AtomicClaimState = {
    ...storedState,
    status: "processing",
    attempts: storedState.attempts + 1,
    claimedAt: now,
    updatedAt: now,
    retryAfter: undefined
  };
  const previousSerialized = typeof storedRow.ai_summary === "string"
    ? storedRow.ai_summary
    : JSON.stringify(storedRow.ai_summary);
  const { data: claimedRow, error: retryError } = await supabase
    .from("appointments_leads")
    .update({ ai_summary: JSON.stringify(retryState) })
    .eq("user_id", storageId)
    .eq("ai_summary", previousSerialized)
    .select("user_id")
    .maybeSingle();
  if (retryError || !claimedRow) {
    atomicClaims.set(keyHash, storedState);
    return {
      claimed: false,
      keyHash,
      storageId,
      state: storedState,
      duplicateStatus: storedState.status
    };
  }

  atomicClaims.set(keyHash, retryState);
  return { claimed: true, keyHash, storageId, state: retryState };
}

async function settleAtomicOperation(
  handle: AtomicClaimHandle,
  status: "completed" | "failed"
): Promise<boolean> {
  if (!handle.claimed) return false;
  const now = Date.now();
  const state: AtomicClaimState = {
    ...handle.state,
    status,
    updatedAt: now,
    ...(status === "failed" ? { retryAfter: now + IDEMPOTENCY_RETRY_DELAY_MS } : { retryAfter: undefined })
  };
  atomicClaims.set(handle.keyHash, state);
  if (!supabase) return true;

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { data, error } = await supabase
      .from("appointments_leads")
      .update({ ai_summary: JSON.stringify(state) })
      .eq("user_id", handle.storageId)
      .select("user_id")
      .maybeSingle();
    if (!error && data?.user_id === handle.storageId) return true;
    lastError = error || new Error("claim_settlement_row_missing");
  }
  console.error("[Idempotency] Durable claim settlement failed.", {
    status,
    errorCode: String(lastError?.code || "storage_error")
  });
  return false;
}

async function runWithInboundMessageClaim(params: {
  tenantScope: string;
  businessId?: string;
  platform: string;
  messageId: string;
  handler: () => Promise<void>;
}): Promise<void> {
  const claim = await claimAtomicOperation({
    type: "inbound_message_claim",
    tenantScope: params.tenantScope,
    businessId: params.businessId,
    platform: params.platform,
    exactId: params.messageId
  });
  if (!claim.claimed) {
    console.log("[Idempotency] Duplicate inbound message suppressed.", {
      platform: normalizePlatformName(params.platform),
      duplicateStatus: claim.duplicateStatus || "processing"
    });
    return;
  }
  try {
    await params.handler();
    await settleAtomicOperation(claim, "completed");
  } catch (error) {
    await settleAtomicOperation(claim, "failed");
    throw error;
  }
}

function maskToken(token?: string) {
  if (!token) return "missing-token";
  if (token.length < 12) return token;
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function normalizeBusinessConfig(row: any) {
  const adminNotificationChannel = String(row?.admin_notification_channel ?? row?.adminNotificationChannel ?? "telegram").trim().toLowerCase() || "telegram";
  const adminWhatsAppNumber = String(row?.admin_whatsapp_number ?? row?.adminWhatsAppNumber ?? "").trim();
  const adminTelegramChatId = String(row?.admin_telegram_chat_id ?? row?.adminTelegramChatId ?? "").trim();
  return {
    ...activeConfig,
    businessRecordId: row.id,
    business_id: row.id,
    id: row.id,
    businessName: row.business_name,
    business_name: row.business_name,
    telegramToken: row.telegram_bot_token,
    adminTelegramChatId,
    admin_telegram_chat_id: adminTelegramChatId,
    adminNotificationChannel,
    admin_notification_channel: adminNotificationChannel,
    adminWhatsAppNumber,
    admin_whatsapp_number: adminWhatsAppNumber,
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
    allowCancellation: Boolean(row.allow_cancellation),
    cancellationDeadlineMinutes: Math.max(0, Number(row.cancellation_deadline_minutes || 0)),
    cancellationFeeEnabled: Boolean(row.cancellation_fee_enabled),
    cancellationFeeAmount: Math.max(0, Number(row.cancellation_fee_amount || 0)),
    cancellationFeeCurrency: String(row.cancellation_fee_currency || "SEK"),
    bookingWindowDays: Number(
      row.booking_window_days ??
      row.advance_booking_days ??
      activeConfig.bookingWindowDays ??
      activeConfig.booking_window_days ??
      30
    ),
    services: Array.isArray(row.services) ? row.services : activeConfig.services,
    serviceDurations: row.service_durations || activeConfig.serviceDurations || activeConfig.service_durations,
    calendarProvider: "google",
  };
}

const businessConfigVersions: Record<string, string> = {};

function makeBusinessConfigVersion(config: any): string {
  const businessId = getBusinessIdFromConfig(config) || "no-business";
  const businessName = config?.businessName || config?.business_name || "";
  const prompt = config?.systemPrompt || "";
  const calendarId = config?.googleCalendarId || "";
  const cancellationPolicy = [
    Boolean(config?.allowCancellation ?? config?.allow_cancellation ?? false),
    Number(config?.cancellationDeadlineMinutes ?? config?.cancellation_deadline_minutes ?? 0),
    Boolean(config?.cancellationFeeEnabled ?? config?.cancellation_fee_enabled ?? false),
    Number(config?.cancellationFeeAmount ?? config?.cancellation_fee_amount ?? 0),
    String(config?.cancellationFeeCurrency ?? config?.cancellation_fee_currency ?? "SEK")
  ].join("|");
  return crypto.createHash("sha1").update(`${businessId}|${businessName}|${calendarId}|${prompt}|${cancellationPolicy}`).digest("hex");
}

function resetSessionIfBusinessConfigChanged(sessionId: string, config: any) {
  const nextVersion = makeBusinessConfigVersion(config);
  const previousVersion = businessConfigVersions[sessionId];
  if (previousVersion && previousVersion !== nextVersion) {
    console.log(`[BusinessConfig] Config changed for session=${sessionId}. Clearing in-memory chat history so old business identity cannot leak.`);
    chatSessions[sessionId] = [];
    delete pendingBookings[sessionId];
    delete recentlyCompletedBookings[sessionId];
    delete appointmentContexts[sessionId];
    delete appointmentSelectionContexts[sessionId];
    delete appointmentLookupContexts[sessionId];
    delete rescheduleContexts[sessionId];
    delete recentlyCompletedReschedules[sessionId];
    delete cancellationContexts[sessionId];
    delete appointmentStateOwners[sessionId];
    delete availabilitySearchContexts[sessionId];
    delete pastAppointmentRecoveryContexts[sessionId];
    delete conversationFlowLanguages[sessionId];
    delete chatLanguages[sessionId];
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
      console.log(
        `[TelegramConfig] business=${freshConfig.businessName || "unknown"} (${getBusinessIdFromConfig(freshConfig) || "missing"}), ` +
        `allowCancellation=${freshConfig.allowCancellation}, ` +
        `deadlineMinutes=${freshConfig.cancellationDeadlineMinutes}, ` +
        `calendar_id=${freshConfig.googleCalendarId || "missing"}`
      );
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

  const currentAppointmentStateOwner: AppointmentStateOwner = {
    sessionId,
    businessId: getAppointmentBusinessScope(businessConfig),
    platform: platformName,
    userId: normalizePlatformUserId(platformName, recipientUserId),
  };
  const currentBookingSlotOwner: BookingSlotOwner = {
    sessionId,
    businessId: currentAppointmentStateOwner.businessId,
    platform: currentAppointmentStateOwner.platform,
    userId: currentAppointmentStateOwner.userId
  };
  const storedAppointmentStateOwner = appointmentStateOwners[sessionId];
  const invalidatedRescheduleLanguage = rescheduleContexts[sessionId]?.lockedReplyLanguage ||
    rescheduleContexts[sessionId]?.language ||
    "";
  let appointmentStateWasInvalidated = false;
  const suppliedIdentityPhone = extractPhoneOnly(text) || undefined;
  if (
    (storedAppointmentStateOwner || hasAppointmentConversationState(sessionId)) &&
    (
      !appointmentStateOwnerMatches(storedAppointmentStateOwner, currentAppointmentStateOwner) ||
      appointmentIdentityKeyConflictsCanonical(storedAppointmentStateOwner?.identityKey, suppliedIdentityPhone)
    )
  ) {
    console.warn(`[AppointmentState] Cleared stale or cross-identity state session=${sessionId}`);
    appointmentStateWasInvalidated = true;
    clearAppointmentConversationState(sessionId);
  }

  const language = getConversationLanguage(sessionId, text);
  const latestStrongLanguage = detectStrongLatestLanguage(text);
  let pending = await loadPendingBooking(sessionId, platformName, businessConfig);
  const entryRescheduleContext = getRescheduleContext(sessionId);
  const entryCancellationContext = getCancellationContext(sessionId);

  // A validated reschedule flow owns short confirmations and slot follow-ups. Clear any
  // unrelated pending new-booking state before it can ask for contact details.
  if (entryCancellationContext && !isExplicitNewBookingRequest(text) && pending) {
    console.log(`[UnifiedBooking] Active cancellation cleared incompatible pending booking session=${sessionId}`);
    await clearPendingBooking(sessionId);
    pending = null;
  } else if (entryRescheduleContext && !isExplicitNewBookingRequest(text) && pending) {
    console.log(`[UnifiedBooking] Active reschedule cleared incompatible pending booking session=${sessionId}`);
    await clearPendingBooking(sessionId);
    pending = null;
  }
  if (entryCancellationContext) {
    clearRescheduleContext(sessionId);
  } else if (entryRescheduleContext) {
    clearCancellationContext(sessionId);
  }

  // A restored flow may change language only after a meaningful, clearly different
  // customer message. Short confirmations, times, names, and phone numbers inherit it.
  if (
    pending &&
    latestStrongLanguage &&
    pending.language !== latestStrongLanguage &&
    isMeaningfulLanguageMessage(text) &&
    hasStrongLanguageEvidence(latestStrongLanguage, text)
  ) {
    console.log(
      `[LanguageLock] updating pending flow language previous=${pending.language || "none"} with=${latestStrongLanguage} session=${sessionId}`
    );
    pending.language = latestStrongLanguage;
    await savePendingBooking(sessionId, platformName, pending);
  }

  if (entryRescheduleContext) {
    lockConversationFlowLanguage(sessionId, entryRescheduleContext.lockedReplyLanguage || language, "reschedule");
  } else if (pending) {
    lockConversationFlowLanguage(sessionId, pending.language || language, "booking");
  } else if (hasAppointmentConversationState(sessionId)) {
    lockConversationFlowLanguage(sessionId, getStoredFlowLanguage(sessionId) || language, "appointment");
  }

  const replyAndRecord = async (reply: string) => {
    const guardedReply = guardCustomerFacingReply(sessionId, reply, language);
    await send(guardedReply);
    appendLocalHistory(sessionId, text, guardedReply);
    await postProcessMessage(
      recipientUserId,
      postProcessPlatform,
      text,
      guardedReply,
      businessConfig?.telegramToken,
      businessConfig?.apiKey,
      getBusinessIdFromConfig(businessConfig)
    );
  };

  if (appointmentStateWasInvalidated) {
    await replyAndRecord(formatStaleAppointmentStateMessage(invalidatedRescheduleLanguage || language));
    return true;
  }

  const completeCancellation = async (context: CancellationContext): Promise<boolean> => {
    const adapter = getCalendarAdapter(businessConfig);
    const businessId = String(getBusinessIdFromConfig(businessConfig) || "");
    const logCancellationStage = (
      stage: string,
      result: string,
      details: Partial<{
        ownershipMatch: boolean;
        calendarVerified: boolean;
        databaseVerified: boolean;
      }> = {}
    ) => {
      if (platformName !== "instagram") return;
      logInstagramCancellationStage({
        stage,
        businessScopePresent: Boolean(businessId),
        result,
        ...details
      });
    };
    const stateOwner = appointmentStateOwners[sessionId];
    if (!stateOwner || !appointmentStateOwnerMatches(stateOwner, currentAppointmentStateOwner)) {
      logCancellationStage("ownership", "rejected", { ownershipMatch: false });
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(context.language));
      return true;
    }

    const appointment = await validateStoredAppointmentForMutation(
      context.appointment,
      stateOwner,
      businessConfig,
      adapter
    );
    if (!appointment) {
      logCancellationStage("ownership", "rejected", { ownershipMatch: false });
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(context.language));
      return true;
    }
    logCancellationStage("ownership", "verified", { ownershipMatch: true });
    if (classifyAppointmentTemporalState(appointment) !== "future_or_active") {
      clearCancellationContext(sessionId);
      await replyAndRecord(
        formatPastAppointmentMutationReply(
          appointment,
          classifyAppointmentTemporalState(appointment),
          context.language
        )
      );
      return true;
    }
    const eventId = String(appointment?.calendarEventId || "");
    const appointmentId = getAppointmentMutationId(appointment);
    if (!eventId || !appointmentId || !adapter.cancelAppointment) {
      logCancellationStage("mutation_prerequisites", "rejected");
      clearCancellationContext(sessionId);
      await replyAndRecord(context.language === "sv"
        ? "Jag hittade bokningen, men den saknar ett kalender-id för säker avbokning. En medarbetare behöver hjälpa till. 🙏"
        : context.language === "fa"
          ? "رزرو پیدا شد، اما شناسه تقویم لازم برای لغو امن موجود نیست. یک همکار باید کمک کند. 🙏"
          : context.language === "de"
            ? "Ich habe den Termin gefunden, aber die Kalender-ID für eine sichere Stornierung fehlt. Das Team muss helfen. 🙏"
            : context.language === "es"
              ? "Encontré la cita, pero falta el identificador de calendario necesario para cancelarla de forma segura. El equipo debe ayudarte. 🙏"
              : context.language === "ar"
                ? "وجدت الموعد، لكن معرّف التقويم اللازم للإلغاء الآمن غير موجود. يحتاج أحد أعضاء الفريق إلى المساعدة. 🙏"
                : "I found the appointment, but it has no calendar event id for a safe cancellation. A team member needs to help. 🙏");
      return true;
    }

    const operationClaim = await claimAtomicOperation({
      type: "cancellation_operation_claim",
      tenantScope: businessId,
      businessId,
      platform: platformName,
      exactId: [
        currentAppointmentStateOwner.userId,
        appointmentId,
        eventId,
        "cancel"
      ].join("|")
    });
    logCancellationStage(
      "operation_claim",
      operationClaim.claimed
        ? "acquired"
        : `duplicate_${operationClaim.duplicateStatus || "processing"}`
    );
    if (!operationClaim.claimed) {
      console.log("[Idempotency] Duplicate cancellation confirmation suppressed.", {
        platform: platformName,
        duplicateStatus: operationClaim.duplicateStatus || "processing"
      });
      if (operationClaim.duplicateStatus === "completed") {
        clearCancellationContext(sessionId);
        clearRescheduleContext(sessionId);
        await clearPendingBooking(sessionId);
      }
      return true;
    }

    cancellationContexts[sessionId] = {
      ...context,
      appointment,
      awaitingReason: false,
      lastOperation: "processing",
      savedAt: Date.now()
    };

    const originalStatus = String(appointment?.status || "booked");
    let calendarWasDeleted = false;
    let databaseWasUpdated = false;
    let databaseUpdateAttempted = false;
    const verifyCalendarDeleted = async () => {
      try {
        if (adapter.verifyEventDeleted) {
          return Boolean(await adapter.verifyEventDeleted(eventId));
        }
        if (adapter.getEventById) {
          return !(await adapter.getEventById(eventId));
        }
        const date = stockholmDateString(new Date(String(appointment.start || "")));
        const events = await adapter.getEvents(date, date);
        return !(Array.isArray(events) ? events : []).some(
          (event: any) => String(event?.id || "") === eventId
        );
      } catch (verificationError) {
        console.error("[Cancellation] Calendar deletion verification crashed:", verificationError);
        return false;
      }
    };
    const rollbackCancellation = async (): Promise<string | null> => {
      let restoredEventId: string | null = null;
      if (calendarWasDeleted) {
        try {
          const ownerMarker = `${platformName === "instagram" ? "ig" : platformName === "telegram" ? "tg" : platformName}_${currentAppointmentStateOwner.userId}`;
          const restored = await adapter.insertAppointment(
            appointment.customerName || appointment.name || "Customer",
            appointment.phone || "",
            appointment.service || "Bokning",
            appointment.start,
            getAppointmentDurationMinutes(appointment),
            ownerMarker,
            true
          );
          restoredEventId = String(restored?.event?.id || "").trim() || null;
          if (!restored?.success || !restoredEventId) {
            console.error("[Cancellation] Calendar rollback failed.");
            restoredEventId = null;
          }
        } catch (rollbackError) {
          console.error("[Cancellation] Calendar rollback crashed:", rollbackError);
        }
      }
      if (databaseUpdateAttempted && supabase && appointment?.id) {
        try {
          let rollbackQuery = supabase
            .from("appointments")
            .update({ status: originalStatus })
            .eq("id", appointment.id)
            .eq("business_id", businessId);
          if (appointment.platform) rollbackQuery = rollbackQuery.eq("platform", appointment.platform);
          if (appointment.userId) rollbackQuery = rollbackQuery.eq("user_id", appointment.userId);
          const { error } = await rollbackQuery;
          if (error) console.error("[Cancellation] Database rollback failed:", error);
        } catch (rollbackError) {
          console.error("[Cancellation] Database rollback crashed:", rollbackError);
        }
      }
      return restoredEventId;
    };
    const failCancellation = async (technicalReason: string) => {
      console.error("[Cancellation] Verified cancellation failed.", {
        platform: platformName,
        businessScopePresent: Boolean(businessId),
        reason: technicalReason,
        calendarWasDeleted,
        databaseWasUpdated
      });
      const restoredEventId = await rollbackCancellation();
      await settleAtomicOperation(operationClaim, "failed");
      if (!calendarWasDeleted || restoredEventId) {
        cancellationContexts[sessionId] = {
          ...context,
          appointment: {
            ...appointment,
            ...(restoredEventId ? { calendarEventId: restoredEventId } : {})
          },
          awaitingReason: false,
          lastOperation: "failed",
          savedAt: Date.now()
        };
      } else {
        clearCancellationContext(sessionId);
      }
      await replyAndRecord(getErrorMessageByLanguage(context.language));
      return true;
    };

    let calendarResult: any;
    logCancellationStage("calendar_delete", "started");
    try {
      calendarResult = await adapter.cancelAppointment(eventId);
    } catch (calendarError) {
      logCancellationStage("calendar_delete", "crashed");
      console.error("[Cancellation] Calendar delete crashed:", calendarError);
      return failCancellation("calendar_delete_crashed");
    }
    if (!calendarResult?.success) {
      logCancellationStage("calendar_delete", "failed");
      return failCancellation("calendar_delete_failed");
    }
    calendarWasDeleted = true;
    logCancellationStage("calendar_delete", "completed");
    const initialCalendarVerification = await verifyCalendarDeleted();
    logCancellationStage(
      "calendar_verification",
      initialCalendarVerification ? "verified_deleted" : "not_verified",
      { calendarVerified: initialCalendarVerification }
    );
    if (!initialCalendarVerification) {
      return failCancellation("calendar_delete_not_verified");
    }

    if (appointment?.source === "appointments_table") {
      if (!supabase || !appointment?.id) {
        return failCancellation("database_unavailable");
      }
      databaseUpdateAttempted = true;
      let updatedRow: any = null;
      let dbError: any = null;
      try {
        let updateQuery = supabase
          .from("appointments")
          .update({ status: "cancelled" })
          .eq("id", appointment.id)
          .eq("business_id", businessId);
        if (appointment.platform) updateQuery = updateQuery.eq("platform", appointment.platform);
        if (appointment.userId) updateQuery = updateQuery.eq("user_id", appointment.userId);
        const result = await updateQuery
          .select("id,platform,user_id,status,business_id")
          .maybeSingle();
        updatedRow = result.data;
        dbError = result.error;
      } catch (databaseError) {
        console.error("[Cancellation] Database update crashed:", databaseError);
        return failCancellation("database_update_crashed");
      }
      databaseWasUpdated = Boolean(updatedRow && !dbError);
      const rowPlatform = normalizePlatformName(String(updatedRow?.platform || ""));
      const rowUserId = normalizePlatformUserId(
        rowPlatform,
        String(updatedRow?.user_id || "")
      );
      const expectedPlatform = normalizePlatformName(stateOwner.platform);
      const expectedUserId = normalizePlatformUserId(
        expectedPlatform,
        stateOwner.userId
      );
      const dbOwnerMatches = Boolean(
        updatedRow &&
        String(updatedRow.business_id || "") === businessId &&
        rowPlatform === expectedPlatform &&
        (!rowUserId || rowUserId === expectedUserId)
      );
      const dbStatusMatches =
        String(updatedRow?.status || "").toLowerCase() === "cancelled";
      logCancellationStage(
        "database_verification",
        !dbError && databaseWasUpdated && dbOwnerMatches && dbStatusMatches
          ? "verified_cancelled"
          : "not_verified",
        {
          ownershipMatch: dbOwnerMatches,
          databaseVerified: Boolean(
            !dbError && databaseWasUpdated && dbOwnerMatches && dbStatusMatches
          )
        }
      );
      if (dbError || !databaseWasUpdated || !dbOwnerMatches || !dbStatusMatches) {
        return failCancellation("database_update_not_verified");
      }
    } else {
      logCancellationStage("database_verification", "not_applicable");
    }

    const finalCalendarVerification = await verifyCalendarDeleted();
    logCancellationStage(
      "calendar_post_database_verification",
      finalCalendarVerification ? "verified_deleted" : "not_verified",
      { calendarVerified: finalCalendarVerification }
    );
    if (!finalCalendarVerification) {
      return failCancellation("calendar_post_database_verification_failed");
    }
    const operationCompletionRecorded = await settleAtomicOperation(
      operationClaim,
      "completed"
    );
    logCancellationStage(
      "operation_settlement",
      operationCompletionRecorded ? "completed" : "failed"
    );
    if (!operationCompletionRecorded) {
      return failCancellation("operation_completion_not_durable");
    }

    cancellationContexts[sessionId] = {
      ...context,
      appointment,
      awaitingReason: false,
      lastOperation: "completed",
      savedAt: Date.now()
    };
    recentlyCompletedCancellations[sessionId] = {
      completedAt: Date.now(),
      appointmentId,
      calendarEventId: eventId,
      language: context.language
    };

    const successReply = guardCustomerFacingReply(
      sessionId,
      formatCancellationSuccess(
        context.language,
        context.feeApplies,
        context.feeAmount,
        context.currency
      ),
      context.language
    );
    try {
      const deliveryResult = await send(successReply);
      if (deliveryResult === false) {
        throw new Error("customer_success_delivery_failed");
      }
      appendLocalHistory(sessionId, text, successReply);
      logCancellationStage("customer_reply", "sent");
    } catch (sendError) {
      logCancellationStage("customer_reply", "delivery_failed");
      // The durable operation is complete. Never let a transport exception fall
      // through to Instagram's generic error handler and create a false failure.
      console.error("[Cancellation] Terminal customer success delivery failed:", sendError);
    }
    try {
      await postProcessMessage(
        recipientUserId,
        postProcessPlatform,
        text,
        successReply,
        businessConfig?.telegramToken,
        businessConfig?.apiKey,
        businessId
      );
    } catch (postProcessError) {
      console.error("[Cancellation] Terminal post-processing failed:", postProcessError);
    }

    try {
      await notifyAdminAboutCancellation(
        businessConfig,
        platformName,
        appointment,
        context.reason || "Not provided"
      );
    } catch (notifyError) {
      console.error("[CancellationNotify] crashed:", notifyError);
    }

    try {
      clearCancellationContext(sessionId);
      clearRescheduleContext(sessionId);
      await clearPendingBooking(sessionId);
      delete appointmentContexts[sessionId];
      delete appointmentSelectionContexts[sessionId];
      clearAppointmentLookupContext(sessionId);
      delete appointmentStateOwners[sessionId];
      clearConversationFlowLanguage(sessionId);
    } catch (cleanupError) {
      // Persistence and operation settlement are already complete. Cleanup must never
      // escape into a platform fallback and contradict the verified success response.
      console.error("[Cancellation] Terminal state cleanup failed:", cleanupError);
    }
    return true;
  };

  const prepareRescheduleTarget = async (
    appointment: any,
    requestedDate: string,
    requestedTime: string | null,
    lockedLanguage: string,
    options: SlotSearchOptions = {},
    requestedDaypart?: "morning" | "afternoon" | "evening" | null
  ): Promise<boolean> => {
    const adapter = getCalendarAdapter(businessConfig);
    const stateOwner = appointmentStateOwners[sessionId];
    if (!stateOwner || !appointmentStateOwnerMatches(stateOwner, currentAppointmentStateOwner)) {
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
      return true;
    }

    const liveAppointment = await validateStoredAppointmentForMutation(
      appointment,
      stateOwner,
      businessConfig,
      adapter
    );
    if (!liveAppointment) {
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
      return true;
    }
    appointment = liveAppointment;
    const currentEventId = getAppointmentCalendarEventId(appointment);
    const duration = getAppointmentDurationMinutes(appointment);
    if (!currentEventId) {
      rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime, {
        requestedDaypart: requestedDaypart || undefined,
        lastOperation: "update_failed"
      });
      await replyAndRecord(lockedLanguage === "fa"
        ? "رزرو پیدا شد، اما شناسه دقیق تقویم برای تغییر امن موجود نیست. یک همکار باید کمک کند. 🙏"
        : lockedLanguage === "sv"
          ? "Jag hittade bokningen, men det exakta kalender-id:t saknas för en säker ombokning. En medarbetare behöver hjälpa till. 🙏"
          : "I found the appointment, but its exact calendar event id is missing for a safe change. A team member needs to help. 🙏");
      return true;
    }

    if (requestedTime) {
      const candidateIso = `${requestedDate}T${requestedTime}:00${getStockholmUtcOffset(requestedDate)}`;
      const candidateStartMs = new Date(candidateIso).getTime();
      if (!Number.isFinite(candidateStartMs)) {
        rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime);
        await replyAndRecord(getErrorMessageByLanguage(lockedLanguage));
        return true;
      }
      if (candidateStartMs <= Date.now()) {
        rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime, {
          lastOperation: "awaiting_target",
          selectedNewStartTime: undefined,
          selectedEndTime: undefined
        });
        const msg = lockedLanguage === "fa"
          ? "این تاریخ یا ساعت گذشته است. لطفاً یک روز یا ساعت آینده را انتخاب کنید. 📅"
          : lockedLanguage === "sv"
            ? "Den önskade tiden har redan passerat. Välj gärna ett annat framtida datum eller klockslag. 📅"
            : "That requested time has already passed. Please choose another future date or time. 📅";
        await replyAndRecord(msg);
        return true;
      }

      const exactValidation = await validateCanonicalExactSlot({
        adapter,
        owner: currentBookingSlotOwner,
        businessConfig,
        start: candidateIso,
        service: String(appointment?.service || "Bokning"),
        durationMinutes: duration,
        excludeEventId: currentEventId
      });
      if (exactValidation.free && exactValidation.normalizedIso && exactValidation.endIso) {
        const ownedSlot: OwnedOfferedSlot = {
          start: exactValidation.normalizedIso,
          end: exactValidation.endIso,
          durationMinutes: duration,
          service: String(appointment?.service || "Bokning"),
          businessId: currentBookingSlotOwner.businessId,
          platform: currentBookingSlotOwner.platform,
          userId: currentBookingSlotOwner.userId,
          generatedAt: Date.now()
        };
        rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime, {
          requestedDaypart: requestedDaypart || undefined,
          selectedNewStartTime: ownedSlot.start,
          selectedEndTime: ownedSlot.end,
          offeredSlots: [`Selected (ISO: ${ownedSlot.start})`],
          ownedOfferedSlots: [ownedSlot],
          lastOfferedTime: requestedTime,
          lastOperation: "awaiting_confirmation"
        });
        await replyAndRecord(formatRescheduleConfirmation(lockedLanguage, ownedSlot.start));
        return true;
      }
    }

    const canonicalOffers = await createCanonicalOfferedSlots({
      adapter,
      owner: currentBookingSlotOwner,
      businessConfig,
      startDate: requestedDate,
      endDate: requestedDate,
      service: String(appointment?.service || "Bokning"),
      durationMinutes: duration,
      requestedTime: requestedTime || undefined,
      options,
      excludeEventId: currentEventId
    });
    const offeredSlots = canonicalOffers.displaySlots;
    const offeredTimes = offeredSlots
      .map((slot) => getStockholmTimeFromIso(parseSlotIso(slot) || ""))
      .filter(Boolean) as string[];
    const sortedOfferedTimes = offeredTimes.sort();
    if (options.selectFirstAvailable && offeredSlots.length > 0) {
      const selectedNewStartTime = parseSlotIso(offeredSlots[0]);
      const selectedStartMs = new Date(ensureStockholmOffset(selectedNewStartTime || "")).getTime();
      const selectedTime = getStockholmTimeFromIso(selectedNewStartTime || "");
      if (selectedNewStartTime && selectedTime && Number.isFinite(selectedStartMs)) {
        rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, selectedTime, {
          requestedDaypart: requestedDaypart || undefined,
          selectedNewStartTime,
          selectedEndTime: new Date(selectedStartMs + duration * 60000).toISOString(),
          offeredSlots: [offeredSlots[0]],
          ownedOfferedSlots: canonicalOffers.ownedSlots.slice(0, 1),
          lastOfferedTime: selectedTime,
          lastOperation: "awaiting_confirmation"
        });
        await replyAndRecord(formatRescheduleConfirmation(lockedLanguage, selectedNewStartTime));
        return true;
      }
    }
    rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime, {
      requestedDaypart: requestedDaypart || undefined,
      selectedNewStartTime: undefined,
      selectedEndTime: undefined,
      offeredSlots,
      ownedOfferedSlots: canonicalOffers.ownedSlots,
      lastOfferedTime: sortedOfferedTimes.length > 0
        ? sortedOfferedTimes[sortedOfferedTimes.length - 1]
        : undefined,
      lastOperation: "awaiting_slot_selection"
    });
    await replyAndRecord(formatSwedishTimeSlots(offeredSlots, requestedTime || undefined, lockedLanguage));
    return true;
  };
  // Backward-compatible name retained for existing focused source-level regressions.
  // This now prepares and confirms a verified target; it does not report success.
  const completeReschedule = prepareRescheduleTarget;

  const executeConfirmedReschedule = async (context: RescheduleContext): Promise<boolean> => {
    const lockedLanguage = getRescheduleReplyLanguage(context, text);
    const stateOwner = appointmentStateOwners[sessionId];
    if (
      isRescheduleContextStale(context) ||
      !rescheduleContextOwnerMatches(context, currentAppointmentStateOwner, stateOwner)
    ) {
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
      return true;
    }

    if (context.lastOperation === "updating") return true;
    const candidateIso = String(context.selectedNewStartTime || "");
    const candidateStartMs = new Date(ensureStockholmOffset(candidateIso)).getTime();
    const currentEventId = String(context.exactCalendarEventId || "");
    if (
      !candidateIso ||
      !Number.isFinite(candidateStartMs) ||
      context.originalAppointmentId !== getAppointmentMutationId(context.appointment) ||
      currentEventId !== getAppointmentCalendarEventId(context.appointment)
    ) {
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
      return true;
    }

    const adapter = getCalendarAdapter(businessConfig);
    if (!adapter.updateAppointment || !adapter.getEventById || !supabase) {
      rememberRescheduleContext(sessionId, context.appointment, lockedLanguage, context.requestedDate, context.requestedTime, {
        ...context,
        lastOperation: "update_failed"
      });
      await replyAndRecord(formatRescheduleFailure(lockedLanguage));
      return true;
    }

    // Transition synchronously before the first mutation-path await so another
    // confirmation cannot re-enter fallback or re-render the selected target.
    rememberRescheduleContext(sessionId, context.appointment, lockedLanguage, context.requestedDate, context.requestedTime, {
      ...context,
      lastOperation: "updating"
    });

    const liveAppointment = await validateStoredAppointmentForMutation(
      context.appointment,
      stateOwner!,
      businessConfig,
      adapter
    );
    const requiresDbUpdate = Boolean(
      liveAppointment?.id &&
      liveAppointment?.source === "appointments_table"
    );
    if (
      !liveAppointment ||
      !requiresDbUpdate ||
      getAppointmentMutationId(liveAppointment) !== context.originalAppointmentId ||
      getAppointmentCalendarEventId(liveAppointment) !== currentEventId
    ) {
      clearAppointmentConversationState(sessionId);
      await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
      return true;
    }

    const duration = context.serviceDuration || getAppointmentDurationMinutes(liveAppointment);
    const selectedDate = stockholmDateString(new Date(ensureStockholmOffset(candidateIso)));
    const selectedOwnedOffer = (context.ownedOfferedSlots || []).find(
      (slot) => new Date(slot.start).getTime() === candidateStartMs
    );
    const finalSlotValidation = await validateCanonicalExactSlot({
      adapter,
      owner: currentBookingSlotOwner,
      businessConfig,
      start: candidateIso,
      service: String(context.service || liveAppointment?.service || "Bokning"),
      durationMinutes: duration,
      excludeEventId: currentEventId,
      ...(selectedOwnedOffer ? { offeredSlot: selectedOwnedOffer } : {})
    });
    console.log("[BookingFlow]", {
      platform: platformName,
      businessScopePresent: Boolean(currentBookingSlotOwner.businessId),
      operation: "reschedule",
      stateType: context.lastOperation,
      language: lockedLanguage,
      contactSatisfied: Boolean(context.contactSatisfied),
      offeredSlotCount: context.ownedOfferedSlots?.length || 0,
      selectedSlotStart: candidateIso,
      selectedSlotEnd: context.selectedEndTime || null,
      serviceDuration: duration,
      validatorResultCategory: finalSlotValidation.category,
      ownershipMatch: bookingSlotOwnerMatches(
        selectedOwnedOffer || {
          start: candidateIso,
          end: context.selectedEndTime || "",
          durationMinutes: duration,
          service: context.service,
          businessId: context.businessId,
          platform: context.platform,
          userId: context.userId,
          generatedAt: context.savedAt
        },
        currentBookingSlotOwner
      )
    });
    if (!finalSlotValidation.free) {
      return prepareRescheduleTarget(
        liveAppointment,
        selectedDate,
        getStockholmTimeFromIso(candidateIso),
        lockedLanguage,
        getDaypartSlotOptions(context.requestedDaypart),
        context.requestedDaypart
      );
    }

    const operationEndIso = finalSlotValidation.endIso ||
      new Date(candidateStartMs + duration * 60000).toISOString();
    const operationClaim = await claimAtomicOperation({
      type: "reschedule_operation_claim",
      tenantScope: String(getBusinessIdFromConfig(businessConfig) || ""),
      businessId: String(getBusinessIdFromConfig(businessConfig) || ""),
      platform: platformName,
      exactId: [
        currentAppointmentStateOwner.userId,
        context.originalAppointmentId,
        currentEventId,
        new Date(candidateStartMs).toISOString(),
        operationEndIso
      ].join("|")
    });
    if (!operationClaim.claimed) {
      console.log("[Idempotency] Duplicate reschedule confirmation suppressed.", {
        platform: platformName,
        duplicateStatus: operationClaim.duplicateStatus || "processing"
      });
      if (operationClaim.duplicateStatus === "completed") {
        clearRescheduleContext(sessionId);
        await clearPendingBooking(sessionId);
      } else if (operationClaim.duplicateStatus === "failed") {
        rememberRescheduleContext(sessionId, context.appointment, lockedLanguage, context.requestedDate, context.requestedTime, {
          ...context,
          lastOperation: "update_failed"
        });
      }
      return true;
    }

    rememberRescheduleContext(sessionId, liveAppointment, lockedLanguage, context.requestedDate, context.requestedTime, {
      ...context,
      appointment: liveAppointment,
      lastOperation: "updating"
    });

    const oldStartIso = String(liveAppointment.start || context.originalStartTime || "");
    const oldEndIso = String(liveAppointment.end || "");
    const newStartIso = new Date(candidateStartMs).toISOString();
    const newEndIso = new Date(candidateStartMs + duration * 60000).toISOString();
    const businessId = String(getBusinessIdFromConfig(businessConfig) || "");
    let databaseWasUpdated = false;
    let databaseUpdateAttempted = false;

    const rollbackPersistence = async () => {
      try {
        const calendarRollback = await adapter.updateAppointment!(currentEventId, oldStartIso, duration);
        if (!calendarRollback?.success) {
          console.error("[Reschedule] Calendar rollback failed:", calendarRollback);
        }
      } catch (rollbackError) {
        console.error("[Reschedule] Calendar rollback crashed:", rollbackError);
      }
      if (databaseUpdateAttempted) {
        try {
          let rollbackQuery = supabase
            .from("appointments")
            .update({ start_time: oldStartIso, end_time: oldEndIso })
            .eq("id", liveAppointment.id)
            .eq("business_id", businessId);
          if (liveAppointment.platform) rollbackQuery = rollbackQuery.eq("platform", liveAppointment.platform);
          if (liveAppointment.userId) rollbackQuery = rollbackQuery.eq("user_id", liveAppointment.userId);
          const { error: rollbackError } = await rollbackQuery;
          if (rollbackError) console.error("[Reschedule] Database rollback failed:", rollbackError);
        } catch (rollbackError) {
          console.error("[Reschedule] Database rollback crashed:", rollbackError);
        }
      }
    };

    const updateResult = await adapter.updateAppointment(currentEventId, candidateIso, duration);
    if (!updateResult?.success) {
      await settleAtomicOperation(operationClaim, "failed");
      rememberRescheduleContext(sessionId, liveAppointment, lockedLanguage, context.requestedDate, context.requestedTime, {
        ...context,
        appointment: liveAppointment,
        lastOperation: "update_failed"
      });
      await replyAndRecord(formatRescheduleFailure(lockedLanguage));
      return true;
    }

    databaseUpdateAttempted = true;
    let dbUpdateQuery = supabase
        .from("appointments")
        .update({ start_time: newStartIso, end_time: newEndIso })
        .eq("id", liveAppointment.id)
        .eq("business_id", businessId);
    if (liveAppointment.platform) dbUpdateQuery = dbUpdateQuery.eq("platform", liveAppointment.platform);
    if (liveAppointment.userId) dbUpdateQuery = dbUpdateQuery.eq("user_id", liveAppointment.userId);
    const { data: updatedRow, error: dbUpdateError } = await dbUpdateQuery
      .select("id,customer_name,phone_number,platform,user_id,service,start_time,end_time,status,business_id")
      .maybeSingle();
    databaseWasUpdated = Boolean(updatedRow && !dbUpdateError);

    const updatedRowPlatform = normalizePlatformName(String(updatedRow?.platform || ""));
    const updatedRowUserId = normalizePlatformUserId(updatedRowPlatform, String(updatedRow?.user_id || ""));
    const expectedPlatform = normalizePlatformName(stateOwner!.platform);
    const expectedUserId = normalizePlatformUserId(expectedPlatform, stateOwner!.userId);
    const dbOwnerMatches = Boolean(
      updatedRow &&
      String(updatedRow.business_id || "") === businessId &&
      updatedRowPlatform === expectedPlatform &&
      updatedRowUserId === expectedUserId
    );
    const dbTimeMatches = Boolean(
      updatedRow &&
      new Date(updatedRow.start_time).getTime() === candidateStartMs &&
      new Date(updatedRow.end_time).getTime() === new Date(newEndIso).getTime()
    );

    if (dbUpdateError || !databaseWasUpdated || !dbOwnerMatches || !dbTimeMatches) {
      console.error("[Reschedule] Calendar updated but persisted appointment row did not verify:", {
        dbUpdateError,
        databaseWasUpdated,
        dbOwnerMatches,
        dbTimeMatches
      });
      await rollbackPersistence();
      await settleAtomicOperation(operationClaim, "failed");
      rememberRescheduleContext(sessionId, liveAppointment, lockedLanguage, context.requestedDate, context.requestedTime, {
        ...context,
        appointment: liveAppointment,
        lastOperation: "update_failed"
      });
      await replyAndRecord(formatRescheduleFailure(lockedLanguage));
      return true;
    }

    const verifiedEvent = await adapter.getEventById(currentEventId);
    const verifiedEventStartMs = new Date(getEventStartIso(verifiedEvent)).getTime();
    const eventBusinessMatches = Boolean(
      verifiedEvent &&
      calendarEventBusinessMarkerMatches(verifiedEvent, currentAppointmentStateOwner.businessId)
    );
    const eventIdentityMatches = Boolean(
      verifiedEvent &&
      (
        calendarEventHasExactChannelOwner(verifiedEvent, stateOwner!.platform, stateOwner!.userId) ||
        (
          liveAppointment.source === "appointments_table" &&
          calendarEventHasExactPhone(verifiedEvent, liveAppointment.phone || "")
        )
      )
    );
    const eventTimeMatches = verifiedEventStartMs === candidateStartMs;
    if (!verifiedEvent || !eventBusinessMatches || !eventIdentityMatches || !eventTimeMatches) {
      console.error("[Reschedule] Exact Calendar event verification failed:", {
        eventId: currentEventId,
        eventBusinessMatches,
        eventIdentityMatches,
        eventTimeMatches,
        actualStart: getEventStartIso(verifiedEvent),
        expectedStart: candidateIso
      });
      await rollbackPersistence();
      await settleAtomicOperation(operationClaim, "failed");
      rememberRescheduleContext(sessionId, liveAppointment, lockedLanguage, context.requestedDate, context.requestedTime, {
        ...context,
        appointment: liveAppointment,
        lastOperation: "verification_failed"
      });
      await replyAndRecord(formatRescheduleFailure(lockedLanguage));
      return true;
    }

    // Persist the completed operation claim before any externally visible success side
    // effect. If that durable guard cannot be recorded, roll the verified write back so
    // a later retry cannot duplicate either the customer reply or admin notification.
    const operationCompletionRecorded = await settleAtomicOperation(operationClaim, "completed");
    if (!operationCompletionRecorded) {
      console.error("[Reschedule] Durable operation completion could not be recorded; rolling back.");
      await rollbackPersistence();
      await settleAtomicOperation(operationClaim, "failed");
      rememberRescheduleContext(sessionId, liveAppointment, lockedLanguage, context.requestedDate, context.requestedTime, {
        ...context,
        appointment: liveAppointment,
        lastOperation: "update_failed"
      });
      await replyAndRecord(formatRescheduleFailure(lockedLanguage));
      return true;
    }

    const appointment = {
      ...liveAppointment,
      start: newStartIso,
      end: newEndIso
    };
    appointmentContexts[sessionId] = { appointment, savedAt: Date.now(), language: lockedLanguage };
    saveAppointmentStateOwner(sessionId, currentAppointmentStateOwner, stateOwner.identityKey);
    clearRescheduleContext(sessionId);
    await clearPendingBooking(sessionId);
    clearConversationFlowLanguage(sessionId);
    recentlyCompletedReschedules[sessionId] = {
      completedAt: Date.now(),
      eventId: currentEventId,
      newStartTime: newStartIso
    };

    try {
      await notifyAdminAboutReschedule(
        businessConfig,
        platformLogName,
        businessConfig?.businessName || businessConfig?.business_name || "business",
        appointment.customerName || appointment.name || "Okänd kund",
        appointment.phone || "",
        oldStartIso,
        newStartIso,
        appointment.service
      );
    } catch (notifyError) {
      console.error("[RescheduleNotify] crashed:", notifyError);
    }

    await replyAndRecord(formatRescheduleSuccess(lockedLanguage, newStartIso));
    return true;
  };

  try {
    const priorityCancellation = getCancellationContext(sessionId);
    if (priorityCancellation) {
      const lockedLanguage = getFlowReplyLanguage(
        priorityCancellation.language,
        language,
        text
      );
      const livePolicy = getCancellationPolicy(businessConfig);

      if (
        priorityCancellation.lastOperation === "processing" ||
        priorityCancellation.lastOperation === "completed"
      ) {
        return true;
      }
      if (!livePolicy.allowCancellation) {
        clearCancellationContext(sessionId);
        await replyAndRecord(formatCancellationDisabledDuringFlow(lockedLanguage));
        return true;
      }
      if (isCancellationRejection(text)) {
        clearCancellationContext(sessionId);
        clearConversationFlowLanguage(sessionId);
        await replyAndRecord(
          lockedLanguage === "sv"
            ? "Okej, bokningen behålls."
            : lockedLanguage === "fa"
              ? "باشه، رزرو شما حفظ می‌شود."
              : lockedLanguage === "de"
                ? "Okay, der Termin bleibt bestehen."
                : lockedLanguage === "es"
                  ? "De acuerdo, la cita se mantiene."
                  : lockedLanguage === "ar"
                    ? "حسنًا، سيبقى الموعد كما هو."
                    : "Okay, the appointment will be kept."
        );
        return true;
      }
      if (priorityCancellation.awaitingReason) {
        if (isInvalidCancellationReason(text)) {
          priorityCancellation.savedAt = Date.now();
          await replyAndRecord(formatInvalidCancellationReason(lockedLanguage));
          return true;
        }
        priorityCancellation.reason = normalizeCancellationReason(text);
        priorityCancellation.awaitingReason = false;
        priorityCancellation.lastOperation = "awaiting_confirmation";
        priorityCancellation.savedAt = Date.now();
        await replyAndRecord(
          formatCancellationConfirmation(
            priorityCancellation.appointment,
            lockedLanguage,
            priorityCancellation.feeApplies,
            priorityCancellation.feeAmount,
            priorityCancellation.currency
          )
        );
        return true;
      }
      if (isCancellationConfirmation(text)) {
        return completeCancellation({
          ...priorityCancellation,
          language: lockedLanguage
        });
      }
      await replyAndRecord(
        formatCancellationConfirmation(
          priorityCancellation.appointment,
          lockedLanguage,
          priorityCancellation.feeApplies,
          priorityCancellation.feeAmount,
          priorityCancellation.currency
        )
      );
      return true;
    }

    const recentlyCancelled = getRecentCompletedCancellation(sessionId);
    if (
      recentlyCancelled &&
      !pending &&
      !getCancellationContext(sessionId) &&
      !getRescheduleContext(sessionId) &&
      isCancellationConfirmation(text)
    ) {
      console.log("[Idempotency] Repeated post-cancellation confirmation suppressed.", {
        platform: platformName,
        operation: "cancellation",
        completed: true
      });
      return true;
    }
    const recoveryIntent = isExistingBookingOperationRecoveryIntent(text);
    const priorityReschedule = getRescheduleContext(sessionId);
    if (priorityReschedule) {
      const stateOwner = appointmentStateOwners[sessionId];
      const lockedLanguage = getRescheduleReplyLanguage(priorityReschedule, text);
      if (
        isRescheduleContextStale(priorityReschedule) ||
        !rescheduleContextOwnerMatches(
          priorityReschedule,
          currentAppointmentStateOwner,
          stateOwner
        )
      ) {
        clearAppointmentConversationState(sessionId);
        await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
        return true;
      }
      const temporalState = classifyAppointmentTemporalState(priorityReschedule.appointment);
      if (temporalState !== "future_or_active") {
        clearAppointmentConversationState(sessionId);
        pastAppointmentRecoveryContexts[sessionId] = {
          savedAt: Date.now(),
          language: lockedLanguage,
          owner: currentAppointmentStateOwner
        };
        lockConversationFlowLanguage(sessionId, lockedLanguage, "appointment");
        await replyAndRecord(
          formatPastAppointmentMutationReply(
            priorityReschedule.appointment,
            temporalState,
            lockedLanguage
          )
        );
        return true;
      }

      if (priorityReschedule.lastOperation === "updating") {
        console.log("[BookingFlow]", {
          platform: platformName,
          operation: "reschedule",
          stateType: "updating",
          finalHandledPath: "confirmation_consumed_while_processing"
        });
        return true;
      }

      const timeFollowUp = parseRescheduleTimeFollowUp(text);
      const selectedTime = getStockholmTimeFromIso(priorityReschedule.selectedNewStartTime);
      const rejectsSelectedTime = Boolean(
        timeFollowUp.rejectsCurrentSelection &&
        (
          timeFollowUp.rejectedTimes.length === 0 ||
          !selectedTime ||
          timeFollowUp.rejectedTimes.includes(selectedTime)
        )
      );
      const replacesSelectedTime = Boolean(
        timeFollowUp.explicitTime &&
        timeFollowUp.explicitTime !== selectedTime
      );

      if (
        timeFollowUp.explicitTime &&
        timeFollowUp.explicitTime === selectedTime &&
        isPendingSlotConfirmation(text, {
          status: "awaiting_confirmation",
          dateTime: priorityReschedule.selectedNewStartTime
        })
      ) {
        return executeConfirmedReschedule(priorityReschedule);
      }

      if (timeFollowUp.boundary || replacesSelectedTime || rejectsSelectedTime) {
        const requestedDate = priorityReschedule.requestedDate ||
          (priorityReschedule.selectedNewStartTime
            ? stockholmDateString(new Date(ensureStockholmOffset(priorityReschedule.selectedNewStartTime)))
            : resolveRescheduleDate(text, priorityReschedule.appointment));
        const retainedOffers = (priorityReschedule.offeredSlots || []).filter((slot) => {
          const slotTime = getStockholmTimeFromIso(parseSlotIso(slot) || "");
          return !slotTime || !timeFollowUp.rejectedTimes.includes(slotTime);
        });
        const retainedOwnedOffers = (priorityReschedule.ownedOfferedSlots || []).filter((slot) => {
          const slotTime = getStockholmTimeFromIso(slot.start);
          return !slotTime || !timeFollowUp.rejectedTimes.includes(slotTime);
        });

        rememberRescheduleContext(
          sessionId,
          priorityReschedule.appointment,
          lockedLanguage,
          requestedDate,
          null,
          {
            ...priorityReschedule,
            requestedTime: undefined,
            selectedNewStartTime: undefined,
            selectedEndTime: undefined,
            offeredSlots: retainedOffers,
            ownedOfferedSlots: retainedOwnedOffers,
            lastOfferedTime: undefined,
            lastOperation: "awaiting_target"
          }
        );

        if (requestedDate && timeFollowUp.boundary) {
          const approximateTime = timeFollowUp.boundary.kind === "approximate"
            ? timeFollowUp.boundary.time
            : null;
          return prepareRescheduleTarget(
            priorityReschedule.appointment,
            requestedDate,
            approximateTime,
            lockedLanguage,
            {
              ...getDaypartSlotOptions(priorityReschedule.requestedDaypart),
              timeBoundary: timeFollowUp.boundary,
              excludedTimes: timeFollowUp.rejectedTimes,
              selectFirstAvailable: timeFollowUp.boundary.kind !== "approximate"
            },
            priorityReschedule.requestedDaypart
          );
        }
        if (requestedDate && timeFollowUp.explicitTime) {
          return prepareRescheduleTarget(
            priorityReschedule.appointment,
            requestedDate,
            timeFollowUp.explicitTime,
            lockedLanguage,
            {
              ...getDaypartSlotOptions(priorityReschedule.requestedDaypart),
              excludedTimes: timeFollowUp.rejectedTimes
            },
            priorityReschedule.requestedDaypart
          );
        }

        await replyAndRecord(
          formatRescheduleTimeRejected(
            lockedLanguage,
            selectedTime && rejectsSelectedTime
              ? selectedTime
              : timeFollowUp.rejectedTimes[0]
          )
        );
        return true;
      }

      if (isRescheduleConfirmation(text)) {
        if (
          priorityReschedule.selectedNewStartTime &&
          ["awaiting_confirmation", "update_failed", "verification_failed"].includes(
            priorityReschedule.lastOperation
          )
        ) {
          return executeConfirmedReschedule(priorityReschedule);
        }
        await replyAndRecord(formatChooseRescheduleTime(lockedLanguage));
        return true;
      }

      if (recoveryIntent) {
        if (priorityReschedule.selectedNewStartTime) {
          rememberRescheduleContext(
            sessionId,
            priorityReschedule.appointment,
            lockedLanguage,
            priorityReschedule.requestedDate,
            priorityReschedule.requestedTime,
            { ...priorityReschedule, lastOperation: "awaiting_confirmation" }
          );
          await replyAndRecord(
            formatRescheduleConfirmation(
              lockedLanguage,
              priorityReschedule.selectedNewStartTime
            )
          );
          return true;
        }
        if (Array.isArray(priorityReschedule.offeredSlots) && priorityReschedule.offeredSlots.length > 0) {
          await replyAndRecord(
            formatSwedishTimeSlots(
              priorityReschedule.offeredSlots,
              priorityReschedule.requestedTime,
              lockedLanguage
            )
          );
          return true;
        }
        await replyAndRecord(formatAskRescheduleTarget(lockedLanguage));
        return true;
      }
    } else if (recoveryIntent) {
      const remembered = getAppointmentContext(sessionId);
      const stateOwner = appointmentStateOwners[sessionId];
      if (
        remembered &&
        stateOwner &&
        appointmentStateOwnerMatches(stateOwner, currentAppointmentStateOwner) &&
        getAppointmentMutationId(remembered.appointment) &&
        getAppointmentCalendarEventId(remembered.appointment)
      ) {
        if (pending) {
          await clearPendingBooking(sessionId);
          pending = null;
        }
        const lockedLanguage = getFlowReplyLanguage(remembered.language, language, text);
        rememberRescheduleContext(
          sessionId,
          remembered.appointment,
          lockedLanguage,
          null,
          null,
          { lastOperation: "awaiting_target" }
        );
        await replyAndRecord(formatAskRescheduleTarget(lockedLanguage));
        return true;
      }
    }

    let forcedNewBookingFromRecovery = false;
    let recoveredServiceForNewBooking: string | undefined;
    const pastRecovery = pastAppointmentRecoveryContexts[sessionId];
    if (pastRecovery) {
      const expired = Date.now() - pastRecovery.savedAt > 15 * 60 * 1000;
      const ownerMatches = appointmentStateOwnerMatches(
        pastRecovery.owner,
        currentAppointmentStateOwner
      );
      if (expired || !ownerMatches) {
        delete pastAppointmentRecoveryContexts[sessionId];
      } else if (isAffirmativeBookingText(text)) {
        const recoveryLanguage = getFlowReplyLanguage(
          pastRecovery.language,
          language,
          text
        );
        clearAppointmentConversationState(sessionId);
        await clearPendingBooking(sessionId);
        lockConversationFlowLanguage(sessionId, recoveryLanguage, "booking");
        await replyAndRecord(
          recoveryLanguage === "fa"
            ? "حتماً 😊 برای وقت جدید چه خدماتی و چه روزی مدنظرتان است؟"
            : recoveryLanguage === "sv"
              ? "Absolut 😊 Vilken behandling och vilken dag passar för en ny tid?"
              : "Of course 😊 What service and day would you like for the new appointment?"
        );
        return true;
      } else if (
        isExplicitNewBookingRequest(text) ||
        isAvailabilityPivotFromFailedLookup(text)
      ) {
        forcedNewBookingFromRecovery = true;
        delete pastAppointmentRecoveryContexts[sessionId];
      }
    }

    if (pending && isGreetingOnlyText(text)) {
      console.log(
        `[UnifiedBooking] Fresh greeting cleared stale pending platform=${platformName}, session=${sessionId}, status=${pending.status || "unknown"}`
      );
      await clearPendingBooking(sessionId);
      clearConversationFlowLanguage(sessionId);
      pending = null;
      return false;
    }

    const recoveryContextBeforeIntent = getAppointmentLookupContext(sessionId);
    if (
      recoveryContextBeforeIntent?.nextAction === "offer_new_booking" &&
      isAvailabilityPivotFromFailedLookup(text)
    ) {
      forcedNewBookingFromRecovery = true;
      recoveredServiceForNewBooking =
        recoveryContextBeforeIntent.requestedService;
    }
    const explicitNewBookingRequested =
      isExplicitNewBookingRequest(text) ||
      forcedNewBookingFromRecovery;
    const serviceDurationRequested = isServiceDurationQuestion(text);

    // Service information is not an appointment lookup. This must run before lookup,
    // stale booking cleanup, and Gemini tool dispatch so a post-booking duration question
    // cannot repeat the appointment date/time.
    if (serviceDurationRequested) {
      const serviceContext = getActiveServiceInformationContext(sessionId, text);
      const lockedLanguage = getStoredFlowLanguage(sessionId) || language;
      lockConversationFlowLanguage(sessionId, lockedLanguage, "service_info");
      const durationMinutes = await resolveServiceDurationMinutes(
        serviceContext.service,
        serviceContext.durationMinutes,
        businessConfig
      );
      const reply = formatServiceDurationReply(
        lockedLanguage,
        serviceContext.service || (getDefaultBookingServiceForBusiness(businessConfig) || "service"),
        durationMinutes
      );
      const dedupeKey = `${lockedLanguage}|${serviceContext.service}|${durationMinutes || "unknown"}|${reply}`;
      const previousReply = lastServiceInformationReplies[sessionId];
      if (previousReply?.key === dedupeKey && Date.now() - previousReply.sentAt < 10 * 1000) {
        return true;
      }
      lastServiceInformationReplies[sessionId] = { key: dedupeKey, sentAt: Date.now() };
      await replyAndRecord(reply);
      return true;
    }

    const activeRescheduleForContact = getRescheduleContext(sessionId);
    const suppliedReschedulePhone = normalizeAcceptedPhone(extractPhoneOnly(text) || undefined);
    if (activeRescheduleForContact && suppliedReschedulePhone) {
      const stateOwner = appointmentStateOwners[sessionId];
      const lockedLanguage = getRescheduleReplyLanguage(activeRescheduleForContact, text);
      if (
        isRescheduleContextStale(activeRescheduleForContact) ||
        !rescheduleContextOwnerMatches(
          activeRescheduleForContact,
          currentAppointmentStateOwner,
          stateOwner
        )
      ) {
        clearAppointmentConversationState(sessionId);
        await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
        return true;
      }

      const phoneVerification = await findCustomerAppointments(
        getCalendarAdapter(businessConfig),
        {
          phone: suppliedReschedulePhone,
          lookupPath: "reschedule_phone_verification"
        },
        recipientUserId,
        platformName,
        businessConfig
      );
      const verifiedAppointments = Array.isArray(phoneVerification?.appointments)
        ? phoneVerification.appointments
        : [];
      const phoneMatchesSelectedAppointment = verifiedAppointments.some(
        (appointment: any) =>
          getAppointmentMutationId(appointment) ===
            activeRescheduleForContact.originalAppointmentId &&
          getAppointmentCalendarEventId(appointment) ===
            activeRescheduleForContact.exactCalendarEventId
      );
      if (!phoneMatchesSelectedAppointment) {
        console.warn("[BookingFlow]", {
          platform: platformName,
          businessScopePresent: Boolean(currentAppointmentStateOwner.businessId),
          operation: "reschedule_contact",
          stateType: activeRescheduleForContact.lastOperation,
          language: lockedLanguage,
          contactSatisfied: false,
          phoneCorrelation: maskPhoneForDiagnostic(suppliedReschedulePhone),
          ownershipMatch: false,
          finalHandledPath: "phone_verification_failed"
        });
        await replyAndRecord(
          lockedLanguage === "fa"
            ? "این شماره با رزرو انتخاب‌شده مطابقت نداشت. لطفاً همان شماره‌ای را بفرستید که با آن رزرو کرده‌اید."
            : lockedLanguage === "sv"
              ? "Numret matchade inte den valda bokningen. Skicka numret som användes när tiden bokades."
              : "That number did not match the selected booking. Please send the number used for the booking."
        );
        return true;
      }

      const enrichedAppointment = {
        ...activeRescheduleForContact.appointment,
        phone: activeRescheduleForContact.appointment?.phone || suppliedReschedulePhone
      };
      rememberRescheduleContext(
        sessionId,
        enrichedAppointment,
        lockedLanguage,
        activeRescheduleForContact.requestedDate,
        activeRescheduleForContact.requestedTime,
        {
          ...activeRescheduleForContact,
          appointment: enrichedAppointment,
          verifiedPhone: suppliedReschedulePhone,
          contactSatisfied: true,
          savedAt: Date.now()
        }
      );
      const enrichedContext = getRescheduleContext(sessionId)!;
      console.log("[BookingFlow]", {
        platform: platformName,
        businessScopePresent: Boolean(currentAppointmentStateOwner.businessId),
        operation: "reschedule_contact",
        stateType: enrichedContext.lastOperation,
        language: lockedLanguage,
        contactSatisfied: true,
        phoneCorrelation: maskPhoneForDiagnostic(suppliedReschedulePhone),
        offeredSlotCount: enrichedContext.ownedOfferedSlots?.length || 0,
        ownershipMatch: true,
        finalHandledPath: "reschedule_contact_enrichment"
      });

      if (enrichedContext.selectedNewStartTime) {
        await replyAndRecord(
          formatRescheduleConfirmation(lockedLanguage, enrichedContext.selectedNewStartTime)
        );
        return true;
      }
      if (enrichedContext.requestedDate && enrichedContext.requestedTime) {
        return prepareRescheduleTarget(
          enrichedContext.appointment,
          enrichedContext.requestedDate,
          enrichedContext.requestedTime,
          lockedLanguage,
          getDaypartSlotOptions(enrichedContext.requestedDaypart),
          enrichedContext.requestedDaypart
        );
      }
      if (Array.isArray(enrichedContext.offeredSlots) && enrichedContext.offeredSlots.length > 0) {
        await replyAndRecord(
          formatSwedishTimeSlots(enrichedContext.offeredSlots, undefined, lockedLanguage)
        );
        return true;
      }
      const ask = enrichedContext.requestedDate
        ? formatAskRescheduleTimeForDate(lockedLanguage)
        : formatAskRescheduleTarget(lockedLanguage);
      await replyAndRecord(ask);
      return true;
    }

    if (pending && (explicitNewBookingRequested || isNewBookingRequestText(text))) {
      console.log(`[UnifiedBooking] Clearing stale pending platform=${platformName}, session=${sessionId}`);
      await clearPendingBooking(sessionId);
      pending = null;
    }

    // Appointment lookup must win over any stale pending new-booking flow.
    // Otherwise Messenger can keep asking for name/mobile when the customer only asks
    // whether they already have an appointment.
    const lookupContextForIntent = getAppointmentLookupContext(sessionId);
    const activeRescheduleForIntent = getRescheduleContext(sessionId);
    const appointmentLookupFollowUpRequested = !activeRescheduleForIntent && Boolean(
      getAppointmentContext(sessionId) ||
      getAppointmentSelectionContext(sessionId) ||
      lookupContextForIntent
    ) && (
      isAppointmentLookupFollowUp(text) ||
      /\b(igår|igar|yesterday)\b/i.test(text) ||
      Boolean(lookupContextForIntent?.historyWindowLimited && isOlderAppointmentHistoryConfirmation(text)) ||
      extractExplicitAppointmentLookupDates(text).length > 0
    );
    const appointmentLookupRequested = !explicitNewBookingRequested &&
      (isExistingAppointmentLookupIntent(text) || appointmentLookupFollowUpRequested);
    if (appointmentLookupRequested) lockConversationFlowLanguage(sessionId, language, "appointment");
    if (pending && appointmentLookupRequested) {
      console.log(`[UnifiedBooking] Appointment lookup cleared pending new-booking state platform=${platformName}, session=${sessionId}`);
      await clearPendingBooking(sessionId);
      pending = null;
    }

    // Rescheduling an existing appointment must always win over a stale/new-booking flow.
    // Never ask again for service, duration, name or phone when an existing booking can be found.
    const rescheduleRequested = !explicitNewBookingRequested && isRescheduleIntent(text);
    const cancellationRequested = !explicitNewBookingRequested && isCancellationIntent(text);
    if (rescheduleRequested) lockConversationFlowLanguage(sessionId, language, "reschedule");
    if (cancellationRequested) lockConversationFlowLanguage(sessionId, language, "cancellation");

    // A direct lookup question must interrupt an unfinished reschedule flow.
    // Example: customer first asks to reschedule, then asks "when is my appointment?".
    if (appointmentLookupRequested && isExistingAppointmentLookupIntent(text)) {
      clearRescheduleContext(sessionId);
      clearCancellationContext(sessionId);
    }

    if (pending && rescheduleRequested) {
      console.log(`[UnifiedBooking] Reschedule intent cleared pending new-booking state platform=${platformName}, session=${sessionId}`);
      await clearPendingBooking(sessionId);
      pending = null;
    }

    if (pending && cancellationRequested) {
      console.log(`[UnifiedBooking] Cancellation intent cleared pending new-booking state platform=${platformName}, session=${sessionId}`);
      await clearPendingBooking(sessionId);
      pending = null;
    }

    if (rescheduleRequested) clearCancellationContext(sessionId);
    if (cancellationRequested) clearRescheduleContext(sessionId);
    if (
      !appointmentLookupRequested &&
      !rescheduleRequested &&
      !cancellationRequested &&
      (explicitNewBookingRequested || isNewBookingRequestText(text))
    ) {
      clearAppointmentConversationState(sessionId);
    }

    let rememberedAppointment = getAppointmentContext(sessionId);
    if (rememberedAppointment && (rescheduleRequested || cancellationRequested)) {
      const temporalState = classifyAppointmentTemporalState(
        rememberedAppointment.appointment
      );
      if (temporalState !== "future_or_active") {
        const lockedLanguage = getFlowReplyLanguage(
          rememberedAppointment.language,
          language,
          text
        );
        const expiredAppointment = rememberedAppointment.appointment;
        clearAppointmentConversationState(sessionId);
        await clearPendingBooking(sessionId);
        pastAppointmentRecoveryContexts[sessionId] = {
          savedAt: Date.now(),
          language: lockedLanguage,
          owner: currentAppointmentStateOwner
        };
        lockConversationFlowLanguage(sessionId, lockedLanguage, "appointment");
        await replyAndRecord(
          formatPastAppointmentMutationReply(
            expiredAppointment,
            temporalState,
            lockedLanguage
          )
        );
        return true;
      }
    }

    // Memory is in-process and may be empty after deploy/restart. Recover the customer's
    // existing booking directly from Supabase/Google Calendar before handling the change.
    if (!pending && !rememberedAppointment && (rescheduleRequested || cancellationRequested)) {
      const adapter = getCalendarAdapter(businessConfig);
      const lookupContact = extractNameAndPhone(text);
      const initialIdentification = getLookupIdentificationDetails(text);
      const retainInitialDateTime =
        isExistingBookingIdentificationStatement(text) ||
        isPastAppointmentLookupIntent(text);
      const mutationLookup = await findOwnedAppointmentForMutation(
        adapter,
        {
          name: lookupContact?.name || extractNameOnly(text) || undefined,
          phone: lookupContact?.phone || extractPhoneOnly(text) || undefined,
          ...(retainInitialDateTime && initialIdentification.requestedDate
            ? {
                requestedDate: initialIdentification.requestedDate,
                startDate: initialIdentification.requestedDate,
                endDate: initialIdentification.requestedDate
              }
            : {}),
          ...(retainInitialDateTime && initialIdentification.approximateTime
            ? { approximateTime: initialIdentification.approximateTime }
            : {}),
          ...(initialIdentification.requestedService
            ? { service: initialIdentification.requestedService }
            : {}),
          secureRecovery: true,
          lookupPath: "unified_mutation_recovery"
        },
        recipientUserId,
        platformName,
        businessConfig
      );
      const lookupResult = mutationLookup.result;

      if (mutationLookup.pastAppointment && mutationLookup.temporalState) {
        const lockedLanguage = getStoredFlowLanguage(sessionId) || language;
        clearAppointmentConversationState(sessionId);
        await clearPendingBooking(sessionId);
        pastAppointmentRecoveryContexts[sessionId] = {
          savedAt: Date.now(),
          language: lockedLanguage,
          owner: currentAppointmentStateOwner
        };
        lockConversationFlowLanguage(sessionId, lockedLanguage, "appointment");
        await replyAndRecord(
          formatPastAppointmentMutationReply(
            mutationLookup.pastAppointment,
            mutationLookup.temporalState,
            lockedLanguage
          )
        );
        return true;
      }

      rememberAppointmentContext(sessionId, lookupResult, language, currentAppointmentStateOwner);
      rememberedAppointment = getAppointmentContext(sessionId);

      if (!rememberedAppointment) {
        const selectionContext = getAppointmentSelectionContext(sessionId);
        if (selectionContext) {
          selectionContext.intent = rescheduleRequested ? "reschedule" : cancellationRequested ? "cancel" : "lookup";
          selectionContext.language = language;
          selectionContext.savedAt = Date.now();
        } else {
          const suppliedPhone = normalizeAcceptedPhone(
            lookupContact?.phone || extractPhoneOnly(text) || undefined
          );
          const verifiedPhoneAccepted = Boolean(lookupResult?.verifiedPhoneAccepted && suppliedPhone);
          const phoneWasReceived = Boolean(suppliedPhone);
          rememberAppointmentLookupContext(
            sessionId,
            language,
            false,
            lookupResult?.lookupMode || "upcoming",
            Boolean(lookupResult?.historyWindowLimited),
            {
              operation: rescheduleRequested ? "reschedule" : "cancel",
              verifiedPhone: verifiedPhoneAccepted ? suppliedPhone! : undefined,
              receivedPhone: suppliedPhone || undefined,
              receivedName: initialIdentification.name,
              requestedDate: retainInitialDateTime
                ? initialIdentification.requestedDate
                : undefined,
              approximateTime: retainInitialDateTime
                ? initialIdentification.approximateTime
                : undefined,
              requestedService: initialIdentification.requestedService,
              recoveryMode: true,
              recoveryPromptCount: phoneWasReceived && !verifiedPhoneAccepted
                ? 1
                : 0,
              phoneReceivedAt: suppliedPhone ? Date.now() : undefined,
              lookupAttemptedAt: Date.now(),
              resultCategory: lookupResult?.secureRecoveryAmbiguous
                ? "recovery_ambiguous"
                : verifiedPhoneAccepted
                ? "verified_not_found"
                : phoneWasReceived
                  ? initialIdentification.name ||
                    (
                      retainInitialDateTime &&
                      initialIdentification.requestedDate &&
                      initialIdentification.approximateTime
                    )
                    ? "recovery_not_found"
                    : "recovery_needs_attribute"
                  : "needs_verified_phone",
              nextAction: lookupResult?.secureRecoveryAmbiguous
                ? "clarify_recovery"
                : verifiedPhoneAccepted
                  ? "offer_new_booking"
                  : phoneWasReceived
                    ? initialIdentification.name ||
                      (
                        retainInitialDateTime &&
                        initialIdentification.requestedDate &&
                        initialIdentification.approximateTime
                      )
                      ? "offer_new_booking"
                      : "awaiting_recovery_attribute"
                    : "awaiting_verified_phone"
            }
          );
          if (phoneWasReceived && !verifiedPhoneAccepted) {
            await replyAndRecord(
              formatSecureRecoveryPrompt(
                language,
                lookupResult?.secureRecoveryAmbiguous
                  ? "ambiguous"
                  : initialIdentification.name ||
                      (
                        retainInitialDateTime &&
                        initialIdentification.requestedDate &&
                        initialIdentification.approximateTime
                      )
                    ? "not_found"
                    : "need_attribute"
              )
            );
            return true;
          }
        }
        await replyAndRecord(formatAppointmentLookupReply(lookupResult, language));
        return true;
      }
    }

    if (!pending && rememberedAppointment && isAppointmentNameQuestion(text)) {
      await replyAndRecord(
        formatAppointmentNameReply(
          rememberedAppointment.appointment,
          getFlowReplyLanguage(rememberedAppointment.language, language, text)
        )
      );
      return true;
    }

    if (!pending && rememberedAppointment && cancellationRequested) {
      const lockedLanguage = getFlowReplyLanguage(rememberedAppointment.language, language, text);
      clearRescheduleContext(sessionId);
      const policy = getCancellationPolicy(businessConfig);
      if (!policy.allowCancellation) {
        await replyAndRecord(formatCancellationDisabled(lockedLanguage));
        return true;
      }
      const startMs = new Date(String(rememberedAppointment.appointment?.start || "")).getTime();
      if (Number.isFinite(startMs) && startMs <= Date.now()) {
        await replyAndRecord(lockedLanguage === "sv" ? "Den tiden har redan börjat eller passerat och kan inte avbokas automatiskt." : lockedLanguage === "fa" ? "این نوبت شروع شده یا گذشته است و به‌صورت خودکار قابل لغو نیست." : "That appointment has already started or passed and cannot be cancelled automatically.");
        return true;
      }
      rememberCancellationContext(sessionId, rememberedAppointment.appointment, lockedLanguage, businessConfig);
      await replyAndRecord(formatCancellationReasonQuestion(lockedLanguage));
      return true;
    }

    const existingRescheduleContext = !pending ? getRescheduleContext(sessionId) : null;
    const rescheduleCorrectionRequested = isRescheduleDateCorrection(text);

    if (!pending && !existingRescheduleContext && rememberedAppointment && (rescheduleRequested || rescheduleCorrectionRequested)) {
      const appointment = rememberedAppointment.appointment;
      const requestedDate = resolveRescheduleDate(text, appointment);
      const requestedTime = inferRequestedTimeFromText(text) || (
        rescheduleCorrectionRequested ? getStockholmTimeFromIso(appointment.start) : null
      );
      const requestedDaypart = inferRequestedDaypart(text);
      const lockedLanguage = getFlowReplyLanguage(rememberedAppointment.language, language, text);

      if (!requestedDate) {
        rememberRescheduleContext(sessionId, appointment, lockedLanguage, requestedDate, requestedTime, {
          requestedDaypart: requestedDaypart || undefined,
          lastOperation: "awaiting_target"
        });
        const ask = requestedTime
          ? formatAskRescheduleDayForTime(lockedLanguage, requestedTime)
          : formatAskRescheduleTarget(lockedLanguage);
        await replyAndRecord(ask);
        return true;
      }

      if (!requestedDaypart) {
        return completeReschedule(appointment, requestedDate, requestedTime, lockedLanguage);
      }
      return prepareRescheduleTarget(
        appointment,
        requestedDate,
        requestedTime,
        lockedLanguage,
        getDaypartSlotOptions(requestedDaypart),
        requestedDaypart
      );
    }

    const activeReschedule = existingRescheduleContext;
    if (activeReschedule) {
      const lockedLanguage = getRescheduleReplyLanguage(activeReschedule, text);
      const stateOwner = appointmentStateOwners[sessionId];
      if (
        isRescheduleContextStale(activeReschedule) ||
        !rescheduleContextOwnerMatches(activeReschedule, currentAppointmentStateOwner, stateOwner)
      ) {
        clearAppointmentConversationState(sessionId);
        await replyAndRecord(formatStaleAppointmentStateMessage(lockedLanguage));
        return true;
      }

      if (isCancellationRejection(text)) {
        clearRescheduleContext(sessionId);
        clearConversationFlowLanguage(sessionId);
        await replyAndRecord(lockedLanguage === "sv"
          ? "Okej, bokningen behålls på sin nuvarande tid."
          : lockedLanguage === "fa"
            ? "باشه، رزرو در زمان فعلی باقی می‌ماند."
            : "Okay, the appointment will remain at its current time.");
        return true;
      }

      if (isRescheduleConfirmation(text)) {
        if (
          activeReschedule.selectedNewStartTime &&
          (
            activeReschedule.lastOperation === "awaiting_confirmation" ||
            activeReschedule.lastOperation === "update_failed" ||
            activeReschedule.lastOperation === "verification_failed"
          )
        ) {
          return executeConfirmedReschedule(activeReschedule);
        }
        await replyAndRecord(formatChooseRescheduleTime(lockedLanguage));
        return true;
      }

      if (isLaterRescheduleRequest(text)) {
        const requestedDate = activeReschedule.requestedDate ||
          resolveRescheduleDate(text, activeReschedule.appointment);
        if (!requestedDate) {
          await replyAndRecord(lockedLanguage === "fa"
            ? "حتماً 😊 برای کدوم روز زمان دیرتری می‌خواهید؟"
            : lockedLanguage === "sv"
              ? "Absolut 😊 Vilken dag vill du ha en senare tid?"
              : "Of course 😊 Which day would you like a later time?");
          return true;
        }
        const afterTime = activeReschedule.lastOfferedTime ||
          activeReschedule.requestedTime ||
          getStockholmTimeFromIso(activeReschedule.appointment.start) ||
          undefined;
        return prepareRescheduleTarget(
          activeReschedule.appointment,
          requestedDate,
          null,
          lockedLanguage,
          {
            ...getDaypartSlotOptions(activeReschedule.requestedDaypart),
            ...(afterTime ? { afterTime } : {}),
            selectFirstAvailable: true
          },
          activeReschedule.requestedDaypart
        );
      }

      const selectedOfferedIso = selectRescheduleOfferedSlot(
        text,
        activeReschedule.offeredSlots || []
      );
      if (selectedOfferedIso) {
        const selectedDate = stockholmDateString(new Date(ensureStockholmOffset(selectedOfferedIso)));
        const selectedTime = getStockholmTimeFromIso(selectedOfferedIso);
        if (selectedTime) {
          return prepareRescheduleTarget(
            activeReschedule.appointment,
            selectedDate,
            selectedTime,
            lockedLanguage,
            getDaypartSlotOptions(activeReschedule.requestedDaypart),
            activeReschedule.requestedDaypart
          );
        }
      }

      const explicitDate = resolveExplicitBookingDate(text);
      const resolvedDate = resolveRescheduleDate(text, activeReschedule.appointment);
      const parsedTime = inferRequestedTimeFromText(text);
      const parsedDaypart = inferRequestedDaypart(text);
      const hasSameDayExpression = /\b(samma dag|samma datum|den dagen|same day|same date|hamon rooz|hamoon rooz|همان روز|همون روز)\b/i.test(text);
      const hasDateExpression = Boolean(explicitDate || hasSameDayExpression);
      const requestedDate = hasDateExpression
        ? resolvedDate
        : parsedTime && activeReschedule.requestedDate
          ? activeReschedule.requestedDate
          : resolvedDate || activeReschedule.requestedDate || null;
      const requestedTime = parsedDaypart
        ? null
        : parsedTime || (
            hasDateExpression ? activeReschedule.requestedTime || null : activeReschedule.requestedTime || null
          );
      const requestedDaypart = parsedDaypart || activeReschedule.requestedDaypart || null;

      if (requestedDate && requestedTime) {
        return prepareRescheduleTarget(
          activeReschedule.appointment,
          requestedDate,
          requestedTime,
          lockedLanguage,
          getDaypartSlotOptions(requestedDaypart),
          requestedDaypart
        );
      }

      if (requestedDate) {
        return prepareRescheduleTarget(
          activeReschedule.appointment,
          requestedDate,
          null,
          lockedLanguage,
          getDaypartSlotOptions(requestedDaypart),
          requestedDaypart
        );
      }

      rememberRescheduleContext(
        sessionId,
        activeReschedule.appointment,
        lockedLanguage,
        requestedDate,
        requestedTime,
        {
          requestedDaypart: requestedDaypart || undefined,
          lastOperation: "awaiting_target"
        }
      );
      const ask = requestedTime
        ? formatAskRescheduleDayForTime(lockedLanguage, requestedTime)
        : formatAskRescheduleTarget(lockedLanguage);
      await replyAndRecord(ask);
      return true;
    }

    const activeSelectionContext = !pending && !appointmentLookupRequested
      ? getAppointmentSelectionContext(sessionId)
      : null;

    if (activeSelectionContext) {
      const lockedLanguage = getFlowReplyLanguage(
        activeSelectionContext.language,
        language,
        text
      );

      if (isMissedPastAppointmentsIntent(text)) {
        const pastAppointments = activeSelectionContext.appointments.filter((appointment: any) => {
          const startMs = new Date(appointment?.start || "").getTime();
          return Number.isFinite(startMs) && startMs < Date.now();
        });

        if (pastAppointments.length > 0) {
          clearAppointmentSelectionContext(sessionId);
          clearAppointmentLookupContext(sessionId);
          await replyAndRecord(
            formatMissedPastAppointmentsReply(pastAppointments, lockedLanguage)
          );
          return true;
        }
      }

      const selection = selectAppointmentFromText(text, activeSelectionContext.appointments);

      if (selection?.type === "all") {
        const message = cancellationRequested || activeSelectionContext.intent === "cancel"
          ? (lockedLanguage === "sv" ? "För säkerhets skull kan jag bara avboka en bokning åt gången. Svara med numret eller namnet på bokningen du vill avboka." : lockedLanguage === "fa" ? "برای امنیت، هر بار فقط یک رزرو قابل لغو است. شماره یا نام رزروی را که می‌خواهید لغو کنید بفرستید." : "For safety, I can only cancel one appointment at a time. Reply with the number or name of the appointment to cancel.")
          : formatAllAppointmentsSelectedReply(lockedLanguage);
        await replyAndRecord(message);
        return true;
      }

      if (selection?.type === "one") {
        appointmentContexts[sessionId] = {
          appointment: selection.appointment,
          savedAt: Date.now(),
          language: lockedLanguage
        };
        clearAppointmentSelectionContext(sessionId);
        if (cancellationRequested || activeSelectionContext.intent === "cancel") {
          const policy = getCancellationPolicy(businessConfig);
          if (!policy.allowCancellation) {
            await replyAndRecord(formatCancellationDisabled(lockedLanguage));
            return true;
          }
          rememberCancellationContext(sessionId, selection.appointment, lockedLanguage, businessConfig);
          await replyAndRecord(formatCancellationReasonQuestion(lockedLanguage));
          return true;
        }
        if (rescheduleRequested || activeSelectionContext.intent === "reschedule") {
          const requestedDate = resolveRescheduleDate(text, selection.appointment);
          const requestedTime = inferRequestedTimeFromText(text);
          const requestedDaypart = inferRequestedDaypart(text);
          if (requestedDate) {
            return prepareRescheduleTarget(
              selection.appointment,
              requestedDate,
              requestedTime,
              lockedLanguage,
              getDaypartSlotOptions(requestedDaypart),
              requestedDaypart
            );
          }
          rememberRescheduleContext(sessionId, selection.appointment, lockedLanguage, requestedDate, requestedTime, {
            requestedDaypart: requestedDaypart || undefined,
            lastOperation: "awaiting_target"
          });
          await replyAndRecord(formatAskRescheduleTarget(lockedLanguage));
          return true;
        }
        await replyAndRecord(
          formatAppointmentLookupReply(
            { found: true, needsContactDetails: false, appointments: [selection.appointment] },
            lockedLanguage
          )
        );
        return true;
      }

      await replyAndRecord(
        formatAppointmentSelectionPrompt(
          { found: true, needsContactDetails: false, appointments: activeSelectionContext.appointments },
          lockedLanguage
        ) || formatAllAppointmentsSelectedReply(lockedLanguage)
      );
      return true;
    }

    const activeLookupContext = !pending ? getAppointmentLookupContext(sessionId) : null;
    const lookupIdentification = activeLookupContext
      ? getLookupIdentificationDetails(text, activeLookupContext)
      : null;
    const followUpName = lookupIdentification?.name || null;
    const followUpPhone = lookupIdentification?.phone || null;
    const followUpRequestedDate = lookupIdentification?.requestedDate || null;
    const followUpApproximateTime = lookupIdentification?.approximateTime || null;
    const followUpRequestedService = lookupIdentification?.requestedService || null;
    const hasLookupIdentificationUpdate = Boolean(
      lookupIdentification?.hasNewDateOrTime ||
      (
        followUpName &&
        followUpName !== activeLookupContext?.receivedName
      ) ||
      (
        followUpPhone &&
        normalizeLookupDigits(followUpPhone) !==
          normalizeLookupDigits(activeLookupContext?.receivedPhone)
      ) ||
      (
        followUpRequestedService &&
        followUpRequestedService !== activeLookupContext?.requestedService
      )
    );
    const normalizedFollowUpPhone = normalizeAcceptedPhone(followUpPhone || undefined);
    const repeatsReceivedPhone = Boolean(
      normalizedFollowUpPhone &&
      activeLookupContext?.receivedPhone &&
      normalizeLookupDigits(normalizedFollowUpPhone) ===
        normalizeLookupDigits(activeLookupContext.receivedPhone)
    );

    if (
      !pending &&
      activeLookupContext &&
      (
        activeLookupContext.nextAction === "awaiting_recovery_attribute" ||
        activeLookupContext.nextAction === "clarify_recovery"
      ) &&
      !hasLookupIdentificationUpdate
    ) {
      const lockedLanguage = activeLookupContext.language || language;
      const promptCount = Number(activeLookupContext.recoveryPromptCount || 1);
      if (
        repeatsReceivedPhone &&
        activeLookupContext.nextAction === "awaiting_recovery_attribute"
      ) {
        rememberAppointmentLookupContext(
          sessionId,
          lockedLanguage,
          Boolean(activeLookupContext.includePast),
          activeLookupContext.lookupMode ||
            (activeLookupContext.includePast ? "history" : "upcoming"),
          Boolean(activeLookupContext.historyWindowLimited),
          {
            ...activeLookupContext,
            resultCategory: "recovery_needs_attribute",
            nextAction: "awaiting_recovery_attribute",
            lastPromptKey: "need_attribute",
            recoveryPromptCount: promptCount + 1
          }
        );
        await replyAndRecord(
          formatSecureRecoveryPrompt(lockedLanguage, "need_attribute")
        );
        return true;
      }
      if (promptCount >= 1) {
        rememberAppointmentLookupContext(
          sessionId,
          lockedLanguage,
          Boolean(activeLookupContext.includePast),
          activeLookupContext.lookupMode ||
            (activeLookupContext.includePast ? "history" : "upcoming"),
          Boolean(activeLookupContext.historyWindowLimited),
          {
            ...activeLookupContext,
            resultCategory: "recovery_not_found",
            nextAction: "offer_new_booking",
            lastPromptKey: "not_found",
            recoveryPromptCount: promptCount + 1
          }
        );
        await replyAndRecord(
          formatSecureRecoveryPrompt(lockedLanguage, "not_found")
        );
        return true;
      }
    }

    if (
      !pending &&
      activeLookupContext?.nextAction === "offer_new_booking" &&
      !hasLookupIdentificationUpdate &&
      (!followUpPhone || repeatsReceivedPhone)
    ) {
      const lockedLanguage = activeLookupContext.language || language;
      if (isAffirmativeBookingText(text) || isExplicitNewBookingRequest(text)) {
        clearAppointmentConversationState(sessionId);
        await clearPendingBooking(sessionId);
        lockConversationFlowLanguage(sessionId, lockedLanguage, "booking");
        await replyAndRecord(
          lockedLanguage === "fa"
            ? "حتماً 😊 برای وقت جدید چه خدماتی و چه روزی مدنظرتان است؟"
            : lockedLanguage === "sv"
              ? "Absolut 😊 Vilken behandling och vilken dag passar för en ny tid?"
              : lockedLanguage === "de"
                ? "Gern 😊 Welche Behandlung und welcher Tag passen für einen neuen Termin?"
                : lockedLanguage === "es"
                  ? "Claro 😊 ¿Qué servicio y qué día prefieres para una nueva cita?"
                  : lockedLanguage === "ar"
                    ? "بالتأكيد 😊 ما الخدمة واليوم المناسبان للموعد الجديد؟"
                    : "Of course 😊 What service and day would you like for a new appointment?"
        );
        return true;
      }
      await replyAndRecord(
        activeLookupContext.resultCategory === "recovery_not_found" ||
          activeLookupContext.resultCategory === "recovery_needs_attribute" ||
          activeLookupContext.resultCategory === "recovery_ambiguous"
          ? formatSecureRecoveryPrompt(
              lockedLanguage,
              activeLookupContext.resultCategory === "recovery_ambiguous"
                ? "ambiguous"
                : activeLookupContext.resultCategory === "recovery_needs_attribute"
                  ? "need_attribute"
                  : "not_found"
            )
          : activeLookupContext.resultCategory === "phone_unverified"
          ? formatUnverifiedPhoneLookupReply(lockedLanguage)
          : formatVerifiedPhoneNoAppointment(
              lockedLanguage,
              activeLookupContext.lookupMode || "upcoming"
            )
      );
      return true;
    }

    if (
      !pending &&
      activeLookupContext &&
      (activeLookupContext.operation === "reschedule" ||
        activeLookupContext.operation === "cancel") &&
      lookupIdentification?.hasNewDateOrTime &&
      !followUpName &&
      !followUpPhone
    ) {
      const lockedLanguage = activeLookupContext.language || language;
      rememberAppointmentLookupContext(
        sessionId,
        lockedLanguage,
        Boolean(activeLookupContext.includePast),
        activeLookupContext.lookupMode ||
          (activeLookupContext.includePast ? "history" : "upcoming"),
        Boolean(activeLookupContext.historyWindowLimited),
        {
          ...activeLookupContext,
          requestedDate:
            followUpRequestedDate || activeLookupContext.requestedDate,
          approximateTime:
            followUpApproximateTime || activeLookupContext.approximateTime,
          recoveryMode: true,
          recoveryPromptCount: Number(activeLookupContext.recoveryPromptCount || 0) + 1,
          resultCategory: "needs_verified_phone",
          nextAction: "awaiting_verified_phone"
        }
      );
      lockConversationFlowLanguage(sessionId, lockedLanguage, "appointment");
      await replyAndRecord(
        formatSecureRecoveryPrompt(lockedLanguage, "missing_identifier")
      );
      return true;
    }

    if (
      !pending &&
      activeLookupContext &&
      (activeLookupContext.operation === "reschedule" || activeLookupContext.operation === "cancel") &&
      (
        followUpName ||
        followUpPhone ||
        appointmentLookupFollowUpRequested ||
        hasLookupIdentificationUpdate
      )
    ) {
      const adapter = getCalendarAdapter(businessConfig);
      const lockedLanguage = activeLookupContext.language || language;
      const normalizedPhone = normalizeAcceptedPhone(followUpPhone || undefined);
      const mutationLookup = await findOwnedAppointmentForMutation(
        adapter,
        {
          name: followUpName || undefined,
          phone: normalizedPhone || undefined,
          requestedDate: followUpRequestedDate || undefined,
          startDate: followUpRequestedDate || undefined,
          endDate: followUpRequestedDate || undefined,
          approximateTime: followUpApproximateTime || undefined,
          service: followUpRequestedService || undefined,
          secureRecovery: true,
          lookupPath: "unified_mutation_lookup_follow_up"
        },
        recipientUserId,
        platformName,
        businessConfig
      );
      const lookupResult = mutationLookup.result;

      if (mutationLookup.pastAppointment && mutationLookup.temporalState) {
        clearAppointmentConversationState(sessionId);
        await clearPendingBooking(sessionId);
        pastAppointmentRecoveryContexts[sessionId] = {
          savedAt: Date.now(),
          language: lockedLanguage,
          owner: currentAppointmentStateOwner
        };
        lockConversationFlowLanguage(sessionId, lockedLanguage, "appointment");
        await replyAndRecord(
          formatPastAppointmentMutationReply(
            mutationLookup.pastAppointment,
            mutationLookup.temporalState,
            lockedLanguage
          )
        );
        return true;
      }

      rememberAppointmentContext(
        sessionId,
        lookupResult,
        lockedLanguage,
        currentAppointmentStateOwner
      );
      const recoveredAppointment = getAppointmentContext(sessionId);
      const selectionContext = getAppointmentSelectionContext(sessionId);
      if (selectionContext) {
        selectionContext.intent = activeLookupContext.operation;
        selectionContext.language = lockedLanguage;
        selectionContext.savedAt = Date.now();
        clearAppointmentLookupContext(sessionId);
        await replyAndRecord(
          formatAppointmentSelectionPrompt(lookupResult, lockedLanguage) ||
          formatAllAppointmentsSelectedReply(lockedLanguage)
        );
        return true;
      }

      if (recoveredAppointment) {
        clearAppointmentLookupContext(sessionId);
        if (activeLookupContext.operation === "reschedule") {
          rememberRescheduleContext(
            sessionId,
            recoveredAppointment.appointment,
            lockedLanguage,
            null,
            null,
            { lastOperation: "awaiting_target" }
          );
          await replyAndRecord(formatAskRescheduleTarget(lockedLanguage));
          return true;
        }

        const policy = getCancellationPolicy(businessConfig);
        if (!policy.allowCancellation) {
          await replyAndRecord(formatCancellationDisabled(lockedLanguage));
          return true;
        }
        rememberCancellationContext(
          sessionId,
          recoveredAppointment.appointment,
          lockedLanguage,
          businessConfig
        );
        await replyAndRecord(formatCancellationReasonQuestion(lockedLanguage));
        return true;
      }

      const verifiedPhoneAccepted = Boolean(
        lookupResult?.verifiedPhoneAccepted && normalizedPhone
      );
      const phoneWasReceived = Boolean(normalizedPhone);
      const hasRecoveryAttribute = Boolean(
        followUpName ||
        (followUpRequestedDate && followUpApproximateTime)
      );
      const recoveryAmbiguous = Boolean(lookupResult?.secureRecoveryAmbiguous);
      rememberAppointmentLookupContext(
        sessionId,
        lockedLanguage,
        false,
        lookupResult?.lookupMode || activeLookupContext.lookupMode || "upcoming",
        Boolean(lookupResult?.historyWindowLimited),
        {
          operation: activeLookupContext.operation,
          verifiedPhone: verifiedPhoneAccepted
            ? normalizedPhone!
            : activeLookupContext.verifiedPhone,
          receivedPhone: normalizedPhone || activeLookupContext.receivedPhone,
          receivedName: followUpName || activeLookupContext.receivedName,
          requestedDate:
            followUpRequestedDate || activeLookupContext.requestedDate,
          approximateTime:
            followUpApproximateTime || activeLookupContext.approximateTime,
          requestedService:
            followUpRequestedService || activeLookupContext.requestedService,
          recoveryMode: true,
          recoveryPromptCount: phoneWasReceived && !verifiedPhoneAccepted
            ? Number(activeLookupContext.recoveryPromptCount || 0) + 1
            : activeLookupContext.recoveryPromptCount,
          phoneReceivedAt: normalizedPhone
            ? Date.now()
            : activeLookupContext.phoneReceivedAt,
          lookupAttemptedAt: Date.now(),
          resultCategory: recoveryAmbiguous
            ? "recovery_ambiguous"
            : verifiedPhoneAccepted
              ? "verified_not_found"
              : phoneWasReceived
                ? hasRecoveryAttribute
                  ? "recovery_not_found"
                  : "recovery_needs_attribute"
                : "needs_verified_phone",
          nextAction: recoveryAmbiguous
            ? "clarify_recovery"
            : verifiedPhoneAccepted
              ? "offer_new_booking"
              : phoneWasReceived
                ? hasRecoveryAttribute
                  ? "offer_new_booking"
                  : "awaiting_recovery_attribute"
                : "awaiting_verified_phone"
        }
      );
      await replyAndRecord(
        phoneWasReceived && !verifiedPhoneAccepted
          ? formatSecureRecoveryPrompt(
              lockedLanguage,
              recoveryAmbiguous
                ? "ambiguous"
                : hasRecoveryAttribute
                  ? "not_found"
                  : "need_attribute"
            )
          : formatAppointmentLookupReply(lookupResult, lockedLanguage)
      );
      return true;
    }

    if (
      !pending &&
      activeLookupContext &&
      (
        followUpName ||
        followUpPhone ||
        appointmentLookupFollowUpRequested ||
        hasLookupIdentificationUpdate
      )
    ) {
      const adapter = getCalendarAdapter(businessConfig);
      const followUpLookupMode = appointmentLookupFollowUpRequested
        ? detectAppointmentLookupMode(text)
        : activeLookupContext.lookupMode || (activeLookupContext.includePast ? "history" : "upcoming");
      const olderHistory = Boolean(
        activeLookupContext.historyWindowLimited && isOlderAppointmentHistoryConfirmation(text)
      );
      const lookupResult = await findCustomerAppointments(
        adapter,
        {
          name: followUpName || undefined,
          phone: followUpPhone || undefined,
          requestedDate: followUpRequestedDate || undefined,
          startDate: followUpRequestedDate || undefined,
          endDate: followUpRequestedDate || undefined,
          approximateTime: followUpApproximateTime || undefined,
          service: followUpRequestedService || undefined,
          secureRecovery: true,
          includePast: olderHistory || followUpLookupMode === "history",
          lookupMode: olderHistory ? "history" : followUpLookupMode,
          olderHistory,
          lookupText: text,
          lookupPath: "unified_lookup_follow_up"
        },
        recipientUserId,
        platformName,
        businessConfig
      );
      rememberAppointmentContext(sessionId, lookupResult, activeLookupContext.language || language, currentAppointmentStateOwner);
      if (lookupResult?.found) clearAppointmentLookupContext(sessionId);
      else rememberAppointmentLookupContext(
        sessionId,
        activeLookupContext.language || language,
        lookupResult?.lookupMode === "history",
        lookupResult?.lookupMode || followUpLookupMode,
        Boolean(lookupResult?.historyWindowLimited),
        {
          operation: activeLookupContext.operation || "lookup",
          verifiedPhone: lookupResult?.verifiedPhoneAccepted && followUpPhone
            ? normalizeAcceptedPhone(followUpPhone) || undefined
            : activeLookupContext.verifiedPhone,
          receivedPhone: followUpPhone
            ? normalizeAcceptedPhone(followUpPhone) || activeLookupContext.receivedPhone
            : activeLookupContext.receivedPhone,
          receivedName: followUpName || activeLookupContext.receivedName,
          requestedDate:
            followUpRequestedDate || activeLookupContext.requestedDate,
          approximateTime:
            followUpApproximateTime || activeLookupContext.approximateTime,
          requestedService:
            followUpRequestedService || activeLookupContext.requestedService,
          recoveryMode: true,
          recoveryPromptCount: followUpPhone && !lookupResult?.verifiedPhoneAccepted
            ? Number(activeLookupContext.recoveryPromptCount || 0) + 1
            : activeLookupContext.recoveryPromptCount,
          phoneReceivedAt: followUpPhone
            ? Date.now()
            : activeLookupContext.phoneReceivedAt,
          lookupAttemptedAt: Date.now(),
          resultCategory: lookupResult?.secureRecoveryAmbiguous
            ? "recovery_ambiguous"
            : lookupResult?.verifiedPhoneAccepted
              ? "verified_not_found"
              : followUpPhone
                ? followUpName ||
                  (followUpRequestedDate && followUpApproximateTime)
                  ? "recovery_not_found"
                  : "recovery_needs_attribute"
                : "needs_verified_phone",
          nextAction: lookupResult?.secureRecoveryAmbiguous
            ? "clarify_recovery"
            : lookupResult?.verifiedPhoneAccepted
              ? "offer_new_booking"
              : followUpPhone
                ? followUpName ||
                  (followUpRequestedDate && followUpApproximateTime)
                  ? "offer_new_booking"
                  : "awaiting_recovery_attribute"
                : "awaiting_verified_phone"
        }
      );
      await replyAndRecord(
        !lookupResult?.found &&
          followUpPhone &&
          !lookupResult?.verifiedPhoneAccepted
          ? formatSecureRecoveryPrompt(
              activeLookupContext.language || language,
              lookupResult?.secureRecoveryAmbiguous
                ? "ambiguous"
                : followUpName ||
                    (followUpRequestedDate && followUpApproximateTime)
                  ? "not_found"
                  : "need_attribute"
            )
          : formatAppointmentLookupReply(lookupResult, activeLookupContext.language || language)
      );
      return true;
    }

    if (!pending && appointmentLookupRequested) {
      const adapter = getCalendarAdapter(businessConfig);
      const lookupContact = extractNameAndPhone(text);
      const lookupIdentification = getLookupIdentificationDetails(text);
      const lookupMode = isPastAppointmentLookupIntent(text)
        ? "history"
        : detectAppointmentLookupMode(text);
      const includePast = lookupMode === "history";
      const lookupArgs = {
        name: lookupContact?.name || extractNameOnly(text) || undefined,
        phone: lookupContact?.phone || extractPhoneOnly(text) || undefined,
        requestedDate: lookupIdentification.requestedDate,
        startDate: lookupIdentification.requestedDate,
        endDate: lookupIdentification.requestedDate,
        approximateTime: lookupIdentification.approximateTime,
        service: lookupIdentification.requestedService,
        secureRecovery: true,
        includePast,
        lookupMode,
        lookupText: text,
        lookupPath: "unified_direct_lookup"
      };
      const lookupResult = await findCustomerAppointments(
        adapter,
        lookupArgs,
        recipientUserId,
        platformName,
        businessConfig
      );
      rememberAppointmentContext(sessionId, lookupResult, language, currentAppointmentStateOwner);
      if (lookupResult?.found) clearAppointmentLookupContext(sessionId);
      else rememberAppointmentLookupContext(
        sessionId,
        language,
        lookupResult?.lookupMode === "history",
        lookupResult?.lookupMode || lookupMode,
        Boolean(lookupResult?.historyWindowLimited),
        {
          operation: "lookup",
          verifiedPhone: lookupResult?.verifiedPhoneAccepted && lookupArgs.phone
            ? normalizeAcceptedPhone(lookupArgs.phone) || undefined
            : undefined,
          receivedPhone: lookupArgs.phone
            ? normalizeAcceptedPhone(lookupArgs.phone) || undefined
            : undefined,
          receivedName: lookupIdentification.name,
          requestedDate: lookupIdentification.requestedDate,
          approximateTime: lookupIdentification.approximateTime,
          requestedService: lookupIdentification.requestedService,
          recoveryMode: true,
          recoveryPromptCount: lookupArgs.phone && !lookupResult?.verifiedPhoneAccepted
            ? 1
            : 0,
          phoneReceivedAt: lookupArgs.phone ? Date.now() : undefined,
          lookupAttemptedAt: Date.now(),
          resultCategory: lookupResult?.secureRecoveryAmbiguous
            ? "recovery_ambiguous"
            : lookupResult?.verifiedPhoneAccepted
              ? "verified_not_found"
              : lookupArgs.phone
                ? lookupIdentification.name ||
                  (
                    lookupIdentification.requestedDate &&
                    lookupIdentification.approximateTime
                  )
                  ? "recovery_not_found"
                  : "recovery_needs_attribute"
                : "needs_verified_phone",
          nextAction: lookupResult?.secureRecoveryAmbiguous
            ? "clarify_recovery"
            : lookupResult?.verifiedPhoneAccepted
              ? "offer_new_booking"
              : lookupArgs.phone
                ? lookupIdentification.name ||
                  (
                    lookupIdentification.requestedDate &&
                    lookupIdentification.approximateTime
                  )
                  ? "offer_new_booking"
                  : "awaiting_recovery_attribute"
                : "awaiting_verified_phone"
        }
      );
      const reply = !lookupResult?.found &&
        lookupArgs.phone &&
        !lookupResult?.verifiedPhoneAccepted
        ? formatSecureRecoveryPrompt(
            language,
            lookupResult?.secureRecoveryAmbiguous
              ? "ambiguous"
              : lookupIdentification.name ||
                  (
                    lookupIdentification.requestedDate &&
                    lookupIdentification.approximateTime
                  )
                ? "not_found"
                : "need_attribute"
          )
        : formatAppointmentLookupReply(lookupResult, language);
      console.log(`[UnifiedBooking] Lookup platform=${platformName}, found=${Boolean(lookupResult?.found)}`);
      await replyAndRecord(reply);
      return true;
    }

    const completed = getRecentCompletedBooking(sessionId);
    if (!pending && completed && isThanksOnlyText(text)) {
      await replyAndRecord(formatThanksReply(getFlowReplyLanguage(completed.language, language, text), completed.name));
      return true;
    }

    let storedAvailability = availabilitySearchContexts[sessionId];
    if (storedAvailability && Date.now() - storedAvailability.savedAt > PENDING_BOOKING_TTL_MS) {
      delete availabilitySearchContexts[sessionId];
      storedAvailability = undefined;
    }
    const availabilityOwnerMatches = Boolean(
      storedAvailability &&
      storedAvailability.businessId === currentAppointmentStateOwner.businessId &&
      storedAvailability.platform === currentAppointmentStateOwner.platform &&
      storedAvailability.userId === currentAppointmentStateOwner.userId
    );
    if (storedAvailability && !availabilityOwnerMatches) {
      delete availabilitySearchContexts[sessionId];
    }

    const alternativeAvailabilityRequested = isAlternativeAvailabilityRequest(text);
    const previousAvailabilityConstraint = availabilityOwnerMatches
      ? storedAvailability?.constraint
      : (
          pending?.operation === "new_booking"
            ? pending.availabilityConstraint || null
            : null
        );
    let latestAvailabilityConstraint = deriveCanonicalAvailabilityConstraint(
      text,
      businessConfig,
      previousAvailabilityConstraint
    );
    let outsideOriginalRange = false;
    if (
      !latestAvailabilityConstraint &&
      alternativeAvailabilityRequested &&
      previousAvailabilityConstraint
    ) {
      const configuredWindowEnd = addDaysToStockholmDate(
        stockholmDateString(new Date()),
        getConfiguredBookingWindowDays(businessConfig)
      );
      const alternativeStart = addDaysToStockholmDate(
        previousAvailabilityConstraint.endDate,
        1
      );
      latestAvailabilityConstraint = {
        startDate: alternativeStart,
        endDate: configuredWindowEnd,
        kind: "date_range",
        rejectedTimes: [],
        generatedFromLatestRequestAt: Date.now()
      };
      outsideOriginalRange = true;
    }
    const hasActiveAvailabilityFlow = Boolean(
      availabilityOwnerMatches ||
      (
        pending?.operation === "new_booking" &&
        ["awaiting_time_selection", "awaiting_confirmation"].includes(
          String(pending.status || "")
        )
      )
    );
    if (
      (
        !pending ||
        ["awaiting_time_selection", "awaiting_confirmation"].includes(
          String(pending.status || "")
        )
      ) &&
      !getRescheduleContext(sessionId) &&
      latestAvailabilityConstraint &&
      (
        hasActiveAvailabilityFlow ||
        explicitNewBookingRequested ||
        isBookingConversationContext(text, history)
      )
    ) {
      const priorConstraintType = previousAvailabilityConstraint?.kind || "none";
      const constraint = latestAvailabilityConstraint;
      const staleConstraintsCleared = Boolean(
        previousAvailabilityConstraint &&
        (
          previousAvailabilityConstraint.kind !== constraint.kind ||
          previousAvailabilityConstraint.startDate !== constraint.startDate ||
          previousAvailabilityConstraint.endDate !== constraint.endDate ||
          previousAvailabilityConstraint.exactTime !== constraint.exactTime ||
          previousAvailabilityConstraint.minTime !== constraint.minTime ||
          previousAvailabilityConstraint.maxTime !== constraint.maxTime ||
          previousAvailabilityConstraint.timeBoundary?.kind !==
            constraint.timeBoundary?.kind ||
          previousAvailabilityConstraint.timeBoundary?.time !==
            constraint.timeBoundary?.time
        )
      );
      const priorPendingBooking = pending;
      if (pending) {
        await clearPendingBooking(sessionId);
        pending = null;
      }
      const inferredService = normalizeBookingService(
        inferServiceFromRecentContext(text, history),
        storedAvailability?.service ||
          priorPendingBooking?.service ||
          recoveredServiceForNewBooking ||
          getDefaultBookingServiceForBusiness(businessConfig) ||
          "Bokning"
      );
      const durationMinutes = storedAvailability?.durationMinutes ||
        Number(priorPendingBooking?.durationMinutes || 0) ||
        getDefaultBookingDurationForService(inferredService) ||
        inferBookingDurationFromContext(text, history);
      const lockedLanguage =
        storedAvailability?.language ||
        priorPendingBooking?.language ||
        getStoredFlowLanguage(sessionId) ||
        language;
      lockConversationFlowLanguage(sessionId, lockedLanguage, "availability");

      const adapter = getCalendarAdapter(businessConfig);
      const searchIsWithinConfiguredWindow =
        constraint.startDate <= constraint.endDate;
      const canonicalOffers = searchIsWithinConfiguredWindow
        ? await createCanonicalOfferedSlots({
            adapter,
            owner: currentBookingSlotOwner,
            businessConfig,
            startDate: constraint.startDate,
            endDate: constraint.endDate,
            service: inferredService,
            durationMinutes,
            requestedTime: constraint.exactTime,
            options: availabilityConstraintSlotOptions(constraint)
          })
        : { displaySlots: [], ownedSlots: [] };
      const slots = canonicalOffers.displaySlots;

      availabilitySearchContexts[sessionId] = {
        constraint,
        service: inferredService,
        durationMinutes,
        language: lockedLanguage,
        businessId: currentAppointmentStateOwner.businessId,
        platform: currentAppointmentStateOwner.platform,
        userId: currentAppointmentStateOwner.userId,
        savedAt: Date.now(),
        lastResultCategory: slots.length > 0 ? "available" : "no_availability"
      };

      if (slots.length > 0) {
        const exactIso = constraint.exactTime
          ? findOfferedSlotIso(slots, constraint.exactTime)
          : null;
        await savePendingBooking(sessionId, platformName, {
          businessConfig,
          platform: platformName,
          service: inferredService,
          selectedDate:
            constraint.startDate === constraint.endDate
              ? constraint.startDate
              : null,
          offeredSlots: slots,
          ownedOfferedSlots: canonicalOffers.ownedSlots,
          availabilityStartDate: constraint.startDate,
          availabilityEndDate: constraint.endDate,
          availabilityMinTime: constraint.minTime || null,
          availabilityMaxTime: constraint.maxTime || null,
          availabilityConstraint: constraint,
          dateTime: exactIso,
          durationMinutes,
          language: lockedLanguage,
          operation: "new_booking",
          customerPhone: getWhatsAppConversationPhone(platformName, recipientUserId, sessionId),
          status: exactIso ? "awaiting_confirmation" : "awaiting_time_selection"
        });
        pending = pendingBookings[sessionId];
      }

      console.log("[AvailabilityFlow]", {
        platform: platformName,
        businessScopePresent: Boolean(currentAppointmentStateOwner.businessId),
        flowType: "new_booking_availability",
        previousConstraintType: priorConstraintType,
        newConstraintType: constraint.kind,
        staleConstraintsCleared,
        localSearchStart: constraint.startDate,
        localSearchEnd: constraint.endDate,
        candidateCount: slots.length,
        canonicalValidSlotCount: canonicalOffers.ownedSlots.length,
        resultCategory: slots.length > 0 ? "available" : "no_availability"
      });

      const rangeReplyRequest: AvailabilityRangeRequest = {
        startDate: constraint.startDate,
        endDate: constraint.endDate,
        ...(constraint.minTime ? { minTime: constraint.minTime } : {}),
        ...(constraint.maxTime ? { maxTime: constraint.maxTime } : {}),
        flexibleDays: constraint.startDate !== constraint.endDate
      };
      await replyAndRecord(
        outsideOriginalRange
          ? formatRangeAvailabilityReply(
              slots,
              lockedLanguage,
              rangeReplyRequest,
              true
            )
          : formatSwedishTimeSlots(
              slots,
              constraint.exactTime,
              lockedLanguage
            )
      );
      return true;
    }

    if (!pending && isGenericBookingRequestWithoutDate(text)) {
      const adapter = getCalendarAdapter(businessConfig);
      const startDate = stockholmDateString(new Date());
      const endDate = addDaysToStockholmDate(startDate, 7);
      const service = normalizeBookingService(inferServiceFromRecentContext(text, history), "Bokning");
      const finalService = service !== "Bokning"
        ? service
        : (getDefaultBookingServiceForBusiness(businessConfig) || "Bokning");
      const durationMinutes = getDefaultBookingDurationForService(finalService) || inferBookingDurationFromContext(text, history);
      lockConversationFlowLanguage(sessionId, language, "booking");
      const canonicalOffers = await createCanonicalOfferedSlots({
        adapter,
        owner: currentBookingSlotOwner,
        businessConfig,
        startDate,
        endDate,
        service: finalService,
        durationMinutes
      });
      const slots = canonicalOffers.displaySlots;

      if (slots.length > 0) {
        const firstIso = parseSlotIso(slots[0]);
        await savePendingBooking(sessionId, platformName, {
          businessConfig,
          platform: platformName,
          service: finalService,
          selectedDate: firstIso ? stockholmDateString(new Date(firstIso)) : startDate,
          offeredSlots: slots,
          ownedOfferedSlots: canonicalOffers.ownedSlots,
          dateTime: null,
          durationMinutes,
          language: detectStrongLatestLanguage(text) || language,
          operation: "new_booking",
          customerPhone: getWhatsAppConversationPhone(platformName, recipientUserId, sessionId),
          status: "awaiting_time_selection"
        });
      }

      await replyAndRecord(formatSwedishTimeSlots(slots, undefined, language));
      return true;
    }

    const explicitDate = resolveExplicitBookingDate(text);
    if (explicitDate && isBookingConversationContext(text, history)) {
      lockConversationFlowLanguage(sessionId, language, "booking");
      const adapter = getCalendarAdapter(businessConfig);
      const requestedTime = inferRequestedTimeFromText(text) || undefined;
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
      const durationMinutes =
        getDefaultBookingDurationForService(finalService) ||
        inferBookingDurationFromContext(text, history);

      console.log(
        `[UnifiedBooking] Date resolved platform=${platformName}, date=${explicitDate}, duration=${durationMinutes}, timeConstraintPresent=${Boolean(requestedTime)}`
      );

      const canonicalOffers = await createCanonicalOfferedSlots({
        adapter,
        owner: currentBookingSlotOwner,
        businessConfig,
        startDate: explicitDate,
        endDate: explicitDate,
        service: finalService,
        durationMinutes,
        requestedTime
      });
      const slots = canonicalOffers.displaySlots;
      const reply = formatSwedishTimeSlots(slots, requestedTime, language);

      if (slots.length > 0) {
        const exactIso = requestedTime ? findOfferedSlotIso(slots, requestedTime) : null;
        await savePendingBooking(sessionId, platformName, {
          businessConfig,
          platform: platformName,
          service: finalService,
          selectedDate: explicitDate,
          offeredSlots: slots,
          ownedOfferedSlots: canonicalOffers.ownedSlots,
          dateTime: exactIso,
          durationMinutes,
          language: detectStrongLatestLanguage(text) || language,
          operation: "new_booking",
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
      const selectedOwnedSlot = selectOwnedOfferedSlot(text, pending);
      const selectedIso = selectedOwnedSlot?.start || null;

      if (selectedIso && selectedOwnedSlot) {
        const adapter = getCalendarAdapter(businessConfig);
        const selectedDate = String(pending.selectedDate || selectedIso.slice(0, 10));
        const resolvedSelectedTime = getStockholmTimeFromIso(selectedIso) || selectedTime || undefined;
        const validation = await validateCanonicalExactSlot({
          adapter,
          owner: currentBookingSlotOwner,
          businessConfig,
          start: selectedIso,
          service: String(pending.service || "Bokning"),
          durationMinutes: Number(pending.durationMinutes || 60),
          offeredSlot: selectedOwnedSlot
        });

        if (!validation.free || !validation.normalizedIso || !validation.endIso) {
          const alternatives = await createCanonicalOfferedSlots({
            adapter,
            owner: currentBookingSlotOwner,
            businessConfig,
            startDate: selectedDate,
            endDate: selectedDate,
            service: String(pending.service || "Bokning"),
            durationMinutes: Number(pending.durationMinutes || 60),
            requestedTime: resolvedSelectedTime,
            options: pending.availabilityConstraint
              ? availabilityConstraintSlotOptions(pending.availabilityConstraint)
              : {
                  ...(pending.availabilityMinTime
                    ? { minTime: pending.availabilityMinTime }
                    : {}),
                  ...(pending.availabilityMaxTime
                    ? { maxTime: pending.availabilityMaxTime }
                    : {})
                }
          });
          pending.offeredSlots = alternatives.displaySlots;
          pending.ownedOfferedSlots = alternatives.ownedSlots;
          pending.dateTime = null;
          await savePendingBooking(sessionId, platformName, pending);
          console.log("[BookingFlow]", {
            platform: platformName,
            businessScopePresent: Boolean(currentBookingSlotOwner.businessId),
            operation: "slot_selection",
            stateType: pending.status,
            language: pending.language || language,
            contactSatisfied: Boolean(pending.customerPhone),
            offeredSlotCount: alternatives.ownedSlots.length,
            selectedSlotStart: selectedOwnedSlot.start,
            selectedSlotEnd: selectedOwnedSlot.end,
            serviceDuration: pending.durationMinutes,
            validatorResultCategory: validation.category,
            ownershipMatch: bookingSlotOwnerMatches(selectedOwnedSlot, currentBookingSlotOwner),
            finalHandledPath: "stale_slot_alternatives"
          });
          await replyAndRecord(
            formatSlotNoLongerAvailable(
              getFlowReplyLanguage(pending.language, language, text),
              resolvedSelectedTime,
              alternatives.displaySlots
            )
          );
          return true;
        }

        pending.dateTime = validation.normalizedIso;
        pending.selectedSlotEnd = validation.endIso;
        pending.selectedDate = stockholmDateString(new Date(validation.normalizedIso));
        pending.language = getFlowReplyLanguage(pending.language, language, text);
        pending.status = "awaiting_contact";
        await savePendingBooking(sessionId, platformName, pending);

        console.log("[BookingFlow]", {
          platform: platformName,
          businessScopePresent: Boolean(currentBookingSlotOwner.businessId),
          operation: "slot_selection",
          stateType: pending.status,
          language: pending.language,
          contactSatisfied: Boolean(pending.customerPhone),
          offeredSlotCount: pending.ownedOfferedSlots?.length || 0,
          selectedSlotStart: validation.normalizedIso,
          selectedSlotEnd: validation.endIso,
          serviceDuration: pending.durationMinutes,
          validatorResultCategory: validation.category,
          ownershipMatch: true,
          finalHandledPath: "awaiting_contact"
        });
        await replyAndRecord(
          formatAskContactMessageForPlatform(
            getFlowReplyLanguage(pending.language, language, text),
            platformName
          )
        );
        return true;
      }
    }

    if (pending && isPendingSlotConfirmation(text, pending)) {
      const dateTime = String(pending.dateTime || "");
      const selectedTime = getStockholmTimeFromIso(dateTime);
      const selectedDate = String(pending.selectedDate || dateTime.slice(0, 10));
      const selectedOwnedSlot = findOwnedOfferedSlot(pending, dateTime);
      const adapter = getCalendarAdapter(businessConfig);
      const validation = selectedOwnedSlot
        ? await validateCanonicalExactSlot({
            adapter,
            owner: currentBookingSlotOwner,
            businessConfig,
            start: dateTime,
            service: String(pending.service || "Bokning"),
            durationMinutes: Number(pending.durationMinutes || 60),
            offeredSlot: selectedOwnedSlot
          })
        : {
            free: false,
            category: "stale_offer" as const,
            normalizedIso: null,
            endIso: null
          };

      if (!validation.free || !validation.normalizedIso || !validation.endIso) {
        const alternatives = await createCanonicalOfferedSlots({
          adapter,
          owner: currentBookingSlotOwner,
          businessConfig,
          startDate: selectedDate,
          endDate: selectedDate,
          service: String(pending.service || "Bokning"),
          durationMinutes: Number(pending.durationMinutes || 60),
          requestedTime: selectedTime || undefined,
          options: pending.availabilityConstraint
            ? availabilityConstraintSlotOptions(pending.availabilityConstraint)
            : {
                ...(pending.availabilityMinTime
                  ? { minTime: pending.availabilityMinTime }
                  : {}),
                ...(pending.availabilityMaxTime
                  ? { maxTime: pending.availabilityMaxTime }
                  : {})
              }
        });
        pending.status = "awaiting_time_selection";
        pending.offeredSlots = alternatives.displaySlots;
        pending.ownedOfferedSlots = alternatives.ownedSlots;
        pending.dateTime = null;
        pending.selectedSlotEnd = null;
        await savePendingBooking(sessionId, platformName, pending);
        await replyAndRecord(
          formatSlotNoLongerAvailable(
            getFlowReplyLanguage(pending.language, language, text),
            selectedTime,
            alternatives.displaySlots
          )
        );
        return true;
      }

      pending.dateTime = validation.normalizedIso;
      pending.selectedSlotEnd = validation.endIso;
      pending.selectedDate = stockholmDateString(new Date(validation.normalizedIso));
      pending.status = "awaiting_contact";
      pending.language = getFlowReplyLanguage(pending.language, language, text);
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
          getFlowReplyLanguage(pending.language, language, text),
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
      if (phoneFromMessage) pending.customerPhone = normalizeAcceptedPhone(phoneFromMessage);
      if (!pending.customerPhone && phoneFromChannel) pending.customerPhone = phoneFromChannel;
      // The offered slot owns service and duration. Contact collection must not
      // redetect either value from a name or phone message.
      void serviceFromMessage;

      const missing: Array<"name" | "phone" | "service"> = [];
      if (!pending.customerName) missing.push("name");
      if (!pending.customerPhone) missing.push("phone");
      if (!pending.service || pending.service === "Bokning") missing.push("service");

      if (missing.length > 0) {
        await savePendingBooking(sessionId, platformName, pending);
        await replyAndRecord(
          formatMissingBookingDetailsMessage(
            getFlowReplyLanguage(pending.language, language, text),
            missing
          )
        );
        return true;
      }

      if (!pending.dateTime) {
        console.error(`[UnifiedBooking] Missing dateTime before insert platform=${platformName}`);
        await clearPendingBooking(sessionId);
        await replyAndRecord(getErrorMessageByLanguage(getFlowReplyLanguage(pending.language, language, text)));
        return true;
      }

      const adapter = getCalendarAdapter(businessConfig);
      const selectedTime = getStockholmTimeFromIso(pending.dateTime);
      const selectedDate = String(
        pending.selectedDate || String(pending.dateTime).slice(0, 10)
      );

      const lockedIso = String(pending.dateTime || "").trim();
      let selectedOwnedSlot = findOwnedOfferedSlot(pending, lockedIso);
      if (!selectedOwnedSlot) {
        const migrationValidation = await validateCanonicalExactSlot({
          adapter,
          owner: currentBookingSlotOwner,
          businessConfig,
          start: lockedIso,
          service: String(pending.service || "Bokning"),
          durationMinutes: Number(pending.durationMinutes || 30)
        });
        if (
          migrationValidation.free &&
          migrationValidation.normalizedIso &&
          migrationValidation.endIso
        ) {
          selectedOwnedSlot = {
            start: migrationValidation.normalizedIso,
            end: migrationValidation.endIso,
            durationMinutes: Number(pending.durationMinutes || 30),
            service: String(pending.service || "Bokning"),
            businessId: currentBookingSlotOwner.businessId,
            platform: currentBookingSlotOwner.platform,
            userId: currentBookingSlotOwner.userId,
            generatedAt: Date.now()
          };
          pending.ownedOfferedSlots = [selectedOwnedSlot];
        }
      }
      const exactCheck = selectedOwnedSlot
        ? await validateCanonicalExactSlot({
            adapter,
            owner: currentBookingSlotOwner,
            businessConfig,
            start: lockedIso,
            service: String(pending.service || "Bokning"),
            durationMinutes: Number(pending.durationMinutes || 30),
            offeredSlot: selectedOwnedSlot
          })
        : {
            free: false,
            category: "stale_offer" as const,
            normalizedIso: null,
            endIso: null
          };
      const finalIso = exactCheck.free ? exactCheck.normalizedIso : null;

      if (!finalIso || !exactCheck.endIso) {
        const alternatives = await createCanonicalOfferedSlots({
          adapter,
          owner: currentBookingSlotOwner,
          businessConfig,
          startDate: selectedDate,
          endDate: selectedDate,
          service: String(pending.service || "Bokning"),
          durationMinutes: Number(pending.durationMinutes || 30),
          requestedTime: selectedTime || undefined,
          options: pending.availabilityConstraint
            ? availabilityConstraintSlotOptions(pending.availabilityConstraint)
            : {
                ...(pending.availabilityMinTime
                  ? { minTime: pending.availabilityMinTime }
                  : {}),
                ...(pending.availabilityMaxTime
                  ? { maxTime: pending.availabilityMaxTime }
                  : {})
              }
        });
        console.warn("[BookingFlow]", {
          platform: platformName,
          businessScopePresent: Boolean(currentBookingSlotOwner.businessId),
          operation: "final_booking_validation",
          stateType: pending.status,
          language: pending.language || language,
          contactSatisfied: Boolean(pending.customerName && pending.customerPhone),
          offeredSlotCount: alternatives.ownedSlots.length,
          selectedSlotStart: lockedIso,
          selectedSlotEnd: pending.selectedSlotEnd || null,
          serviceDuration: pending.durationMinutes,
          validatorResultCategory: exactCheck.category,
          ownershipMatch: Boolean(
            selectedOwnedSlot &&
            bookingSlotOwnerMatches(selectedOwnedSlot, currentBookingSlotOwner)
          ),
          finalHandledPath: "stale_slot_alternatives"
        });

        pending.status = "awaiting_time_selection";
        pending.offeredSlots = alternatives.displaySlots;
        pending.ownedOfferedSlots = alternatives.ownedSlots;
        pending.dateTime = null;
        pending.selectedSlotEnd = null;
        await savePendingBooking(sessionId, platformName, pending);
        await replyAndRecord(
          formatSlotNoLongerAvailable(
            getFlowReplyLanguage(pending.language, language, text),
            selectedTime,
            alternatives.displaySlots
          )
        );
        return true;
      }

      pending.status = "inserting";
      pending.selectedSlotEnd = exactCheck.endIso;
      await savePendingBooking(sessionId, platformName, pending);
      const result = await adapter.insertAppointment(
        pending.customerName,
        pending.customerPhone,
        pending.service,
        finalIso,
        Number(pending.durationMinutes || 30),
        sessionId,
        false
      );

      if (!result?.success) {
        const conflict = ["SLOT_CONFLICT", "SLOT_NO_LONGER_AVAILABLE"].includes(
          String(result?.code || "")
        );
        if (conflict) {
          const alternatives = await createCanonicalOfferedSlots({
            adapter,
            owner: currentBookingSlotOwner,
            businessConfig,
            startDate: selectedDate,
            endDate: selectedDate,
            service: String(pending.service || "Bokning"),
            durationMinutes: Number(pending.durationMinutes || 30),
            requestedTime: selectedTime || undefined
          });
          pending.status = "awaiting_time_selection";
          pending.offeredSlots = alternatives.displaySlots;
          pending.ownedOfferedSlots = alternatives.ownedSlots;
          pending.dateTime = null;
          pending.selectedSlotEnd = null;
          await savePendingBooking(sessionId, platformName, pending);
          await replyAndRecord(
            formatSlotNoLongerAvailable(
              getFlowReplyLanguage(pending.language, language, text),
              selectedTime,
              alternatives.displaySlots
            )
          );
          return true;
        }
        pending.status = "awaiting_contact";
        await savePendingBooking(sessionId, platformName, pending);
        console.error("[BookingFlow]", {
          platform: platformName,
          businessScopePresent: Boolean(currentBookingSlotOwner.businessId),
          operation: "booking_persistence",
          stateType: pending.status,
          language: pending.language || language,
          validatorResultCategory: String(result?.code || "insert_failed"),
          finalHandledPath: "localized_failure"
        });
        await replyAndRecord(
          getErrorMessageByLanguage(getFlowReplyLanguage(pending.language, language, text))
        );
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
        getFlowReplyLanguage(pending.language, language, text),
        pending.customerName,
        pending.service,
        Number(pending.durationMinutes || 30),
        finalIso
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
          getFlowReplyLanguage(pending.language, language, text),
          pending.customerName,
          pending.service,
          finalIso
        )
      );
      return true;
    }

    if (pending?.status === "awaiting_time_selection") {
      await replyAndRecord(
        formatSwedishTimeSlots(
          Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
          undefined,
          getFlowReplyLanguage(pending.language, language, text)
        )
      );
      return true;
    }
    if (pending?.status === "awaiting_confirmation") {
      await replyAndRecord(
        formatSwedishTimeSlots(
          Array.isArray(pending.offeredSlots) ? pending.offeredSlots : [],
          getStockholmTimeFromIso(String(pending.dateTime || "")) || undefined,
          getFlowReplyLanguage(pending.language, language, text),
        )
      );
      return true;
    }
    if (pending?.status === "inserting") return true;

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

async function routeRescheduleToolCallThroughUnified(params: {
  args: any;
  sessionId: string;
  platformName: "whatsapp" | "messenger" | "instagram" | "telegram";
  platformLogName: string;
  recipientUserId: string;
  history: any[];
  businessConfig: any;
  send: UnifiedBookingSend;
  postProcessPlatform: string;
}): Promise<{ handled: boolean; replyMessage?: string; responseAlreadySent?: boolean }> {
  const {
    args,
    sessionId,
    platformName,
    platformLogName,
    recipientUserId,
    history,
    businessConfig,
    send,
    postProcessPlatform
  } = params;
  const owner: AppointmentStateOwner = {
    sessionId,
    businessId: getAppointmentBusinessScope(businessConfig),
    platform: platformName,
    userId: normalizePlatformUserId(platformName, recipientUserId),
  };
  const storedOwner = appointmentStateOwners[sessionId];
  const requestedEventId = String(args?.eventId || "").trim();
  let appointmentContext = getAppointmentContext(sessionId);

  if (!appointmentContext && requestedEventId) {
    const selectionContext = getAppointmentSelectionContext(sessionId);
    const selected = selectionContext?.appointments?.find((appointment: any) =>
      getAppointmentCalendarEventId(appointment) === requestedEventId
    );
    if (selected) {
      appointmentContexts[sessionId] = {
        appointment: selected,
        savedAt: Date.now(),
        language: selectionContext?.language || getConversationLanguage(sessionId, "")
      };
      clearAppointmentSelectionContext(sessionId);
      appointmentContext = getAppointmentContext(sessionId);
    }
  }

  const appointmentEventId = getAppointmentCalendarEventId(appointmentContext?.appointment);
  const requested = new Date(ensureStockholmOffset(String(args?.dateTime || "")));
  if (
    !appointmentContext ||
    !storedOwner ||
    !appointmentStateOwnerMatches(storedOwner, owner) ||
    !requestedEventId ||
    appointmentEventId !== requestedEventId ||
    Number.isNaN(requested.getTime())
  ) {
    return {
      handled: false,
      replyMessage: formatStaleAppointmentStateMessage(
        appointmentContext?.language || getConversationLanguage(sessionId, "")
      )
    };
  }

  const requestedDate = stockholmDateString(requested);
  const requestedTime = requested.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit"
  });
  const lockedLanguage = appointmentContext.language || getConversationLanguage(sessionId, "");
  const replayText = lockedLanguage === "sv"
    ? `ändra min tid ${requestedDate} klockan ${requestedTime}`
    : lockedLanguage === "fa"
      ? `وقت را تغییر بده ${requestedDate} ساعت ${requestedTime}`
      : `reschedule my appointment ${requestedDate} at ${requestedTime}`;
  const handled = await handleUnifiedBookingEngine({
    sessionId,
    platformName,
    platformLogName,
    recipientUserId,
    text: replayText,
    history,
    businessConfig,
    send,
    postProcessPlatform
  });
  return handled
    ? { handled: true, responseAlreadySent: true }
    : {
        handled: false,
        replyMessage: formatStaleAppointmentStateMessage(lockedLanguage)
      };
}

async function processTelegramUpdate(update: any, config: any, platform: string = "telegram-polling") {
  const telegramToken = config?.telegramToken;
  const updateId = String(update?.update_id ?? "").trim();
  if (!telegramToken || !updateId || !update?.message) return;
  await runWithInboundMessageClaim({
    tenantScope: String(getBusinessIdFromConfig(config) || crypto.createHash("sha256").update(telegramToken).digest("hex")),
    businessId: String(getBusinessIdFromConfig(config) || ""),
    platform: "telegram",
    messageId: updateId,
    handler: () => processTelegramUpdateClaimed(update, config, platform)
  });
}

async function processTelegramUpdateClaimed(update: any, config: any, platform: string = "telegram-polling") {
  const telegramToken = config?.telegramToken;
  if (!telegramToken) return;

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

    const voiceTranscript = voice && Array.isArray(userMessageContent)
      ? await transcribeVoiceMessageForFlow(userMessageContent)
      : null;
    const textForFlow = String(text || voiceTranscript || "").trim();
    if (voiceTranscript) userMessageContent = voiceTranscript;

    if (textForFlow) {
      const unifiedHandled = await handleUnifiedBookingEngine({
        sessionId: telegramSessionId,
        platformName: "telegram",
        platformLogName: "Telegram",
        recipientUserId: chatId.toString(),
        text: textForFlow,
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
    if (textForFlow && completedBooking && isThanksOnlyText(textForFlow)) {
      const thanksText = formatThanksReply(completedBooking.language || getLockedReplyLanguage(telegramSessionId, textForFlow), completedBooking.name);
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: thanksText })
      });
      appendLocalHistory(telegramSessionId, textForFlow, thanksText);
      await postProcessMessage(chatId.toString(), platform, textForFlow, thanksText, telegramToken, apiKey, getBusinessIdFromConfig(config));
      return;
    }

    const usageLanguage = getConversationLanguage(telegramSessionId, textForFlow);
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
      appendLocalHistory(telegramSessionId, textForFlow || '[voice]', limitText);
      await postProcessMessage(chatId.toString(), platform, textForFlow || '[voice]', limitText, telegramToken, apiKey, getBusinessIdFromConfig(config));
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
If the requested service is Consultation/Konsultation/مشاوره, its duration is fixed at 30 minutes. Never ask the customer how long it should take.
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. Short replies, numbers, names, phone numbers, dates, times, and confirmations do not change it.
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
  buildLanguageLockInstruction(getConversationLanguage(telegramSessionId, textForFlow));
  if (voice) {
    finalSystemInstruction +=
    "\nVOICE ENGINE:\n" +
    "You support Swedish, English, Persian (Farsi), German, Spanish and Arabic.\n" +
    "Use the server's active conversation language after transcription.\n" +
    "Do not switch language because of a short spoken reply.\n" +
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
      const authoritativeFunctionCalls = selectAuthoritativeGeminiFunctionCalls(
        chatResponse.functionCalls,
        telegramSessionId
      );
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: authoritativeFunctionCalls });
      
      const adapter = getCalendarAdapter(config);
      const functionResponsesParts = await Promise.all(authoritativeFunctionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);
        if (call.function.name === "checkSlots" && args) {
            adapterRes = await adapter.checkSlots(args.startDate, args.endDate, args.durationMinutes, args.requestedTime || inferRequestedTimeFromText(textForFlow));
            if (adapterRes.available_slots_string) {
                const slotsArray = adapterRes.available_slots_string
                    .split('\n')
                    .filter((s: string) => s.trim().length > 0 && !s.includes('No available slots'));
                
                const replyMessage = formatSwedishTimeSlots(slotsArray, args.requestedTime || inferRequestedTimeFromText(textForFlow), getLockedReplyLanguage(telegramSessionId, textForFlow));
                return { TERMINATE_EARLY: true, replyMessage };
            }
        }
        else if (call.function.name === "findCustomerAppointments" && args) {
          adapterRes = await findCustomerAppointments(adapter, { ...args, lookupMode: args.lookupMode || detectAppointmentLookupMode(textForFlow), lookupText: textForFlow, lookupPath: "telegram_gemini_tool" }, chatId.toString(), "telegram", config);
          const lookupLanguage = getLockedReplyLanguage(telegramSessionId, textForFlow);
          rememberLookupResultForConversation(telegramSessionId, adapterRes, lookupLanguage, "telegram", chatId.toString(), config);
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            lookupLanguage
          );
          return { TERMINATE_EARLY: true, replyMessage };
        }
        else if (call.function.name === "rescheduleAppointment" && args) {
          const routed = await routeRescheduleToolCallThroughUnified({
            args,
            sessionId: telegramSessionId,
            platformName: "telegram",
            platformLogName: "Telegram",
            recipientUserId: chatId.toString(),
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
          return {
            TERMINATE_EARLY: true,
            replyMessage: routed.replyMessage || "",
            responseAlreadySent: routed.responseAlreadySent
          };
        }
        else if (call.function.name === "insertAppointment" && args) {
          const contactOverride = extractNameAndPhone(textForFlow);
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
            rememberCompletedBooking(
              telegramSessionId,
              getLockedReplyLanguage(telegramSessionId, textForFlow),
              safeName,
              args.service,
              Number(args.durationMinutes || 0),
              args.dateTime
            );
          }
          if (adapterRes && adapterRes.success) {
            await notifyAdminAboutBooking(
              config,
              "Telegram",
              config?.businessName || config?.business_name || "business",
              safeName,
              safePhone,
              args.dateTime
            );
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
          if (earlyTerm.responseAlreadySent) return;
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
    
    const textResponse = guardCustomerFacingReply(
      telegramSessionId,
      String(chatResponse.text || "").trim() ||
        getErrorMessageByLanguage(getLockedReplyLanguage(telegramSessionId, textForFlow)),
      getLockedReplyLanguage(telegramSessionId, textForFlow)
    );
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
  add("fa", /\b(salam|khubi|khub|khubam|khub hastin|mikham|mikhastam|mitonam|mitoonam|baraye|vaght|saat|sate|doshanbe|seshanbe|chaharshanbe|panjshanbe|jome|shanbe|yekshanbe|emrooz|farda|bale|baleh|are|khube|chi|che|migin|migirin|shohar|shoharam|esm|esme|esmam|nam|name|shomare|shomaram|telefon|telefonam|mobail|mobile|mobilesh|ham hast|hastam|hast|sepas|mersi|merci|mamnoon|mamnun|cancel konam|laghv konam)\b/g, 3);
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
    return /\b(hi|hello|hey|i\s+want|i\s+would\s+like|i\s+can|can\s+i|could\s+i|how\s+long|duration|appointment|consultation|book|booking|available|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|my\s+name\s+is|my\s+phone\s+is|pedicure|treatment|quick\s+refresh)\b/i.test(lower);
  }
  if (language === "sv") {
    return /\b(hej|hejsan|hallå|kan\s+du|kan\s+jag|har\s+jag|hos\s+er|mår\s+du|jag\s+vill|jag\s+ska|jag\s+kan|jag\s+behöver|hur\s+lång|hur\s+långt|hur\s+länge|ändra\s+min\s+tid|flytta\s+min\s+tid|boka|bokning|ledig|behandling|konsultation|nästa\s+(måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)|mitt\s+namn|mitt\s+nummer|mobilnummer)\b/i.test(lower);
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
    /\b(hej+|hejsan|hallå|kan du|kan jag|har jag|hos er|mår du|jag vill|jag ska|jag behöver|hur lång|hur långt|hur länge|ändra min tid|flytta min tid|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|klockan|vilken tid|konsultation|boka|bokning|ledig|passar|mitt namn|mitt nummer|mobilnummer)\b/i.test(raw)
  ) return "sv";

  if (
    /\b(man|mikham|mikhastam|mitonam|mitoonam|baraye|vaght|moshavere|moshavereh|cheghadr tool|esmam|esme man|shomare|shomaram|khobe|bale|lotfan|cancel konam|laghv konam|2shanbe|3shanbe|4shanbe|5shanbe)\b/i.test(raw)
  ) return "fa";

  if (/\b(i want|can i|how long|duration|monday|tuesday|wednesday|appointment|consultation|book|booking|my name)\b/i.test(raw)) return "en";
  if (/\b(ich|möchte|termin|montag|dienstag|beratung)\b/i.test(raw)) return "de";
  if (/\b(quiero|cita|lunes|martes|consulta)\b/i.test(raw)) return "es";

  return null;
}

function isMeaningfulLanguageMessage(text?: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (isAmbiguousShortReply(raw) || isThanksOnlyText(raw) || isAffirmativeBookingText(raw)) return false;
  if (extractNameAndPhone(raw) || extractPhoneOnly(raw)) return false;
  if (/^[\d\s:+().,\-/]+$/.test(normalizeLocalizedDigits(raw))) return false;

  const letters = raw.match(/[A-Za-zÅÄÖåäöÉéÜüÑñ\u0600-\u06FF]+/g) || [];
  if (letters.length < 3) return false;
  return letters.join("").length >= 8;
}

function getStoredFlowLanguage(chatId: string): string | null {
  const shared = conversationFlowLanguages[chatId];
  if (shared && Date.now() - shared.updatedAt > FLOW_LANGUAGE_TTL_MS) {
    delete conversationFlowLanguages[chatId];
  }
  if (pendingBookings[chatId] && isPendingBookingExpired(pendingBookings[chatId])) {
    delete pendingBookings[chatId];
    delete conversationFlowLanguages[chatId];
  }

  const reschedule = rescheduleContexts[chatId];
  if (reschedule && !isRescheduleContextStale(reschedule)) {
    return reschedule.lockedReplyLanguage || reschedule.language || null;
  }

  return conversationFlowLanguages[chatId]?.language ||
    cancellationContexts[chatId]?.language ||
    appointmentSelectionContexts[chatId]?.language ||
    appointmentLookupContexts[chatId]?.language ||
    appointmentContexts[chatId]?.language ||
    pendingBookings[chatId]?.language ||
    getRecentCompletedBooking(chatId)?.language ||
    null;
}

function updateActiveFlowLanguage(chatId: string, language: string) {
  if (conversationFlowLanguages[chatId]) {
    conversationFlowLanguages[chatId].language = language;
    conversationFlowLanguages[chatId].updatedAt = Date.now();
  }
  if (pendingBookings[chatId]) pendingBookings[chatId].language = language;
  if (appointmentContexts[chatId]) appointmentContexts[chatId].language = language;
  if (appointmentSelectionContexts[chatId]) appointmentSelectionContexts[chatId].language = language;
  if (appointmentLookupContexts[chatId]) appointmentLookupContexts[chatId].language = language;
  if (cancellationContexts[chatId]) cancellationContexts[chatId].language = language;
  if (availabilitySearchContexts[chatId]) availabilitySearchContexts[chatId].language = language;
  if (rescheduleContexts[chatId]) {
    rescheduleContexts[chatId].language = language;
    rescheduleContexts[chatId].lockedReplyLanguage = language;
  }
}

function lockConversationFlowLanguage(
  chatId: string,
  language: string,
  flowType: ConversationFlowLanguageContext["flowType"]
) {
  const normalized = ["sv", "fa", "de", "es", "ar", "en"].includes(language) ? language : "en";
  const existing = conversationFlowLanguages[chatId];
  conversationFlowLanguages[chatId] = {
    language: existing?.language || normalized,
    flowType,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  chatLanguages[chatId] = conversationFlowLanguages[chatId].language;
}

function clearConversationFlowLanguage(chatId: string) {
  delete conversationFlowLanguages[chatId];
}

function getFlowReplyLanguage(storedLanguage: string | undefined | null, currentLanguage: string, latestText?: string): string {
  const explicitSwitch = isExplicitLanguageSwitch(latestText);
  if (explicitSwitch) return explicitSwitch;
  return storedLanguage || currentLanguage || "en";
}

function getConversationLanguage(chatId: string, latestText?: string): string {
  const text = String(latestText || "").trim();
  const previous = chatLanguages[chatId];
  const storedFlowLanguage = getStoredFlowLanguage(chatId);
  const explicitSwitch = isExplicitLanguageSwitch(text);

  if (explicitSwitch) {
    chatLanguages[chatId] = explicitSwitch;
    updateActiveFlowLanguage(chatId, explicitSwitch);
    return explicitSwitch;
  }

  const strongLatest = detectStrongLatestLanguage(text);
  const detected = strongLatest || detectUserLanguage(text || "");

  if (
    strongLatest &&
    strongLatest !== (storedFlowLanguage || previous) &&
    isMeaningfulLanguageMessage(text) &&
    hasStrongLanguageEvidence(strongLatest, text)
  ) {
    chatLanguages[chatId] = strongLatest;
    updateActiveFlowLanguage(chatId, strongLatest);
    console.log(
      `[LanguageLock] meaningful language switch previous=${storedFlowLanguage || previous || "none"} with=${strongLatest} chatId=${chatId}`
    );
    return strongLatest;
  }

  if (storedFlowLanguage) {
    chatLanguages[chatId] = storedFlowLanguage;
    if (conversationFlowLanguages[chatId]) conversationFlowLanguages[chatId].updatedAt = Date.now();
    return storedFlowLanguage;
  }

  if (previous && (!isMeaningfulLanguageMessage(text) || shouldKeepPreviousConversationLanguage(chatId, text))) {
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
Short confirmations, names, phone numbers, dates, and times never change this language.
Only a clear, meaningful full customer request in another supported language may change it.
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
    const sent = await sendCustomerMessage(platform, recipient, message, businessConfig);
    if (!sent) console.error(`[Reminder] Send failed for appointment ${appointment.id} through ${platform}`);
    return sent;
  } catch (err) {
    console.error(`[Reminder] Send crashed for appointment ${appointment.id}:`, err);
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
  const safeText = guardCustomerFacingReply(
    `ig_${normalizePlatformUserId("instagram", recipientId)}`,
    text
  );

  if (!token) {
    console.error('Instagram reply skipped: missing business instagram_access_token');
    return false;
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text: safeText }
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
  const safeText = guardCustomerFacingReply(
    `wa_${normalizePlatformUserId("whatsapp", to)}`,
    text
  );

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
      body: safeText
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
  const messageId = String(message?.id || "").trim();
  const tenantScope = String(metadata?.phone_number_id || "").trim();
  if (!messageId || !tenantScope) {
    console.warn("[Idempotency] WhatsApp message refused: exact message id or tenant scope is missing.");
    return;
  }
  await runWithInboundMessageClaim({
    tenantScope,
    businessId: String(getBusinessIdFromConfig(config) || ""),
    platform: "whatsapp",
    messageId,
    handler: () => processWhatsAppMessageClaimed(message, metadata, config, platform)
  });
}

async function processWhatsAppMessageClaimed(message: any, metadata: any, config: any, platform: string = "whatsapp-webhook") {
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
  let userLanguage = getConversationLanguage(chatId, textMessage || "");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };
  let whatsappBusinessScopeVerified = !supabase && Boolean(
    getBusinessIdFromConfig(businessConfig) &&
    String(businessConfig?.whatsappPhoneNumberId || businessConfig?.whatsapp_phone_number_id || "") === String(phoneNumberId)
  );

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
        whatsappBusinessScopeVerified = Boolean(data.id);
        // Use the same complete business normalization as every other channel so newly
        // added settings (especially cancellation policy) cannot be silently dropped.
        businessConfig = {
          ...businessConfig,
          ...normalizeBusinessConfig(data),
          whatsappAccessToken: cleanMetaToken(data.whatsapp_access_token),
          whatsappPhoneNumberId: data.whatsapp_phone_number_id,
          whatsappBusinessAccountId: data.whatsapp_business_account_id,
          whatsappEnabled: data.whatsapp_enabled,
          calendarProvider: "google"
        };
        console.log(
          `[WhatsAppConfig] business=${data.business_name} (${data.id}), ` +
          `allowCancellation=${businessConfig.allowCancellation}, ` +
          `deadlineMinutes=${businessConfig.cancellationDeadlineMinutes}`
        );
      } else {
        console.error("No business found for WhatsApp phone_number_id:", phoneNumberId);
      }
    }
  } catch (tenantErr) {
    console.error("WhatsApp tenant config injection failed:", tenantErr);
  }

  if (!whatsappBusinessScopeVerified) {
    clearAppointmentConversationState(chatId);
    console.error(`[WhatsAppConfig] Refusing unscoped message for phone_number_id=${phoneNumberId}`);
    return;
  }

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);
  userLanguage = getConversationLanguage(chatId, textMessage || "");

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
If the requested service is Consultation/Konsultation/مشاوره, its duration is fixed at 30 minutes. Never ask the customer how long it should take.
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. Short replies, numbers, names, phone numbers, dates, times, and confirmations do not change it.
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
      const authoritativeFunctionCalls = selectAuthoritativeGeminiFunctionCalls(
        chatResponse.functionCalls,
        chatId
      );
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: authoritativeFunctionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(authoritativeFunctionCalls.map(async (call: any) => {
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
          adapterRes = await findCustomerAppointments(adapter, { ...args, lookupMode: args.lookupMode || detectAppointmentLookupMode(textMessage), lookupText: textMessage, lookupPath: "whatsapp_gemini_tool" }, from, "whatsapp", businessConfig);
          const lookupLanguage = getConversationLanguage(chatId, textMessage || "");
          rememberLookupResultForConversation(chatId, adapterRes, lookupLanguage, "whatsapp", from, businessConfig);
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            lookupLanguage
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === "rescheduleAppointment" && args) {
          const routed = await routeRescheduleToolCallThroughUnified({
            args,
            sessionId: chatId,
            platformName: "whatsapp",
            platformLogName: "WhatsApp",
            recipientUserId: from,
            history,
            businessConfig,
            send: (reply) => sendWhatsAppMessage(from, reply, businessConfig),
            postProcessPlatform: platform
          });
          return {
            TERMINATE_EARLY: true,
            replyMessage: routed.replyMessage || "",
            responseAlreadySent: routed.responseAlreadySent
          };
        } else if (call.function.name === "insertAppointment" && args) {
          console.warn("[BookingFlow]", {
            platform: "whatsapp",
            businessScopePresent: Boolean(getBusinessIdFromConfig(businessConfig)),
            operation: "booking_persistence",
            stateType: "gemini_insert",
            language: getConversationLanguage(chatId, textMessage || ""),
            finalHandledPath: "blocked_non_authoritative_insert"
          });
          return {
            TERMINATE_EARLY: true,
            replyMessage: getErrorMessageByLanguage(
              getConversationLanguage(chatId, textMessage || "")
            )
          };
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
        if (earlyTerm.responseAlreadySent) return;
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

    const textResponse = guardCustomerFacingReply(
      chatId,
      String(chatResponse.text || "").trim() ||
        getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || "")),
      getConversationLanguage(chatId, textMessage || "")
    );
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
  const safeText = guardCustomerFacingReply(
    `ms_${normalizePlatformUserId("messenger", recipientId)}`,
    text
  );

  if (!token) {
    console.error("Messenger reply skipped: missing messenger_page_access_token / page access token");
    return false;
  }

  const payload = {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: { text: safeText }
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok) {
      console.log("Messenger reply sent.");
      return true;
    }

    console.error("Messenger send failed:", JSON.stringify({ code: result?.error?.code, type: result?.error?.type }));
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
      console.log(`Messenger ${attachmentType} reply sent.`);
      return true;
    }

    console.error(`Messenger ${attachmentType} send failed:`, JSON.stringify({ code: result?.error?.code, type: result?.error?.type }));
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
  if (webhookEvent?.message?.is_echo) return;
  const messageId = String(webhookEvent?.message?.mid || webhookEvent?.postback?.mid || "").trim();
  const tenantScope = String(webhookEvent?.recipient?.id || "").trim();
  if (!messageId || !tenantScope) {
    console.warn("[Idempotency] Messenger message refused: exact message id or tenant scope is missing.");
    return;
  }
  await runWithInboundMessageClaim({
    tenantScope,
    businessId: String(getBusinessIdFromConfig(config) || ""),
    platform: "messenger",
    messageId,
    handler: () => processMessengerUpdateClaimed(webhookEvent, config, platform)
  });
}

async function processMessengerUpdateClaimed(webhookEvent: any, config: any, platform: string = "messenger-webhook") {
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

  console.log(
    `[MessengerWebhook] inputType=${isVoiceMessage ? "voice" : "text"} ` +
    `senderPresent=${Boolean(senderId)} businessPagePresent=${Boolean(recipientId)}`
  );

  const chatId = `ms_${senderId}`;
  let userLanguage = getConversationLanguage(chatId, textMessage || "");

  let businessConfig: any = { ...activeConfig, ...(config || {}) };
  let messengerBusinessScopeVerified = !supabase && Boolean(
    getBusinessIdFromConfig(businessConfig) &&
    getBusinessMessengerPageId(businessConfig) === String(recipientId)
  );

  try {
    const data = await findMessengerBusinessByPageId(recipientId);

    if (data) {
      // Always normalize the complete database row here. Building the Messenger config
      // manually caused newer business settings (including cancellation policy fields)
      // to be dropped even though they were correctly saved in Supabase.
      businessConfig = {
        ...businessConfig,
        ...normalizeBusinessConfig(data),
        messengerPageId: data.messenger_page_id || data.facebook_page_id || data.page_id || data.instagram_page_id,
        messengerPageAccessToken: cleanMetaToken(
          data.messenger_page_access_token ||
          data.facebook_page_access_token ||
          data.page_access_token ||
          data.instagram_access_token
        ),
        messengerEnabled: data.messenger_enabled,
        messengerBusinessScopeVerified: Boolean(data.id),
        calendarProvider: "google"
      };
      messengerBusinessScopeVerified = Boolean(data.id);
      console.log(
        `[MessengerConfig] business=${data.business_name} (${data.id}), ` +
        `allowCancellation=${businessConfig.allowCancellation}, ` +
        `deadlineMinutes=${businessConfig.cancellationDeadlineMinutes}`
      );
    } else {
      console.error("No business found for Messenger recipient/page id:", recipientId);
    }
  } catch (tenantErr) {
    console.error("Messenger tenant config injection failed:", tenantErr);
  }

  businessConfig.messengerBusinessScopeVerified = messengerBusinessScopeVerified;
  if (!messengerBusinessScopeVerified) {
    clearAppointmentConversationState(chatId);
    console.error(`[MessengerConfig] Refusing unscoped message for recipient/page id=${recipientId}`);
    return;
  }

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);
  userLanguage = getConversationLanguage(chatId, textMessage || "");

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
  } catch (bookingFallbackErr) {
    console.error("[UnifiedBooking] Messenger deterministic dispatch crashed:", bookingFallbackErr);
    return;
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
      const voiceTranscript = await transcribeVoiceMessageForFlow(userMessageContent);
      if (voiceTranscript) {
        userLanguage = getConversationLanguage(chatId, voiceTranscript);
        userMessageContent = voiceTranscript;
        userMessageForLog = voiceTranscript;
        const unifiedHandled = await handleUnifiedBookingEngine({
          sessionId: chatId,
          platformName: "messenger",
          platformLogName: "Messenger",
          recipientUserId: senderId,
          text: voiceTranscript,
          history,
          businessConfig,
          send: (reply) => sendMessengerMessage(senderId, reply, businessConfig),
          postProcessPlatform: platform
        });
        if (unifiedHandled) return;
      } else {
        userMessageForLog = "[Messenger Voice Message]";
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
If the requested service is Consultation/Konsultation/مشاوره, its duration is fixed at 30 minutes. Never ask the customer how long it should take.
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. Short replies, numbers, names, phone numbers, dates, times, and confirmations do not change it.
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
        "Use the server's active conversation language after transcription.\n" +
        "Do not switch language because of a short spoken reply.\n" +
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
      console.log("[MessengerTools] functionCalls:", JSON.stringify(chatResponse.functionCalls.map((c: any) => c.function?.name)));
      maxTurns--;
      const authoritativeFunctionCalls = selectAuthoritativeGeminiFunctionCalls(
        chatResponse.functionCalls,
        chatId
      );
      messages.push({ role: "assistant", content: chatResponse.text || null, tool_calls: authoritativeFunctionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(authoritativeFunctionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === "checkSlots" && args) {
          const requestedTime = args.requestedTime || inferRequestedTimeFromText(textMessage || "");
          const service = normalizeBookingService(
            args.service || inferServiceFromRecentContext(textMessage || "", history),
            getDefaultBookingServiceForBusiness(businessConfig) || "Bokning"
          );
          const durationMinutes =
            getDefaultBookingDurationForService(service) ||
            Number(args.durationMinutes || inferBookingDurationFromContext(textMessage || "", history));
          const owner: BookingSlotOwner = {
            businessId: String(getBusinessIdFromConfig(businessConfig) || ""),
            platform: "messenger",
            userId: normalizePlatformUserId("messenger", senderId),
            sessionId: chatId
          };
          const offers = await createCanonicalOfferedSlots({
            adapter,
            owner,
            businessConfig,
            startDate: args.startDate,
            endDate: args.endDate || args.startDate,
            service,
            durationMinutes,
            requestedTime
          });
          const exactSlot = requestedTime
            ? selectOwnedOfferedSlot(requestedTime, {
                offeredSlots: offers.displaySlots,
                ownedOfferedSlots: offers.ownedSlots
              })
            : null;
          if (offers.ownedSlots.length > 0) {
            await savePendingBooking(chatId, "messenger", {
              businessConfig,
              platform: "messenger",
              userId: senderId,
              service,
              selectedDate: args.startDate,
              offeredSlots: offers.displaySlots,
              ownedOfferedSlots: offers.ownedSlots,
              dateTime: exactSlot?.start || null,
              selectedSlotEnd: exactSlot?.end || null,
              durationMinutes,
              language: getConversationLanguage(chatId, textMessage || ""),
              operation: "new_booking",
              status: exactSlot ? "awaiting_confirmation" : "awaiting_time_selection"
            });
          }
          return {
            TERMINATE_EARLY: true,
            replyMessage: formatSwedishTimeSlots(
              offers.displaySlots,
              requestedTime,
              getConversationLanguage(chatId, textMessage || "")
            )
          };
        } else if (call.function.name === "findCustomerAppointments" && args) {
          adapterRes = await findCustomerAppointments(adapter, { ...args, lookupMode: args.lookupMode || detectAppointmentLookupMode(textMessage), lookupText: textMessage, lookupPath: "messenger_gemini_tool" }, senderId, "messenger", businessConfig);
          const lookupLanguage = getConversationLanguage(chatId, textMessage || "");
          rememberLookupResultForConversation(chatId, adapterRes, lookupLanguage, "messenger", senderId, businessConfig);
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            lookupLanguage
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === "rescheduleAppointment" && args) {
          const routed = await routeRescheduleToolCallThroughUnified({
            args,
            sessionId: chatId,
            platformName: "messenger",
            platformLogName: "Messenger",
            recipientUserId: senderId,
            history,
            businessConfig,
            send: (reply) => sendMessengerMessage(senderId, reply, businessConfig),
            postProcessPlatform: platform
          });
          return {
            TERMINATE_EARLY: true,
            replyMessage: routed.replyMessage || "",
            responseAlreadySent: routed.responseAlreadySent
          };
        } else if (call.function.name === "insertAppointment" && args) {
          console.warn("[BookingFlow]", {
            platform: "messenger",
            businessScopePresent: Boolean(getBusinessIdFromConfig(businessConfig)),
            operation: "booking_persistence",
            stateType: "gemini_insert",
            language: getConversationLanguage(chatId, textMessage || ""),
            finalHandledPath: "blocked_non_authoritative_insert"
          });
          return {
            TERMINATE_EARLY: true,
            replyMessage: getErrorMessageByLanguage(
              getConversationLanguage(chatId, textMessage || "")
            )
          };
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
        if (earlyTerm.responseAlreadySent) return;
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

    const textResponse = guardCustomerFacingReply(
      chatId,
      String(chatResponse.text || "").trim() ||
        getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || "")),
      getConversationLanguage(chatId, textMessage || "")
    );
    if (!String(chatResponse.text || "").trim()) {
      console.error("[AIEmptyResponse] Messenger returned no text after tool processing.", {
        businessScopePresent: Boolean(getBusinessIdFromConfig(businessConfig)),
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
Reply in the active conversation language injected by the server.
The server preserves that language across the active flow. Short replies, numbers, names,
phone numbers, dates, times, and confirmations do not change it.

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
If the customer mixes languages, keep the active conversation language. Change only when
the server injects a new active language after a clear meaningful request or explicit language switch.

Never say "I can only speak Swedish" or "I only communicate in Swedish".
Never refuse a supported language.
Keep the same warm,friendly,human tone, professional receptionist tone in every language.
`;

async function processInstagramUpdate(webhook_event: any, config: any, platform: string = "instagram-webhook") {
  if (webhook_event?.message?.is_echo) return;
  const messageId = String(webhook_event?.message?.mid || "").trim();
  const tenantScope = String(webhook_event?.recipient?.id || "").trim();
  const cancellationTurn = Boolean(
    webhook_event?.sender?.id &&
    getCancellationContext(`ig_${webhook_event.sender.id}`)
  );
  if (!messageId || !tenantScope) {
    console.warn("[Idempotency] Instagram message refused: exact message id or tenant scope is missing.");
    return;
  }
  if (cancellationTurn) {
    logInstagramCancellationStage({
      stage: "inbound_claim",
      businessScopePresent: Boolean(getBusinessIdFromConfig(config)),
      result: "requested"
    });
  }
  await runWithInboundMessageClaim({
    tenantScope,
    businessId: String(getBusinessIdFromConfig(config) || ""),
    platform: "instagram",
    messageId,
    handler: async () => {
      if (cancellationTurn) {
        logInstagramCancellationStage({
          stage: "inbound_claim",
          businessScopePresent: Boolean(getBusinessIdFromConfig(config)),
          result: "acquired"
        });
      }
      await processInstagramUpdateClaimed(webhook_event, config, platform);
    }
  });
}

async function processInstagramUpdateClaimed(webhook_event: any, config: any, platform: string = "instagram-webhook") {
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
  let instagramBusinessScopeVerified = !supabase && Boolean(
    getBusinessIdFromConfig(businessConfig) &&
    String(businessConfig?.instagramAccountId || businessConfig?.instagram_account_id || "") === String(recipientId)
  );

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
        instagramBusinessScopeVerified = Boolean(data.id);
        // Normalize the full database row so Instagram receives exactly the same
        // cancellation policy and business settings as Messenger, WhatsApp and Telegram.
        businessConfig = {
          ...businessConfig,
          ...normalizeBusinessConfig(data),
          instagramAccessToken: cleanInstagramToken(data.instagram_access_token),
          instagramToken: cleanInstagramToken(data.instagram_access_token),
          instagramAccountId: data.instagram_account_id,
          calendarProvider: 'google'
        };
        console.log(
          `[InstagramConfig] business=${data.business_name} (${data.id}), ` +
          `allowCancellation=${businessConfig.allowCancellation}, ` +
          `deadlineMinutes=${businessConfig.cancellationDeadlineMinutes}`
        );
      } else {
        console.error('No business found for Instagram recipient id:', recipientId);
      }
    }
  } catch (tenantErr) {
    console.error('Instagram tenant config injection failed:', tenantErr);
  }

  if (!instagramBusinessScopeVerified) {
    clearAppointmentConversationState(chatId);
    console.error(`[InstagramConfig] Refusing unscoped message for recipient id=${recipientId}`);
    return;
  }

  resetSessionIfBusinessConfigChanged(chatId, businessConfig);
  userLanguage = getConversationLanguage(chatId, textMessage || "");

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
        const voiceTranscript = await transcribeVoiceMessageForFlow(userMessageContent);
        if (voiceTranscript) {
          userLanguage = getConversationLanguage(chatId, voiceTranscript);
          userMessageContent = voiceTranscript;
          userMessageForLog = voiceTranscript;
          const unifiedHandled = await handleUnifiedBookingEngine({
            sessionId: chatId,
            platformName: "instagram",
            platformLogName: "Instagram",
            recipientUserId: senderId,
            text: voiceTranscript,
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
      } catch (voiceErr) {
        console.error('Instagram voice download failed:', voiceErr);
        await sendInstagramMessage(
          senderId,
          userLanguage === "fa"
            ? "ببخشید، الان نتونستم پیام صوتی رو بشنوم. لطفاً پیام‌تون رو بنویسید."
            : userLanguage === "sv"
              ? "Ursäkta, jag kunde inte lyssna på röstmeddelandet just nu. Kan du skriva ditt meddelande istället?"
              : userLanguage === "de"
                ? "Entschuldigung, ich konnte die Sprachnachricht gerade nicht anhören. Bitte schreiben Sie Ihre Nachricht."
                : userLanguage === "es"
                  ? "Lo siento, no pude escuchar el mensaje de voz. ¿Puedes escribir tu mensaje?"
                  : userLanguage === "ar"
                    ? "عذرًا، لم أتمكن من سماع الرسالة الصوتية الآن. يرجى كتابة رسالتك."
                    : "Sorry, I couldn’t listen to the voice message just now. Please type your message instead.",
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
If the requested service is Consultation/Konsultation/مشاوره, its duration is fixed at 30 minutes. Never ask the customer how long it should take.
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. Short replies, numbers, names, phone numbers, dates, times, and confirmations do not change it.
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
        "\nVoice specific instructions: The message was transcribed before routing. Reply in the server's active conversation language and do not switch for a short spoken reply. Keep the response natural, short, and suitable for voice playback.";
    }

    let chatResponse = await generateContentWithFallback(null, {
      messages,
      systemInstruction: finalSystemInstruction,
      tools: calendarTools,
      model: 'gemini-2.5-flash'
    });

    let maxTurns = 3;
    let instagramRescheduleReplyAlreadySent = false;
    while (chatResponse.functionCalls && chatResponse.functionCalls.length > 0 && maxTurns > 0) {
      maxTurns--;
      const authoritativeFunctionCalls = selectAuthoritativeGeminiFunctionCalls(
        chatResponse.functionCalls,
        chatId
      );
      messages.push({ role: 'assistant', content: chatResponse.text || null, tool_calls: authoritativeFunctionCalls });

      const adapter = getCalendarAdapter(businessConfig);
      const functionResponsesParts = await Promise.all(authoritativeFunctionCalls.map(async (call: any) => {
        let adapterRes;
        const args = JSON.parse(call.function.arguments);

        if (call.function.name === 'checkSlots' && args) {
          const requestedTime = args.requestedTime || inferRequestedTimeFromText(textMessage || "");
          const service = normalizeBookingService(
            args.service || inferServiceFromRecentContext(textMessage || "", history),
            getDefaultBookingServiceForBusiness(businessConfig) || "Bokning"
          );
          const durationMinutes =
            getDefaultBookingDurationForService(service) ||
            Number(args.durationMinutes || inferBookingDurationFromContext(textMessage || "", history));
          const owner: BookingSlotOwner = {
            businessId: String(getBusinessIdFromConfig(businessConfig) || ""),
            platform: "instagram",
            userId: normalizePlatformUserId("instagram", senderId),
            sessionId: chatId
          };
          const offers = await createCanonicalOfferedSlots({
            adapter,
            owner,
            businessConfig,
            startDate: args.startDate,
            endDate: args.endDate || args.startDate,
            service,
            durationMinutes,
            requestedTime
          });
          const exactSlot = requestedTime
            ? selectOwnedOfferedSlot(requestedTime, {
                offeredSlots: offers.displaySlots,
                ownedOfferedSlots: offers.ownedSlots
              })
            : null;
          if (offers.ownedSlots.length > 0) {
            await savePendingBooking(chatId, "instagram", {
              businessConfig,
              platform: "instagram",
              userId: senderId,
              service,
              selectedDate: args.startDate,
              offeredSlots: offers.displaySlots,
              ownedOfferedSlots: offers.ownedSlots,
              dateTime: exactSlot?.start || null,
              selectedSlotEnd: exactSlot?.end || null,
              durationMinutes,
              language: getConversationLanguage(chatId, textMessage || ""),
              operation: "new_booking",
              status: exactSlot ? "awaiting_confirmation" : "awaiting_time_selection"
            });
          }
          return {
            TERMINATE_EARLY: true,
            replyMessage: formatSwedishTimeSlots(
              offers.displaySlots,
              requestedTime,
              getConversationLanguage(chatId, textMessage || "")
            )
          };
        } else if (call.function.name === 'findCustomerAppointments' && args) {
          adapterRes = await findCustomerAppointments(adapter, { ...args, lookupMode: args.lookupMode || detectAppointmentLookupMode(textMessage), lookupText: textMessage, lookupPath: "instagram_gemini_tool" }, senderId, 'instagram', businessConfig);
          const lookupLanguage = getConversationLanguage(chatId, textMessage || '');
          rememberLookupResultForConversation(chatId, adapterRes, lookupLanguage, "instagram", senderId, businessConfig);
          const replyMessage = formatAppointmentLookupReply(
            adapterRes,
            lookupLanguage
          );
          return { TERMINATE_EARLY: true, replyMessage };
        } else if (call.function.name === 'rescheduleAppointment' && args) {
          const routed = await routeRescheduleToolCallThroughUnified({
            args,
            sessionId: chatId,
            platformName: "instagram",
            platformLogName: "Instagram",
            recipientUserId: senderId,
            history,
            businessConfig,
            send: (reply) => sendInstagramMessage(
              senderId,
              reply,
              getBusinessInstagramToken(businessConfig)
            ),
            postProcessPlatform: platform
          });
          instagramRescheduleReplyAlreadySent = Boolean(routed.responseAlreadySent);
          return {
            TERMINATE_EARLY: true,
            replyMessage: routed.replyMessage || "",
            responseAlreadySent: routed.responseAlreadySent
          };
        } else if (call.function.name === 'insertAppointment' && args) {
          console.warn("[BookingFlow]", {
            platform: "instagram",
            businessScopePresent: Boolean(getBusinessIdFromConfig(businessConfig)),
            operation: "booking_persistence",
            stateType: "gemini_insert",
            language: getConversationLanguage(chatId, textMessage || ""),
            finalHandledPath: "blocked_non_authoritative_insert"
          });
          return {
            TERMINATE_EARLY: true,
            replyMessage: getErrorMessageByLanguage(
              getConversationLanguage(chatId, textMessage || "")
            )
          };
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
        if (earlyTerm.responseAlreadySent || instagramRescheduleReplyAlreadySent) return;
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

    const textResponse = guardCustomerFacingReply(
      chatId,
      String(chatResponse.text || "").trim() ||
        getErrorMessageByLanguage(getConversationLanguage(chatId, textMessage || "")),
      getConversationLanguage(chatId, textMessage || "")
    );
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
      `${textResponse}\n\n${
        userLanguage === "fa"
          ? "🎧 فایل صوتی:"
          : userLanguage === "sv"
            ? "🎧 Lyssna här:"
            : userLanguage === "de"
              ? "🎧 Anhören:"
              : userLanguage === "es"
                ? "🎧 Escuchar:"
                : userLanguage === "ar"
                  ? "🎧 استمع هنا:"
                  : "🎧 Listen here:"
      } ${voiceReply.url}`,
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

  await knowledgeService.initialize();

  app.get('/knowledge', async (_req, res) => {
    try {
      const sources = await knowledgeService.list();
      return res.json({ sources });
    } catch (error) {
      console.error('Knowledge list failed:', error);
      return res.status(500).json({ error: 'Unable to list knowledge sources.' });
    }
  });

  app.post('/knowledge', async (req, res) => {
    try {
      const type = typeof req.body?.type === 'string' ? req.body.type.trim().toLowerCase() : req.body?.type;
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const status = req.body?.status ?? 'pending';
      const metadata = req.body?.metadata ?? {};

      if (!isKnowledgeSourceType(type)) {
        return res.status(400).json({ error: 'Knowledge source type must be faq, pdf, website, or text.' });
      }
      if (!title) {
        return res.status(400).json({ error: 'Knowledge source title is required.' });
      }
      if (!isKnowledgeSourceStatus(status)) {
        return res.status(400).json({ error: 'Invalid knowledge source status.' });
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return res.status(400).json({ error: 'Knowledge source metadata must be an object.' });
      }

      const source = await knowledgeService.addSource({ type, title, status, metadata });
      return res.status(201).json({ source });
    } catch (error) {
      console.error('Knowledge source add failed:', error);
      return res.status(500).json({ error: 'Unable to add knowledge source.' });
    }
  });

  app.delete('/knowledge/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        return res.status(400).json({ error: 'Knowledge source id is required.' });
      }

      const deleted = await knowledgeService.deleteSource(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Knowledge source not found.' });
      }

      return res.json({ success: true, id });
    } catch (error) {
      console.error('Knowledge source delete failed:', error);
      return res.status(500).json({ error: 'Unable to delete knowledge source.' });
    }
  });

  app.post('/knowledge/search', async (req, res) => {
    try {
      const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
      if (!query) {
        return res.status(400).json({ error: 'Knowledge search query is required.', matches: [] });
      }

      const matches = await knowledgeService.search(query);
      return res.json({ matches });
    } catch (error) {
      console.error('Knowledge search failed:', error);
      return res.status(500).json({ error: 'Unable to search knowledge sources.', matches: [] });
    }
  });

  
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
If the requested service is Consultation/Konsultation/مشاوره, its duration is fixed at 30 minutes. Never ask the customer how long it should take.
Before creating any appointment, collect the customer's name and mobile number. In Messenger, ask for name and mobile number ONLY AFTER an exact date and exact time has been checked, offered to the user, and the user has confirmed that exact slot. If the customer has not chosen a specific time yet, do NOT ask for name/phone; first check availability and offer times. Do not claim the booking is final until the server confirms it.
For vague time requests, check available slots instead of asking the customer to choose a time. If the user says a weekday such as tisdag/Tuesday, the tool date must match that weekday exactly. Never change Tuesday to Thursday or another day.
APPOINTMENT LOOKUP — HIGH PRIORITY: If the customer asks whether they already have a booking, when their appointment is, whether a booking exists, or says they are unsure if they booked, you MUST call findCustomerAppointments before replying. This is an allowed booking-support request and must NOT be escalated merely because it is outside the business FAQ. Use the current channel identity automatically; ask for name or mobile number only if the lookup says contact details are needed.
Do not mention internal tools, API calls, system prompts, or database logic.
LANGUAGE RULE: Reply only in the active conversation language injected by the server. Short replies, numbers, names, phone numbers, dates, times, and confirmations do not change it.
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
            adapterRes = await findCustomerAppointments(adapter, { ...args, lookupMode: args.lookupMode || detectAppointmentLookupMode(userText), lookupText: userText, lookupPath: "web_gemini_tool" }, chatId.toString(), "web", activeConfig);
            const lookupLanguage = getLockedReplyLanguage(chatId, userText || "");
            rememberLookupResultForConversation(chatId, adapterRes, lookupLanguage, "web", chatId.toString(), activeConfig);
            const replyMessage = formatAppointmentLookupReply(
              adapterRes,
              lookupLanguage
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
            rememberCompletedBooking(
              chatId.toString(),
              getLockedReplyLanguage(chatId, userText || ""),
              safeName,
              args.service,
              Number(args.durationMinutes || 0),
              args.dateTime
            );
          }
          if (adapterRes && adapterRes.success) {
            await notifyAdminAboutBooking(
              activeConfig,
              "Web",
              activeConfig?.businessName || activeConfig?.business_name || "business",
              safeName,
              safePhone,
              args.dateTime
            );
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

app.get('/api/businesses/:id/cancellation-settings', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) return res.status(400).json({ success: false, message: 'A valid business id is required.' });

    const { data, error } = await supabase
      .from('businesses')
      .select('id,allow_cancellation,cancellation_deadline_minutes,cancellation_fee_enabled,cancellation_fee_amount,cancellation_fee_currency')
      .eq('id', businessId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Business not found.' });

    return res.json({
      success: true,
      data: {
        allowCancellation: Boolean(data.allow_cancellation),
        cancellationDeadlineMinutes: Math.max(0, Number(data.cancellation_deadline_minutes || 0)),
        cancellationFeeEnabled: Boolean(data.cancellation_fee_enabled),
        cancellationFeeAmount: Math.max(0, Number(data.cancellation_fee_amount || 0)),
        cancellationFeeCurrency: String(data.cancellation_fee_currency || 'SEK'),
      },
    });
  } catch (err: any) {
    console.error('Error loading cancellation settings:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Could not load cancellation settings.' });
  }
});

app.get('/api/businesses/:id/admin-notification-settings', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ success: false, message: 'Supabase is not configured.' });
    const businessId = Number(req.params.id);
    if (!Number.isFinite(businessId)) return res.status(400).json({ success: false, message: 'A valid business id is required.' });

    const { data, error } = await supabase
      .from('businesses')
      .select('id,admin_notification_channel,admin_whatsapp_number,admin_telegram_chat_id')
      .eq('id', businessId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Business not found.' });

    return res.json({
      success: true,
      data: {
        channel: data.admin_notification_channel || 'telegram',
        whatsappNumber: data.admin_whatsapp_number || '',
        telegramChatId: data.admin_telegram_chat_id || '',
      },
    });
  } catch (err: any) {
    console.error('Error loading admin notification settings:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Could not load notification settings.' });
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

    const setNonNegativeNumber = (requestKeys: string[], databaseKey: string) => {
      const requestKey = requestKeys.find((key) => has(key));
      if (!requestKey) return;
      const value = Number(body[requestKey]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${requestKey} must be a non-negative number.`);
      payload[databaseKey] = value;
    };

    // General business settings
    setText(['businessName', 'name'], 'business_name');
    setText(['industry'], 'industry');
    setText(['timezone'], 'timezone');
    setText(['language'], 'language');
    setText(['systemPrompt'], 'custom_system_prompt');

    // Customer cancellation policy
    setBoolean(['allowCancellation', 'allow_cancellation'], 'allow_cancellation');
    setNonNegativeNumber(['cancellationDeadlineMinutes', 'cancellation_deadline_minutes'], 'cancellation_deadline_minutes');
    setBoolean(['cancellationFeeEnabled', 'cancellation_fee_enabled'], 'cancellation_fee_enabled');
    setNonNegativeNumber(['cancellationFeeAmount', 'cancellation_fee_amount'], 'cancellation_fee_amount');
    setText(['cancellationFeeCurrency', 'cancellation_fee_currency'], 'cancellation_fee_currency');

    // Google Calendar
    setText(['calendarId', 'googleCalendarId'], 'google_calendar_id');

    // Admin notifications
    setText(
      ['adminNotificationChannel', 'admin_notification_channel', 'channel'],
      'admin_notification_channel',
    );
    setText(
      ['adminWhatsAppNumber', 'admin_whatsapp_number', 'whatsappNumber'],
      'admin_whatsapp_number',
    );

    // Telegram
    setText(['telegramToken'], 'telegram_bot_token', { secret: true });
    setText(
      ['telegramAdminChatId', 'adminTelegramChatId', 'admin_telegram_chat_id', 'telegramChatId'],
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
