import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAuthoritativeContact } from './channel-contact';

process.env.NODE_ENV = 'test';
const { priority1hUnifiedEngineTestBoundary: boundary } = await import('../../server');

test('ordinary prose digits never become explicit phone input on any channel', () => {
  for (const text of [
    'The reference is 93414557.', 'The order number is 93414557.', 'I won 0701234567 points today.',
    'AIBB 93414557 whatsapp-de.', 'Mein Name ist Mira Testmann 93414557.',
    'My name is Mira Testmann AIBB 0701234567.',
    'Mein Name ist Mira Testmann AIBB 93414557 whatsapp-de. Übrigens hat heute jemand "hej" zu mir gesagt.',
    'معرّف الاختبار ٩٣٤١٤٥٥٧.', 'شناسه آزمایش ۹۳۴۱۴۵۵۷.',
  ]) {
    const parts = boundary.extractBookingContactParts(text);
    assert.equal(parts.combined, null, text);
    assert.equal(parts.phoneOnly, null, text);
    for (const channel of ['whatsapp', 'telegram', 'messenger', 'instagram'] as const) {
      const contact = resolveAuthoritativeContact({ channel, currentName: parts.nameOnly,
        currentPhone: parts.combined?.phone || parts.phoneOnly, senderPhone: '+46700000001' });
      assert.equal(contact.phone, channel === 'whatsapp' ? '+46700000001' : null, text);
    }
  }
});

test('explicit phone replies and multilingual phone fields still work', () => {
  for (const text of [
    '0701234567', '+46 (70) 123-45-67',
    'My phone number is 0701234567.', 'Telefonnummer: 0701234567.',
    'Meine Handynummer ist 0701234567.', 'Meine Nummer ist 0701234567.',
    'Mitt mobilnummer är 0701234567.', 'Mi teléfono es 0701234567.',
    'رقم هاتفي هو ٠٧٠١٢٣٤٥٦٧.', 'شماره موبایلم ۰۷۰۱۲۳۴۵۶۷ است.',
    'The run is 93414557. My phone is 0701234567.',
  ]) {
    assert.equal(boundary.extractBookingContactParts(text).phoneOnly,
      text.startsWith('+') ? '+46701234567' : '0701234567', text);
  }
  for (const text of ['Mira Testmann, 0701234567.', 'Mira 0701234567']) {
    assert.equal(boundary.extractBookingContactParts(text).combined?.phone, '0701234567', text);
  }
});
