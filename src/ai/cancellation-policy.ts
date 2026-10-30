import { AsyncLocalStorage } from 'node:async_hooks';
import {withoutExplicitParkingFeeTerms} from './information-request-contract';

/** Dashboard cancellation settings describe automatic cancellation and fees,
 * not a hard prohibition on cancelling later. No document can grant a mutation. */
export type CancellationPolicy = Readonly<{
  allowCancellation: boolean; deadlineMinutes: number; feeEnabled: boolean;
  feeAmount: number; currency: string;
}>;

/** Keep cancellation/unspecified-fee handling conservative, but a fee explicitly
 * attached to parking is not itself cancellation evidence. This projection is
 * classification-only: the original question and every amount remain intact. */
export function isCancellationInformationRequested(text:string):boolean {
 if(/cancel|avbok|stornier|absag|لغو|إلغاء|الغاء/iu.test(text))return true;
 const otherFees=withoutExplicitParkingFeeTerms(text);
 return /\bfees?\b|avgift|gebühr|cargo|هزینه|رسوم/iu.test(otherFees);
}

const pick = (config: any, camel: string, snake: string) =>
  config?.[camel] !== undefined ? config[camel] : config?.[snake];
export function hasCancellationSettings(config: any): boolean {
  return ['allowCancellation', 'allow_cancellation', 'cancellationDeadlineMinutes', 'cancellation_deadline_minutes',
    'cancellationFeeEnabled', 'cancellation_fee_enabled', 'cancellationFeeAmount', 'cancellation_fee_amount']
    .some(key => config?.[key] !== undefined);
}

export function readCancellationPolicy(config: any): CancellationPolicy | null {
  const rawAllowed = pick(config, 'allowCancellation', 'allow_cancellation');
  const rawEnabled = pick(config, 'cancellationFeeEnabled', 'cancellation_fee_enabled');
  const allowed = rawAllowed === undefined ? false : rawAllowed;
  const enabled = rawEnabled === undefined ? false : rawEnabled;
  const rawDeadline = pick(config, 'cancellationDeadlineMinutes', 'cancellation_deadline_minutes');
  const rawAmount = pick(config, 'cancellationFeeAmount', 'cancellation_fee_amount');
  const rawCurrency = pick(config, 'cancellationFeeCurrency', 'cancellation_fee_currency');
  const deadlineMinutes = rawDeadline === undefined ? 0 : Number(rawDeadline);
  const feeAmount = rawAmount === undefined ? 0 : Number(rawAmount);
  const currency = String(rawCurrency ?? 'SEK').trim().toUpperCase();
  if (typeof allowed !== 'boolean' || typeof enabled !== 'boolean' || rawDeadline === null || rawAmount === null ||
    !Number.isSafeInteger(deadlineMinutes) || deadlineMinutes < 0 || !Number.isFinite(feeAmount) || feeAmount < 0 ||
    (enabled && (feeAmount <= 0 || rawDeadline === undefined || typeof rawCurrency !== 'string')) ||
    !/^[A-Z]{3}$/u.test(currency)) return null;
  return Object.freeze({ allowCancellation: allowed, deadlineMinutes, feeEnabled: enabled, feeAmount, currency });
}

export function cancellationPolicyFingerprint(config: any): string | null {
  const policy = readCancellationPolicy(config);
  return policy ? JSON.stringify([hasCancellationSettings(config), policy,
    config?.timezone || 'Europe/Stockholm', config?.googleCalendarId ?? config?.google_calendar_id ?? '']) : null;
}

export function cancellationGroundingConfig(config: any) {
  if (!hasCancellationSettings(config)) return undefined;
  const policy = readCancellationPolicy(config);
  if (!policy) return { available: false };
  return {
    available: true, automaticCancellationEnabled: policy.allowCancellation,
    freeCancellationDeadlineMinutes: policy.deadlineMinutes,
    lateFeeEnabled: policy.feeEnabled, lateFeeAmount: policy.feeAmount, lateFeeCurrency: policy.currency,
    hardCancellationCutoffMinutes: null,
    meaning: 'The window only determines an optional late-cancellation fee. It is not a hard cancellation cutoff. Fees are not collected by this chat.',
  };
}

export type CancellationSubject = Readonly<{
  appointmentId: string; eventId: string; businessId: string; platform: string; userId: string;
  start: string; end: string; service: string; identity: string;
  calendarEtag?: string;
}>;
export function validCancellationEtag(value: unknown): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e]{1,512}"$/u.test(value);
}
export function cancellationUncertainReply(language: string): string {
  const replies: Record<string, string> = {
    en: 'I cannot verify the final cancellation status. Please contact the business for review; do not assume the appointment is cancelled.',
    sv: 'Jag kan inte verifiera avbokningens slutliga status. Kontakta verksamheten för kontroll; utgå inte från att tiden är avbokad.',
    de: 'Ich kann den endgültigen Stornierungsstatus nicht überprüfen. Bitte kontaktieren Sie das Unternehmen zur Prüfung; gehen Sie nicht davon aus, dass der Termin storniert ist.',
    es: 'No puedo verificar el estado final de la cancelación. Contacta con el negocio para que lo revise; no des por hecho que la cita está cancelada.',
    fa: 'نمی‌توانم وضعیت نهایی لغو را تأیید کنم. لطفاً برای بررسی با مجموعه تماس بگیرید؛ فرض نکنید که نوبت لغو شده است.',
    ar: 'لا أستطيع التحقق من الحالة النهائية للإلغاء. يرجى التواصل مع المنشأة للمراجعة؛ لا تفترض أن الموعد قد أُلغي.',
  };
  return replies[language] || replies.en;
}
export type CancellationConfirmation = {
  token: string; subject: CancellationSubject; policyFingerprint: string; language: string;
  feeApplies: boolean; feeAmount: number; currency: string; reply: string;
  deliveredAt: number | null; consumed: boolean;
};
const confirmationDelivery = new AsyncLocalStorage<CancellationConfirmation>();
export function withCancellationDelivery<T>(receipt: CancellationConfirmation, send: () => Promise<T>): Promise<T> {
  return confirmationDelivery.run(receipt, send);
}
export function pendingCancellationDelivery(): CancellationConfirmation | null {
  const receipt = confirmationDelivery.getStore();
  return receipt && receipt.deliveredAt === null ? receipt : null;
}
export function cancellationDeliveryTextComplete(text: string): boolean {
  const receipt = pendingCancellationDelivery();
  // The shared sender can prepend its server-generated receptionist intro.
  return !receipt || text === receipt.reply || text.endsWith(' ' + receipt.reply);
}
export function cancellationProviderAcknowledged(platform: 'telegram' | 'instagram' | 'messenger', payload: any, recipient: string): boolean {
  if (platform === 'telegram') return payload?.ok === true && Number.isSafeInteger(payload?.result?.message_id) &&
    String(payload?.result?.chat?.id ?? '') === recipient;
  return !payload?.error && typeof payload?.message_id === 'string' && Boolean(payload.message_id.trim()) && payload?.recipient_id === recipient;
}
export const CANCELLATION_CONSENT_TTL_MS = 15 * 60_000;
export function cancellationFee(policy: CancellationPolicy, start: string, now = Date.now()): boolean | null {
  const ms = new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= now) return null;
  return policy.deadlineMinutes > 0 && (ms - now) / 60_000 < policy.deadlineMinutes && policy.feeEnabled && policy.feeAmount > 0;
}
export function cancellationConfirmationCurrent(receipt: CancellationConfirmation | undefined,
  subject: CancellationSubject, fingerprint: string, feeApplies: boolean, now = Date.now()): boolean {
  return Boolean(receipt && !receipt.consumed && receipt.deliveredAt !== null &&
    receipt.deliveredAt <= now && now - receipt.deliveredAt < CANCELLATION_CONSENT_TTL_MS &&
    receipt.policyFingerprint === fingerprint && receipt.feeApplies === feeApplies &&
    JSON.stringify(receipt.subject) === JSON.stringify(subject));
}
/** Provider timestamps must be after the acknowledged confirmation. Coarse
 * timestamps in its delivery second are ambiguous and require reconfirmation. */
export function cancellationConsentAfter(receipt: CancellationConfirmation, occurredAt: number, precisionMs = 1, now = Date.now()): boolean {
  return receipt.deliveredAt !== null && Number.isFinite(occurredAt) &&
    (precisionMs === 1 || precisionMs === 1000) && occurredAt <= now + precisionMs &&
    occurredAt >= (Math.floor(receipt.deliveredAt / precisionMs) + 1) * precisionMs;
}
export function cancellationMessageTime(value: unknown, unit: 1 | 1000, now = Date.now()): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value), ms = number * unit;
  if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(ms) || ms > now + unit) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

const locales: Record<string, string> = { en: 'en-GB', sv: 'sv-SE', de: 'de-DE', es: 'es-ES', fa: 'fa-IR', ar: 'ar' };
export function renderCancellationConfirmation(subject: CancellationSubject, policy: CancellationPolicy,
  language: string, feeApplies: boolean, timezone = 'Europe/Stockholm'): string | null {
  if (!locales[language] || !subject.appointmentId || !subject.eventId || !subject.businessId ||
    !Number.isFinite(new Date(subject.start).getTime()) || !Number.isFinite(new Date(subject.end).getTime()) ||
    new Date(subject.end).getTime() <= new Date(subject.start).getTime()) return null;
  let date: string, time: string;
  try {
    date = new Date(subject.start).toLocaleDateString(locales[language], { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    time = new Date(subject.start).toLocaleTimeString(locales[language], { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return null; }
  const service = subject.service.replace(/[\r\n]/gu, ' ').trim().slice(0, 120);
  const detail = service ? ` (${service})` : '';
  const fee = `${policy.feeAmount.toLocaleString(locales[language])} ${policy.currency}`;
  const fees: Record<string, string> = {
    en: ` A late-cancellation fee of ${fee} applies under the business policy.`,
    sv: ` En sen avbokningsavgift på ${fee} gäller enligt verksamhetens policy.`,
    de: ` Laut Unternehmensrichtlinie fällt eine Gebühr für die kurzfristige Stornierung von ${fee} an.`,
    es: ` Según la política del negocio, se aplica un cargo por cancelación tardía de ${fee}.`,
    fa: ` طبق قوانین مجموعه، هزینه لغو دیرهنگام ${fee} اعمال می‌شود.`,
    ar: ` وفقًا لسياسة المنشأة، تُطبّق رسوم إلغاء متأخر بقيمة ${fee}.`,
  };
  const prompts: Record<string, string> = {
    en: `Do you want to cancel your appointment${detail} on ${date} at ${time}?${feeApplies ? fees.en : ''} Reply “yes” to confirm.`,
    sv: `Vill du avboka din tid${detail} ${date} kl ${time}?${feeApplies ? fees.sv : ''} Svara “ja” för att bekräfta.`,
    de: `Möchten Sie Ihren Termin${detail} am ${date} um ${time} stornieren?${feeApplies ? fees.de : ''} Antworten Sie zur Bestätigung mit „ja“.`,
    es: `¿Quieres cancelar tu cita${detail} el ${date} a las ${time}?${feeApplies ? fees.es : ''} Responde «sí» para confirmar.`,
    fa: `آیا می‌خواهید نوبت خود${detail} در ${date} ساعت ${time} را لغو کنید؟${feeApplies ? fees.fa : ''} برای تأیید بنویسید «بله».`,
    ar: `هل تريد إلغاء موعدك${detail} يوم ${date} الساعة ${time}؟${feeApplies ? fees.ar : ''} اكتب «نعم» للتأكيد.`,
  };
  return prompts[language];
}

export const CANCELLATION_POLICY_GUIDANCE = `CANCELLATION POLICY AUTHORITY: automaticCancellationEnabled controls cancellation through chat, not whether the business can help manually. freeCancellationDeadlineMinutes is only the free-cancellation/optional late-fee boundary, never a hard cutoff or mandatory advance-notice requirement. When automatic cancellation is enabled, current dashboard policy overrides conflicting Knowledge cancellation/fee prose. Late fees apply only when enabled with a positive amount and inside the configured window; a stored amount alone does not enable a fee. With fees disabled or a zero window, do not invent a 24-hour restriction on free cancellation. hardCancellationCutoffMinutes=null means no hard prohibition has been established by these settings; never infer one from the free window. Preserve this distinction in every claim, source quotation and published answer. Missing or unavailable authoritative settings require uncertainty. Ordinary independent factual verification is still required; matching a number never proves policy meaning.`;
