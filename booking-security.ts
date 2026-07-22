export type AppointmentLookupMode = "upcoming" | "today" | "history";

export interface AppointmentIdentity {
  businessId: string;
  platform: string;
  userId: string;
  phone?: string;
}

export interface AppointmentStateOwner {
  sessionId: string;
  businessId: string;
  platform: string;
  userId: string;
  identityKey?: string;
}

export function normalizeSecurityDigits(value?: string): string {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeSecurityPlatform(value?: string): string {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "facebook" || raw === "facebook_messenger" || raw.startsWith("messenger")) return "messenger";
  if (raw.startsWith("instagram")) return "instagram";
  if (raw.startsWith("whatsapp") || raw === "wa") return "whatsapp";
  if (raw.startsWith("telegram")) return "telegram";
  return raw;
}

export function normalizeSecurityUserId(platform: string, value?: string): string {
  const channel = normalizeSecurityPlatform(platform);
  let raw = String(value || "").trim();
  if (!raw) return "";

  const prefixes = [
    `${channel}_`,
    `${channel}-`,
    `${channel}:`,
    channel === "telegram" ? "tg_" : "",
    channel === "whatsapp" ? "wa_" : "",
    channel === "instagram" ? "ig_" : "",
    channel === "messenger" ? "ms_" : "",
  ].filter(Boolean);

  for (const prefix of prefixes) {
    if (raw.toLowerCase().startsWith(prefix)) {
      raw = raw.slice(prefix.length);
      break;
    }
  }

  return channel === "whatsapp" ? normalizeSecurityDigits(raw) : raw.trim();
}

export function isActiveAppointmentStatus(status: unknown): boolean {
  const normalized = String(status || "booked").trim().toLowerCase();
  return normalized !== "cancelled" && normalized !== "canceled" && normalized !== "cancel";
}

export function detectAppointmentLookupMode(text?: string): AppointmentLookupMode {
  const raw = String(text || "").trim().toLowerCase();
  if (/\b(idag|today|heute|hoy)\b/i.test(raw) || /(امروز|اليوم)/u.test(raw)) return "today";
  if (/(?:^|\s)(igår|igar|yesterday|tidigare|förra\s+veckan|last\s+week|hade\s+tid|had\s+an\s+appointment|missat|missed)(?=\s|$)/i.test(raw)) return "history";
  return "upcoming";
}

export function isAppointmentLookupFollowUp(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    /^(?:menar\s+du\s+)?(?:idag|today)[?.!\s]*$/i.test(raw) ||
    /\b(menar\s+du\s+idag|var\s+det\s+idag|gällde\s+det\s+idag|was\s+that\s+today|do\s+you\s+mean\s+today)\b/i.test(raw) ||
    /\b(vilken\s+tid|vad\s+var\s+tiden|what\s+time|när\s+var\s+det|when\s+was\s+it)\b/i.test(raw)
  );
}

export function isDirectAppointmentLookupPhrase(text?: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;
  return (
    /\b(hade\s+jag|har\s+jag\s+haft).*(tid|bokning|bokat)\b/i.test(raw) ||
    /\b(vilken\s+tid\s+hade\s+jag|vad\s+var\s+min\s+bokade\s+tid|när\s+hade\s+jag\s+tid)\b/i.test(raw) ||
    /\b(what\s+time\s+did\s+i\s+(?:book|have)|when\s+was\s+my\s+(?:appointment|booking))\b/i.test(raw)
  );
}

export function isDirectReschedulePhrase(text?: string): boolean {
  const raw = String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.,!?;:()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return false;
  return /(?:^|\s)byt(?:\s+(?:min\s+tid|tiden|tid|bokningen))?(?=\s|$)/i.test(raw);
}

export function appointmentStartMatchesMode(
  startMs: number,
  mode: AppointmentLookupMode,
  nowMs: number,
  rangeStartMs: number,
  rangeEndMs: number
): boolean {
  if (!Number.isFinite(startMs)) return false;
  if (startMs < rangeStartMs || startMs > rangeEndMs) return false;
  if (mode === "upcoming") return startMs >= nowMs;
  if (mode === "history") return startMs <= nowMs;
  return true;
}

export function selectSecureAppointmentRows(
  rows: any[],
  identity: AppointmentIdentity,
  mode: AppointmentLookupMode,
  nowMs: number,
  rangeStartMs: number,
  rangeEndMs: number
): { rows: any[]; identityKey: string; matchedBy: "channel" | "phone" | "none" } {
  const businessId = String(identity.businessId || "").trim();
  const platform = normalizeSecurityPlatform(identity.platform);
  const userId = normalizeSecurityUserId(platform, identity.userId);
  const suppliedPhone = normalizeSecurityDigits(identity.phone);
  const channelPhone = platform === "whatsapp" ? normalizeSecurityDigits(userId) : "";

  if (!businessId || !platform || !userId) {
    return { rows: [], identityKey: "", matchedBy: "none" };
  }

  const eligibleRows = (Array.isArray(rows) ? rows : []).filter((row: any) => {
    if (String(row?.business_id || "").trim() !== businessId) return false;
    if (!isActiveAppointmentStatus(row?.status)) return false;
    const startMs = new Date(row?.start_time || "").getTime();
    return appointmentStartMatchesMode(startMs, mode, nowMs, rangeStartMs, rangeEndMs);
  });

  const channelRows = eligibleRows.filter((row: any) => {
    const rowPlatform = normalizeSecurityPlatform(row?.platform);
    const rowUserId = normalizeSecurityUserId(rowPlatform, row?.user_id);
    return rowPlatform === platform && rowUserId === userId;
  });

  if (channelRows.length > 0) {
    return {
      rows: channelRows,
      identityKey: `channel:${platform}:${userId}`,
      matchedBy: "channel"
    };
  }

  const phone = suppliedPhone.length >= 7 ? suppliedPhone : channelPhone;
  if (phone.length >= 7) {
    const phoneRows = eligibleRows.filter((row: any) =>
      normalizeSecurityDigits(row?.phone_number) === phone
    );
    if (phoneRows.length > 0) {
      return { rows: phoneRows, identityKey: `phone:${phone}`, matchedBy: "phone" };
    }
  }

  return { rows: [], identityKey: `channel:${platform}:${userId}`, matchedBy: "none" };
}

function eventSearchText(event: any): string {
  const attendees = Array.isArray(event?.attendees)
    ? event.attendees.map((item: any) => `${item?.displayName || ""} ${item?.email || ""}`).join(" ")
    : "";
  return `${event?.summary || event?.title || ""} ${event?.description || ""} ${event?.location || ""} ${attendees}`;
}

function numericTokens(value: string): string[] {
  return (value.match(/\+?\d[\d\s()\-]{4,}\d/g) || [])
    .map(normalizeSecurityDigits)
    .filter(Boolean);
}

export function selectSecureCalendarEvents(
  events: any[],
  identity: Omit<AppointmentIdentity, "businessId">,
  mode: AppointmentLookupMode,
  nowMs: number,
  rangeStartMs: number,
  rangeEndMs: number,
  getStartIso: (event: any) => string
): { events: any[]; identityKey: string; matchedBy: "channel" | "phone" | "none" } {
  const platform = normalizeSecurityPlatform(identity.platform);
  const userId = normalizeSecurityUserId(platform, identity.userId);
  const suppliedPhone = normalizeSecurityDigits(identity.phone);
  const channelPhone = platform === "whatsapp" ? normalizeSecurityDigits(userId) : "";
  const eligibleEvents = (Array.isArray(events) ? events : []).filter((event: any) => {
    if (!isActiveAppointmentStatus(event?.status)) return false;
    const startMs = new Date(getStartIso(event)).getTime();
    return appointmentStartMatchesMode(startMs, mode, nowMs, rangeStartMs, rangeEndMs);
  });

  const channelEvents = userId
    ? eligibleEvents.filter((event: any) => numericTokens(eventSearchText(event)).includes(normalizeSecurityDigits(userId)) ||
      eventSearchText(event).split(/[^\p{L}\p{N}]+/u).includes(userId))
    : [];

  if (channelEvents.length > 0) {
    return {
      events: channelEvents,
      identityKey: `channel:${platform}:${userId}`,
      matchedBy: "channel"
    };
  }

  const phone = suppliedPhone.length >= 7 ? suppliedPhone : channelPhone;
  if (phone.length >= 7) {
    const phoneEvents = eligibleEvents.filter((event: any) =>
      numericTokens(eventSearchText(event)).includes(phone)
    );
    if (phoneEvents.length > 0) {
      return { events: phoneEvents, identityKey: `phone:${phone}`, matchedBy: "phone" };
    }
  }

  return { events: [], identityKey: userId ? `channel:${platform}:${userId}` : "", matchedBy: "none" };
}

export function appointmentStateOwnerMatches(
  stored: AppointmentStateOwner | undefined,
  current: AppointmentStateOwner
): boolean {
  if (!stored) return false;
  return stored.sessionId === current.sessionId &&
    stored.businessId === current.businessId &&
    normalizeSecurityPlatform(stored.platform) === normalizeSecurityPlatform(current.platform) &&
    normalizeSecurityUserId(stored.platform, stored.userId) === normalizeSecurityUserId(current.platform, current.userId);
}

export function appointmentIdentityKeyConflicts(identityKey: string | undefined, suppliedPhone?: string): boolean {
  const storedPhone = String(identityKey || "").startsWith("phone:")
    ? normalizeSecurityDigits(String(identityKey).slice("phone:".length))
    : "";
  const currentPhone = normalizeSecurityDigits(suppliedPhone);
  return Boolean(storedPhone && currentPhone.length >= 7 && storedPhone !== currentPhone);
}
