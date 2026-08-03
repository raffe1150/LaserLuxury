export type BookingContactChannel = 'whatsapp' | 'telegram' | 'instagram' | 'messenger';
export type ContactPhoneSource = 'verified_sender_metadata' | 'explicit_customer_message' | 'stored_validated' | 'missing';

export type ResolvedBookingContact = {
  name: string | null;
  phone: string | null;
  phoneSource: ContactPhoneSource;
  missing: Array<'name' | 'phone'>;
};

export function normalizeContactPhone(phone?: string | null): string | null {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.startsWith('+') ? `+${digits}` : digits;
}

export function isInvalidCustomerNameToken(name?: string | null): boolean {
  const value = String(name || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[!?.،,؛]+/gu, ' ').replace(/\s+/g, ' ');
  if (!value) return true;
  return /^(?:bale|baleh|بله|آره|اره|yes|yes please|yeah|yep|ja|ja tack|nej|no|ok|okay|okej|merci|mersi|مرسی|mamnoon|ممنون|thanks|thank you|tack|sure|absolut|book it|boka den|that works|det blir bra|konsultation|consultation|booking|bokning|laser|bikini|full body|helkropp|today|tomorrow|idag|imorgon|monday|tuesday|wednesday|thursday|friday|saturday|sunday|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|morning|afternoon|evening)$/iu.test(value) ||
    /^(?:kl(?:ockan)?|at|saat|sate|ساعت)?\s*\d{1,2}(?::\d{2})?$/iu.test(value);
}

function validName(name?: string | null): string | null {
  const value = String(name || '').trim();
  return value && !isInvalidCustomerNameToken(value) ? value : null;
}

export function resolveAuthoritativeContact(input: {
  channel: BookingContactChannel;
  storedName?: string | null;
  storedPhone?: string | null;
  storedPhoneSource?: ContactPhoneSource | null;
  currentName?: string | null;
  currentPhone?: string | null;
  senderPhone?: string | null;
}): ResolvedBookingContact {
  const name = validName(input.currentName) || validName(input.storedName);
  const senderPhone = normalizeContactPhone(input.senderPhone);
  const currentPhone = normalizeContactPhone(input.currentPhone);
  const storedPhone = normalizeContactPhone(input.storedPhone);
  let phone: string | null = null;
  let phoneSource: ContactPhoneSource = 'missing';

  if (input.channel === 'whatsapp' && senderPhone) {
    phone = senderPhone;
    phoneSource = 'verified_sender_metadata';
  } else if (currentPhone) {
    phone = currentPhone;
    phoneSource = 'explicit_customer_message';
  } else if (
    storedPhone &&
    (input.channel !== 'whatsapp' || input.storedPhoneSource === 'verified_sender_metadata' || input.storedPhoneSource === 'explicit_customer_message')
  ) {
    phone = storedPhone;
    phoneSource = input.storedPhoneSource || 'stored_validated';
  }

  const missing: Array<'name' | 'phone'> = [];
  if (!name) missing.push('name');
  if (!phone) missing.push('phone');
  return { name, phone, phoneSource, missing };
}
