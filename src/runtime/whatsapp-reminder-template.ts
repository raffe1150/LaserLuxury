// Narrow appointment-only contract. Configuration selects existing Meta assets;
// it never asserts approval, creates templates, or supplies generated prose.
type Fact = "customer_name" | "service" | "date" | "time" | "business_name";
type TemplateMapping = {
  business_id: string; waba_id: string; phone_number_id: string;
  reminder_type: "24h" | "2h"; booking_language: string;
  template_id: string; name: string; language_code: string; body_parameters: Fact[];
};
type Result = { sent: boolean; category: "accepted" | "provider_rejected" | "whatsapp_template_required"; reason?: string };
const facts = new Set<Fact>(["customer_name", "service", "date", "time", "business_name"]);

export async function sendWhatsAppAppointmentTemplate(input: {
  configuration: unknown; businessId: string; wabaId: string; phoneNumberId: string; token: string;
  recipient: string; reminderType: "24h" | "2h"; language: string | null;
  customerName: string; service: string; businessName: string; startTime: string; timezone: string;
}): Promise<Result> {
  const blocked = (reason: string): Result => ({ sent: false, category: "whatsapp_template_required", reason });
  if (input.configuration == null || (Array.isArray(input.configuration) && !input.configuration.length)) {
    return blocked("whatsapp_template_missing");
  }
  if (!Array.isArray(input.configuration)) return blocked("whatsapp_template_misconfigured");
  if (!input.language) return blocked("whatsapp_template_language_missing");
  const mappings = input.configuration.filter(entry => entry?.reminder_type === input.reminderType);
  if (!mappings.length) return blocked("whatsapp_template_missing");
  const candidates = mappings.filter(entry => entry?.booking_language === input.language);
  if (!candidates.length) return blocked("whatsapp_template_language_unavailable");
  if (candidates.length !== 1) return blocked("whatsapp_template_misconfigured");
  const mapping: TemplateMapping = candidates[0];
  if (mapping.business_id !== input.businessId || !input.wabaId || mapping.waba_id !== input.wabaId ||
      !input.phoneNumberId || mapping.phone_number_id !== input.phoneNumberId ||
      typeof mapping.template_id !== "string" || !mapping.template_id.trim() ||
      typeof mapping.name !== "string" || !/^[a-z0-9_]+$/u.test(mapping.name) ||
      typeof mapping.language_code !== "string" || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(mapping.language_code) ||
      mapping.language_code.split("_")[0] !== input.language ||
      !Array.isArray(mapping.body_parameters) || !mapping.body_parameters.length ||
      mapping.body_parameters.length > 20 || !mapping.body_parameters.every(key => facts.has(key)) ||
      !["service", "date", "time"].every(key => mapping.body_parameters.includes(key as Fact))) {
    return blocked("whatsapp_template_misconfigured");
  }

  let values: Record<Fact, string>;
  try {
    const start = new Date(input.startTime);
    // Match existing reminder date/time presentation, including Gregorian dates.
    const locales: Record<string, string> = {
      sv: "sv-SE", en: "en-GB", de: "de-DE", es: "es-ES",
      fa: "fa-IR-u-ca-gregory", ar: "ar-SA-u-ca-gregory",
    };
    const locale = locales[input.language];
    values = {
      customer_name: input.customerName, service: input.service, business_name: input.businessName,
      date: start.toLocaleDateString(locale, { timeZone: input.timezone, calendar: "gregory",
        weekday: "long", day: "numeric", month: "long" }),
      time: start.toLocaleTimeString(locale, { timeZone: input.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    };
    if (!Number.isFinite(start.getTime()) || mapping.body_parameters.some(key =>
      typeof values[key] !== "string" || !values[key].trim() || values[key].length > 1024)) {
      return blocked("whatsapp_template_facts_missing");
    }
  } catch { return blocked("whatsapp_template_facts_missing"); }

  const base = `https://graph.facebook.com/v25.0/${encodeURIComponent(input.wabaId)}`;
  const headers = { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" };
  let template: any;
  try {
    // Verify ownership using the current tenant credential, not a local approval
    // boolean. Never follow a provider paging URL to another account/host.
    const phonesResponse = await fetch(`${base}/phone_numbers`, { method: "GET", headers });
    const phones = await phonesResponse.json().catch(() => null);
    if (!phonesResponse.ok || phones?.error || !Array.isArray(phones?.data)) {
      return blocked("whatsapp_template_verification_failed");
    }
    if (!phones.data.some((phone: any) => phone.id === input.phoneNumberId)) {
      return blocked("whatsapp_template_account_mismatch");
    }
    const response = await fetch(`${base}/message_templates?name=${encodeURIComponent(mapping.name)}`, { method: "GET", headers });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error || !Array.isArray(result?.data)) {
      return blocked("whatsapp_template_verification_failed");
    }
    const exact = result.data.filter((entry: any) => entry.id === mapping.template_id &&
      entry.name === mapping.name && entry.language === mapping.language_code);
    if (exact.length !== 1 || exact[0].status !== "APPROVED") return blocked("whatsapp_template_not_approved");
    template = exact[0];
    if (template.category !== "UTILITY") return blocked("whatsapp_template_not_utility");
  } catch { return blocked("whatsapp_template_verification_failed"); }

  // Support only positional BODY text with optional static text header/footer.
  // Dynamic headers/buttons/named parameters require a separate explicit contract.
  const components = template.components;
  const bodies = Array.isArray(components) ? components.filter((part: any) => part?.type === "BODY") : [];
  if (bodies.length !== 1 || typeof bodies[0].text !== "string" ||
      (template.parameter_format != null && template.parameter_format !== "POSITIONAL") ||
      components.some((part: any) => !part || part.type !== "BODY" && !(
        ["HEADER", "FOOTER"].includes(part.type) && typeof part.text === "string" &&
        !part.text.includes("{{") && (part.type !== "HEADER" || part.format === "TEXT")
      ))) return blocked("whatsapp_template_contract_mismatch");
  const placeholders = [...bodies[0].text.matchAll(/\{\{(.*?)\}\}/gu)].map(match => match[1]);
  const keys = [...new Set(placeholders)].sort((a, b) => Number(a) - Number(b));
  if (keys.length !== mapping.body_parameters.length || keys.some((key, index) => key !== String(index + 1))) {
    return blocked("whatsapp_template_contract_mismatch");
  }
  const payload = {
    messaging_product: "whatsapp", recipient_type: "individual", to: input.recipient, type: "template",
    template: { name: mapping.name, language: { code: mapping.language_code }, components: [{
      type: "body", parameters: mapping.body_parameters.map(key => ({ type: "text", text: values[key] })),
    }] },
  };
  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(input.phoneNumberId)}/messages`, {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    // Same strongest synchronous acceptance evidence as proactive text sends.
    const accepted = response.ok && !result?.error && /^wamid\.\S+$/u.test(String(result?.messages?.[0]?.id || "").trim());
    return { sent: accepted, category: accepted ? "accepted" : "provider_rejected" };
  } catch { return { sent: false, category: "provider_rejected" }; }
}
